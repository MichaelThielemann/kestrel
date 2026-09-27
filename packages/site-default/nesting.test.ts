import { describe, expect, it } from "vitest";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { routedSite } from "./__fixtures__/routed.ts";
import { routeWith } from "./routes.ts";
import { DOCS, type DocRow } from "./table.ts";

const MODEL: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, localized: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], localized: true },
        parent: { type: "ref", to: "pages" },
      },
    },
  },
};

const ROUTES = { pages: routeWith({ home: "home", liveWhen: { status: "published" }, parentField: "parent" }) };
const published = { home: "home", fallback: true, filter: { status: "published" } };

async function site(config: { maxCascade?: number; maxDepth?: number } = {}) {
  const routed = await routedSite({ model: MODEL, routes: ROUTES, config });
  const page = async (fields: Record<string, unknown>, en?: Record<string, unknown>): Promise<string> => {
    const id = expectOk(await routed.content.create("pages", { status: "published", title: String(fields.slug), ...fields })).id;
    if (en) expectOk(await routed.content.update("pages", id, { status: "published", title: `${String(fields.slug)} en`, ...en }, { locale: "en" }));
    return id;
  };
  const resolve = async (path: string, rules: Record<string, unknown> = published) => expectOk(await routed.site.resolve("pages", path, { rules }))?.id ?? null;
  const moves = () => routed.emitted.flat().map(({ id, locale, from, to }) => ({ id, locale, from, to }));
  return { ...routed, page, resolve, moves };
}

describe("site/default nested pages: paths", () => {
  it("the same slug saves under two parents and resolves in every locale", async () => {
    const s = await site();
    const ueber = await s.page({ slug: "ueber-uns" }, { slug: "about-us" });
    const projekte = await s.page({ slug: "projekte" }, { slug: "projects" });
    const teamA = await s.page({ slug: "team", parent: ueber }, { slug: "team" });
    const teamB = await s.page({ slug: "team", parent: projekte }, { slug: "team" });
    expect(await s.resolve("ueber-uns/team")).toBe(teamA);
    expect(await s.resolve("projekte/team")).toBe(teamB);
    expect(await s.resolve("en/about-us/team")).toBe(teamA);
    expect(await s.resolve("en/projects/team")).toBe(teamB);
    expect(await s.resolve("ueber-uns/projekte")).toBeNull();
    expect(await s.resolve("team")).toBeNull();
  });

  it("pathOf is the inverse of resolve for depths one to four", async () => {
    const s = await site();
    let parent: string | undefined;
    const paths: string[] = [];
    for (const [i, slug] of ["a", "b", "c", "d"].entries()) {
      parent = await s.page({ slug, ...(parent === undefined ? {} : { parent }) }, { slug: `${slug}-en` });
      paths.push(["a", "b", "c", "d"].slice(0, i + 1).join("/"), `en/${["a", "b", "c", "d"].slice(0, i + 1).map((x) => `${x}-en`).join("/")}`);
    }
    for (const path of paths) {
      const doc = expectOk(await s.site.resolve("pages", path, { rules: published }));
      expect(doc).not.toBeNull();
      expect(s.site.pathOf("pages", doc!, { rules: published })).toBe(`/${path}`);
    }
  });
});

describe("site/default nested pages: parent rules", () => {
  it("rejects a page as its own parent, a two-step cycle and a cycle made by a later save, writing nothing", async () => {
    const s = await site();
    const a = await s.page({ slug: "a" });
    const b = await s.page({ slug: "b", parent: a });
    const self = expectErr(await s.content.update("pages", a, { parent: a }), "VALIDATION");
    expect(self.details).toEqual({ fields: [{ field: "parent", message: `pages/${a} cannot be its own parent` }] });
    const cycle = expectErr(await s.content.update("pages", a, { parent: b }), "VALIDATION");
    expect(cycle.details?.fields).toEqual([{ field: "parent", message: `pages/${b} lies below pages/${a}; that parent would make a cycle` }]);
    const c = await s.page({ slug: "c", parent: b });
    expectErr(await s.content.update("pages", a, { parent: c }), "VALIDATION");
    expect(expectOk(await s.content.get("pages", a))?.parent).toBeNull();
    expect(await s.resolve("a/b/c")).toBe(c);
  });

  it("rejects a parent chain deeper than maxDepth and writes nothing", async () => {
    const s = await site({ maxDepth: 3 });
    const a = await s.page({ slug: "a" });
    const b = await s.page({ slug: "b", parent: a });
    const c = await s.page({ slug: "c", parent: b });
    const error = expectErr(await s.content.create("pages", { slug: "d", title: "D", status: "published", parent: c }), "VALIDATION");
    expect(error.details).toEqual({ fields: [{ field: "parent", message: "the parent chain would be deeper than 3 (maxDepth)" }] });
    expect(await s.resolve("a/b/c/d")).toBeNull();
    expect(expectOk(await s.content.list("pages", {})).total).toBe(3);
  });

  it("rejects a missing parent and the home page as a parent", async () => {
    const s = await site();
    const home = await s.page({ slug: "home" });
    expectErr(await s.content.create("pages", { slug: "x", title: "X", status: "published", parent: "missing" }), "VALIDATION");
    const error = expectErr(await s.content.create("pages", { slug: "x", title: "X", status: "published", parent: home }), "VALIDATION");
    expect(error.details).toEqual({ fields: [{ field: "parent", message: "the home page cannot have subpages" }] });
  });

  it("refuses to delete a page with subpages and names them", async () => {
    const s = await site();
    const parent = await s.page({ slug: "eltern" });
    const child = await s.page({ slug: "kind", parent });
    const error = expectErr(await s.content.remove("pages", parent), "CONFLICT");
    expect(error.message).toContain(`pages/${child}`);
    expect(await s.resolve("eltern")).toBe(parent);
  });
});

describe("site/default nested pages: moving a section", () => {
  it("renaming or re-parenting a parent moves every descendant in every locale", async () => {
    const s = await site();
    const alt = await s.page({ slug: "alt" }, { slug: "old" });
    const kind = await s.page({ slug: "kind", parent: alt }, { slug: "child" });
    const enkel = await s.page({ slug: "enkel", parent: kind }, { slug: "enkel" });
    s.emitted.length = 0;
    expectOk(await s.content.update("pages", alt, { slug: "neu" }));
    expect(s.moves()).toEqual(
      expect.arrayContaining([
        { id: alt, locale: "de", from: "/alt", to: "/neu" },
        { id: kind, locale: "de", from: "/alt/kind", to: "/neu/kind" },
        { id: enkel, locale: "de", from: "/alt/kind/enkel", to: "/neu/kind/enkel" },
      ]),
    );
    expect(s.moves()).toHaveLength(3);
    const ziel = await s.page({ slug: "ziel" }, { slug: "target" });
    s.emitted.length = 0;
    expectOk(await s.content.update("pages", kind, { parent: ziel }));
    expect(s.moves()).toEqual(
      expect.arrayContaining([
        { id: kind, locale: "de", from: "/neu/kind", to: "/ziel/kind" },
        { id: kind, locale: "en", from: "/en/old/child", to: "/en/target/child" },
        { id: enkel, locale: "de", from: "/neu/kind/enkel", to: "/ziel/kind/enkel" },
        { id: enkel, locale: "en", from: "/en/old/child/enkel", to: "/en/target/child/enkel" },
      ]),
    );
    expect(s.moves()).toHaveLength(4);
  });

  it("a descendant colliding with an outsider rejects the parent's save and names both", async () => {
    const s = await site();
    const a = await s.page({ slug: "a" });
    const x = await s.page({ slug: "x", parent: a });
    const b = await s.page({ slug: "b" });
    const outsider = await s.page({ slug: "x", parent: b });
    const error = expectErr(await s.content.update("pages", a, { slug: "b" }), "CONFLICT");
    expect(error.details?.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/b", id: b }), expect.objectContaining({ path: "/b/x", id: outsider, moving: { type: "pages", id: x } })]));
    expect(await s.resolve("a/x")).toBe(x);
  });

  it("rejects a change of more than maxCascade rows with a field error naming the config key, and writes nothing", async () => {
    const s = await site({ maxCascade: 4 });
    const root = await s.page({ slug: "wurzel" });
    await s.page({ slug: "k1", parent: root });
    await s.page({ slug: "k2", parent: root });
    expectOk(await s.content.update("pages", root, { slug: "wurzel-2" }));
    await s.page({ slug: "k3", parent: root });
    const error = expectErr(await s.content.update("pages", root, { slug: "wurzel-3" }), "VALIDATION");
    expect(error.details?.fields).toEqual([{ field: "slug", message: expect.stringContaining("more than the limit of 4 (config key maxCascade") as unknown }]);
    expect(await s.resolve("wurzel-2")).toBe(root);
  });
});

describe("site/default nested pages: independent reachability", () => {
  it("an unpublished parent answers 404 while its children keep their paths, and no child moves", async () => {
    const s = await site();
    const parent = await s.page({ slug: "eltern" }, { slug: "parent" });
    const child = await s.page({ slug: "kind", parent }, { slug: "child" });
    s.emitted.length = 0;
    expectOk(await s.content.update("pages", parent, { status: "draft" }, { locale: "en" }));
    expect(await s.resolve("en/parent")).toBeNull();
    expect(await s.resolve("en/parent/child")).toBe(child);
    expect(s.moves()).toEqual([{ id: parent, locale: "en", from: "/en/parent", to: null }]);
  });

  it("a never-published parent's slug is the only thing of it a published child exposes", async () => {
    const s = await site();
    const parent = expectOk(await s.content.create("pages", { slug: "geheim", title: "Geheimer Titel", status: "draft" })).id;
    const child = await s.page({ slug: "kind", parent });
    expect(await s.resolve("geheim")).toBeNull();
    const doc = expectOk(await s.site.resolve("pages", "geheim/kind", { rules: published }));
    expect(doc?.id).toBe(child);
    expect(JSON.stringify(doc)).not.toContain("Geheimer Titel");
    const linked = expectOk(await s.site.resolveLinks("pages", { id: "l", createdAt: 0, updatedAt: 0, a: `kestrel:pages:${parent}`, b: `kestrel:pages:${child}` }, { locale: "de", rules: published }));
    expect(linked._links).toEqual({ [parent]: { broken: true }, [child]: { path: "/geheim/kind", locale: "de" } });
    expect(expectOk(await s.paths.preview("pages", { id: child, slug: "kind" }))).toMatchObject({ path: "/geheim/kind", exposesParentSlug: { type: "pages", id: parent, label: "Geheimer Titel" } });
  });
});

describe("site/default nested pages: path segments come only from slugs of the same locale", () => {
  it("a page without a slug in a locale is not reachable there, and a rival with a slug of its own takes that path once it is live", async () => {
    const s = await site();
    const parent = await s.page({ slug: "eltern" }, { slug: "parent" });
    const child = await s.page({ slug: "kind", parent });
    expect(await s.resolve("eltern/kind")).toBe(child);
    expect(await s.resolve("en/parent/kind")).toBeNull();
    const rival = await s.page({ slug: "anderes", parent });
    expectOk(await s.content.update("pages", rival, { slug: "kind", title: "Rival", status: "draft" }, { locale: "en" }));
    expect(await s.resolve("en/parent/kind")).toBeNull();
    expectOk(await s.content.update("pages", rival, { status: "published" }, { locale: "en" }));
    expect(await s.resolve("en/parent/kind")).toBe(rival);
  });

  it("refuses to publish a subpage in a locale where a page above it has no slug, naming that page on the parent field", async () => {
    const s = await site();
    const p = expectOk(await s.content.create("pages", { slug: "geheim", title: "Geheimer Titel", status: "draft" })).id;
    const child = await s.page({ slug: "kind", parent: p });
    const error = expectErr(await s.content.update("pages", child, { slug: "kid", title: "Kid", status: "published" }, { locale: "en" }), "VALIDATION");
    expect(error.details?.fields).toEqual([{ field: "parent", message: expect.stringContaining('pages "Geheimer Titel"') as unknown }]);
    expectOk(await s.content.update("pages", child, { slug: "kid", title: "Kid", status: "draft" }, { locale: "en" }));
    expect(s.paths.pathsOf("pages", child, "valid")).toEqual({ de: "/geheim/kind", en: null });
    expectOk(await s.content.update("pages", p, { slug: "secret", title: "Secret", status: "draft" }, { locale: "en" }));
    expectOk(await s.content.update("pages", child, { status: "published" }, { locale: "en" }));
    expect(await s.resolve("en/secret/kid")).toBe(child);
    expect(await s.resolve("en/geheim/kid")).toBeNull();
  });

  it("refuses to clear a page's slug or remove its translation while subpages are published below it in that locale, and names them", async () => {
    const s = await site();
    const p = await s.page({ slug: "p" }, { slug: "p-en" });
    await s.page({ slug: "c", parent: p }, { slug: "c-en" });
    const cleared = expectErr(await s.content.update("pages", p, { slug: null, status: "draft" }, { locale: "en" }), "VALIDATION");
    expect(cleared.details?.fields).toEqual([{ field: "slug", message: expect.stringContaining('pages "c en" (en) is published below') as unknown }]);
    expectErr(await s.content.removeTranslation("pages", p, "en"), "VALIDATION");
    expect(await s.resolve("en/p-en/c-en")).not.toBeNull();
  });

  it("keeps a subpage stored under a page without a slug in its locale unreachable, with no path, no move and no refusal of other saves", async () => {
    const db = createFakePersistence();
    const raw = await createContentDefault(MODEL, db);
    const p = expectOk(await raw.create("pages", { slug: "geheim", title: "Geheim", status: "draft" })).id;
    const child = expectOk(await raw.create("pages", { slug: "kind", title: "Kind", status: "published", parent: p })).id;
    expectOk(await raw.update("pages", child, { slug: "kid", title: "Kid", status: "published" }, { locale: "en" }));
    const s = await routedSite({ model: MODEL, routes: ROUTES, db });
    expect(s.paths.pathsOf("pages", child, "reachable")).toEqual({ de: "/geheim/kind", en: null });
    expect(expectOk(await s.site.resolve("pages", "en/geheim/kid", { rules: published }))).toBeNull();
    expectOk(await s.content.update("pages", p, { title: "Geheim 2" }));
    expect(s.emitted.flat().filter((m) => m.to?.startsWith("/en/") === true)).toEqual([]);
  });
});

describe("site/default nested pages: tree", () => {
  it("lists every page with its parent, label and valid paths", async () => {
    const s = await site();
    const parent = await s.page({ slug: "eltern" });
    const child = await s.page({ slug: "kind", parent });
    const tree = expectOk(await s.paths.tree("pages"));
    expect(tree).toEqual(expect.arrayContaining([{ id: parent, parent: null, label: "eltern", paths: { de: "/eltern", en: null }, live: { de: true, en: false } }, { id: child, parent, label: "kind", paths: { de: "/eltern/kind", en: null }, live: { de: true, en: false } }]));
    const rows = expectOk(await s.db.findMany<DocRow>(DOCS, { docId: child }));
    expect(rows.items.every((r) => r.parent === parent)).toBe(true);
  });
});
