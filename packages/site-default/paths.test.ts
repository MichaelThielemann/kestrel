import { describe, expect, it } from "vitest";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { PAGES_ROUTE, recordingEvents, routedContent, routedSite } from "./__fixtures__/routed.ts";
import { createSiteDefault } from "./impl.ts";
import { createSitePaths } from "./paths.ts";
import type { Move, RoutesConfig } from "./routes.ts";
import { RUNS, type RunRow } from "./table.ts";

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
      },
    },
    posts: {
      kind: "multi",
      fields: {
        permalink: { type: "slug", required: true, localized: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], localized: true },
      },
    },
  },
};

const published = { home: "home", fallback: true, filter: { status: "published" } };
const POSTS_ROUTE = { slugField: "permalink", home: null, liveWhen: { status: "published" }, labelField: "title" };

async function runs(db: ReturnType<typeof createFakePersistence>): Promise<RunRow[]> {
  return expectOk(await db.findMany<RunRow>(RUNS, {}, { sort: { seq: "asc" } })).items;
}

describe("site/default routed paths: uniqueness", () => {
  it("saves one path per locale, for one document and for two documents", async () => {
    const { site, content } = await routedSite({ model: MODEL });
    const same = expectOk(await content.create("pages", { slug: "x", title: "X", status: "published" }));
    expectOk(await content.update("pages", same.id, { slug: "x", title: "X EN", status: "published" }, { locale: "en" }));
    const other = expectOk(await content.create("pages", { slug: "y", title: "Y", status: "published" }));
    expectOk(await content.update("pages", other.id, { slug: "y-en", title: "Y EN", status: "published" }, { locale: "en" }));
    expect(expectOk(await site.resolve("pages", "x", { rules: published }))).toMatchObject({ id: same.id, _paths: { de: "/x", en: "/en/x" } });
    expect(expectOk(await site.resolve("pages", "en/x", { rules: published }))).toMatchObject({ id: same.id, title: "X EN" });
    expect(expectOk(await site.resolve("pages", "en/y-en", { rules: published }))).toMatchObject({ id: other.id });
  });

  it("rejects the same slug in two routed types at the top level and names the occupant", async () => {
    const { content } = await routedSite({ model: MODEL, routes: { pages: PAGES_ROUTE, posts: POSTS_ROUTE } });
    const page = expectOk(await content.create("pages", { slug: "news", title: "News", status: "published" }));
    const error = expectErr(await content.create("posts", { permalink: "news", title: "Hallo", status: "draft" }), "CONFLICT");
    expect(error.message).toContain('/news (de) is taken by pages "News"');
    expect(error.details?.conflicts).toEqual([
      { path: "/news", locale: "de", type: "pages", id: page.id, label: "News", moving: { type: "posts", id: expect.any(String) as unknown } },
      { path: "/en/news", locale: "en", type: "pages", id: page.id, label: "News", moving: { type: "posts", id: expect.any(String) as unknown } },
    ]);
    expect(error.details?.fields).toEqual([
      { field: "permalink", message: '/news (de) is taken by pages "News"' },
      { field: "permalink", message: '/en/news (en) is taken by pages "News"' },
    ]);
    expect(expectOk(await content.list("posts", {})).total).toBe(0);
  });

  it("drafts block each other like published documents", async () => {
    const { content } = await routedSite({ model: MODEL });
    expectOk(await content.create("pages", { slug: "idee", title: "Idee", status: "draft" }));
    expectErr(await content.create("pages", { slug: "idee", title: "Idee 2", status: "draft" }), "CONFLICT");
  });

  it("leaves an unrouted type as it is: the same slug saves and resolves by its own rules", async () => {
    const { site, content } = await routedSite({ model: MODEL });
    expectOk(await content.create("pages", { slug: "news", title: "News", status: "published" }));
    const post = expectOk(await content.create("posts", { permalink: "news", title: "Post", status: "published" }));
    expect(expectOk(await site.resolve("posts", "news", { rules: { home: "index", slugField: "permalink", filter: { status: "published" } } }))).toMatchObject({ id: post.id });
    expect(expectOk(await site.resolve("posts", "news", { rules: { home: "index", slugField: "permalink" } }))?._paths).toBeUndefined();
  });

  it("rejects reserved paths and a top-level locale code as slug field errors, and allows them below a locale prefix", async () => {
    const { content, site } = await routedSite({ model: MODEL, reservedPaths: ["/admin", "/media"] });
    const admin = expectErr(await content.create("pages", { slug: "admin", title: "Admin", status: "published" }), "VALIDATION");
    expect(admin.details).toEqual({ fields: [{ field: "slug", message: "the path /admin lies under the reserved path /admin" }] });
    expectErr(await content.create("pages", { slug: "media", title: "Media", status: "published" }), "VALIDATION");
    const locale = expectErr(await content.create("pages", { slug: "en", title: "En", status: "published" }), "VALIDATION");
    expect(locale.details).toEqual({ fields: [{ field: "slug", message: '"en" is a locale code and cannot start a path' }] });
    const page = expectOk(await content.create("pages", { slug: "verwaltung", title: "Verwaltung", status: "published" }));
    expectOk(await content.update("pages", page.id, { slug: "admin", title: "Admin", status: "published" }, { locale: "en" }));
    expect(expectOk(await site.resolve("pages", "en/admin", { rules: published }))).toMatchObject({ id: page.id });
  });
});

describe("site/default routed paths: shadowing", () => {
  it("a draft with its own slug leaves the fallback page served; publishing it takes the fallback page offline in that locale", async () => {
    const { site, content, emitted } = await routedSite({ model: MODEL });
    const fallback = expectOk(await content.create("pages", { slug: "x", title: "X", status: "published" }));
    expectOk(await content.update("pages", fallback.id, { title: "X EN", status: "published" }, { locale: "en" }));
    const draft = expectOk(await content.create("pages", { slug: "anders", title: "Anders", status: "draft" }));
    emitted.length = 0;
    expectOk(await content.update("pages", draft.id, { slug: "x", title: "Other", status: "draft" }, { locale: "en" }));

    expect(expectOk(await site.resolve("pages", "en/x", { rules: published }))).toMatchObject({ id: fallback.id, _paths: { de: "/x", en: "/en/x" } });
    expect(expectOk(await site.resolve("pages", "anders", { rules: { home: "home" } }))).toMatchObject({ id: draft.id, _paths: { de: null, en: null } });
    expect(emitted.flat()).toEqual([]);

    expectOk(await content.update("pages", draft.id, { status: "published" }, { locale: "en" }));
    expect(expectOk(await site.resolve("pages", "en/x", { rules: published }))).toMatchObject({ id: draft.id });
    const moves = emitted.flat();
    expect(moves.map(({ id, locale, from, to }) => ({ id, locale, from, to }))).toEqual(
      expect.arrayContaining([
        { id: fallback.id, locale: "en", from: "/en/x", to: null },
        { id: draft.id, locale: "en", from: null, to: "/en/x" },
      ]),
    );
    expect(moves).toHaveLength(2);

    expectOk(await content.update("pages", draft.id, { status: "draft" }, { locale: "en" }));
    expect(expectOk(await site.resolve("pages", "en/x", { rules: published }))).toMatchObject({ id: fallback.id });
  });

  it("with an empty filter a draft's own path finds it, and the configured filter does not", async () => {
    const { site, content } = await routedSite();
    const draft = expectOk(await content.create("pages", { slug: "entwurf", title: "Entwurf", status: "draft" }));
    expect(expectOk(await site.resolve("pages", "entwurf", { rules: { home: "home" } }))).toMatchObject({ id: draft.id });
    expect(expectOk(await site.resolve("pages", "entwurf", { rules: published }))).toBeNull();
  });

  it("links to a shadowed fallback path are broken", async () => {
    const { site, content } = await routedSite({ model: MODEL });
    const fallback = expectOk(await content.create("pages", { slug: "x", title: "X", status: "published" }));
    expectOk(await content.update("pages", fallback.id, { title: "X EN", status: "published" }, { locale: "en" }));
    const owner = expectOk(await content.create("pages", { slug: "y", title: "Y", status: "published" }));
    expectOk(await content.update("pages", owner.id, { slug: "x", title: "Y EN", status: "published" }, { locale: "en" }));
    const linked = expectOk(await site.resolveLinks("pages", { id: "l", createdAt: 0, updatedAt: 0, ref: `kestrel:pages:${fallback.id}` }, { locale: "en", rules: published }));
    expect(linked._links).toEqual({ [fallback.id]: { broken: true } });
  });

  it("rejects a per-call slug field or home that contradicts the route", async () => {
    const { site } = await routedSite();
    await expect(site.resolve("pages", "x", { rules: { home: "start" } })).rejects.toThrow(/routed with home "home"/);
    expect(() => site.pathOf("pages", { id: "1", createdAt: 0, updatedAt: 0, slug: "x" }, { rules: { slugField: "name" } })).toThrow(/routed with slug field "slug"/);
  });
});

describe("site/default routed paths: moves and runs", () => {
  it("a slug rename records one move per locale and one run", async () => {
    const { content, db, emitted } = await routedSite({ model: MODEL });
    const page = expectOk(await content.create("pages", { slug: "alt", title: "Alt", status: "published" }));
    expectOk(await content.update("pages", page.id, { title: "Old", status: "published" }, { locale: "en" }));
    const before = (await runs(db)).length;
    emitted.length = 0;
    expectOk(await content.update("pages", page.id, { slug: "neu" }));
    const after = await runs(db);
    expect(after).toHaveLength(before + 1);
    const run = after[after.length - 1]!;
    expect(run.moves.map(({ locale, from, to }) => ({ locale, from, to }))).toEqual([
      { locale: "de", from: "/alt", to: "/neu" },
      { locale: "en", from: "/en/alt", to: "/en/neu" },
    ]);
    expect(run.announced).toBe(true);
    expect(emitted).toEqual([run.moves]);
  });

  it("a removed page moves to null in every locale where it was reachable", async () => {
    const { content, emitted, site } = await routedSite({ model: MODEL });
    const page = expectOk(await content.create("pages", { slug: "weg", title: "Weg", status: "published" }));
    emitted.length = 0;
    expectOk(await content.remove("pages", page.id));
    expect(emitted.flat().map(({ locale, from, to }) => ({ locale, from, to }))).toEqual([{ locale: "de", from: "/weg", to: null }]);
    expect(expectOk(await site.resolve("pages", "weg", { rules: { home: "home" } }))).toBeNull();
  });

  it("removing a translation whose slug equals the default slug keeps the path as a fallback, unreachable until the locale is published again", async () => {
    const { content, emitted, site } = await routedSite({ model: MODEL });
    const page = expectOk(await content.create("pages", { slug: "gleich", title: "Gleich", status: "published" }));
    expectOk(await content.update("pages", page.id, { slug: "gleich", title: "Same", status: "published" }, { locale: "en" }));
    emitted.length = 0;
    expectOk(await content.removeTranslation("pages", page.id, "en"));
    expect(emitted.flat().map(({ locale, from, to }) => ({ locale, from, to }))).toEqual([{ locale: "en", from: "/en/gleich", to: null }]);
    expect(site.pathOf("pages", expectOk(await content.get("pages", page.id))!, { locale: "en", rules: { home: "home" } })).toBe("/en/gleich");
  });

  it("a removed translation falls back to the default locale's slug", async () => {
    const { content, emitted } = await routedSite({ model: MODEL });
    const page = expectOk(await content.create("pages", { slug: "seite", title: "Seite", status: "published" }));
    expectOk(await content.update("pages", page.id, { slug: "page", title: "Page", status: "published" }, { locale: "en" }));
    emitted.length = 0;
    expectOk(await content.removeTranslation("pages", page.id, "en"));
    expect(emitted.flat().map(({ locale, from, to }) => ({ locale, from, to }))).toEqual([{ locale: "en", from: "/en/page", to: null }]);
  });
});

describe("site/default routed paths: repair without a restart", () => {
  it("a failed event leaves memory patched, and the next resume raises the moves again", async () => {
    let clock = 1_000_000;
    const { content, site, events, emitted, paths } = await routedSite({ model: MODEL, now: () => clock });
    const page = expectOk(await content.create("pages", { slug: "a", title: "A", status: "published" }));
    emitted.length = 0;
    events.failNext();
    expectOk(await content.update("pages", page.id, { slug: "b" }));
    expect(expectOk(await site.resolve("pages", "b", { rules: published }))).toMatchObject({ id: page.id });
    expect(emitted).toEqual([]);
    clock += 6_000;
    expect(expectOk(await paths.resume())).toEqual({ announced: 1, pruned: 0 });
    expect(emitted.flat().map(({ from, to }) => ({ from, to }))).toEqual([{ from: "/a", to: "/b" }]);
    expect(expectOk(await paths.resume())).toEqual({ announced: 0, pruned: 0 });
  });

  it("a committed run nobody announced is raised by the first resume after a restart, and memory is loaded from the rows", async () => {
    const db = createFakePersistence();
    const first = await routedSite({ model: MODEL, db });
    const page = expectOk(await first.content.create("pages", { slug: "a", title: "A", status: "published" }));
    const outcome = await db.scope({ pipeline: "t", group: 1 }, async () => {
      expectOk(await first.raw.update("pages", page.id, { slug: "b" }));
      expectOk(await first.paths.index("pages", page.id, "crashed-run"));
      return "commit";
    });
    expect(outcome).toEqual({ kind: "settled", verdict: "commit" });
    await new Promise((resolve) => setTimeout(resolve, 2));

    const emitted: Move[][] = [];
    const raw = await createContentDefault(MODEL, db);
    const paths = await createSitePaths({ routes: { pages: PAGES_ROUTE }, prefixPrimary: false, reservedPaths: [] }, { content: raw, db, events: recordingEvents(emitted), logger: silentLogger });
    const site = createSiteDefault(raw, paths);
    expect(expectOk(await site.resolve("pages", "b", { rules: published }))).toMatchObject({ id: page.id });
    expect(expectOk(await paths.resume()).announced).toBe(1);
    expect(emitted.flat().map(({ from, to }) => ({ from, to }))).toEqual([{ from: "/a", to: "/b" }]);
  });

  it("a rolled-back group changes neither rows nor memory", async () => {
    const { content, site, db, paths, raw } = await routedSite({ model: MODEL });
    const page = expectOk(await content.create("pages", { slug: "a", title: "A", status: "published" }));
    const before = (await runs(db)).length;
    const outcome = await db.scope({ pipeline: "t", group: 1 }, async () => {
      expectOk(await raw.update("pages", page.id, { slug: "b" }));
      expectOk(await paths.index("pages", page.id, "rolled-back"));
      return "rollback";
    });
    expect(outcome).toEqual({ kind: "settled", verdict: "rollback" });
    expect(await runs(db)).toHaveLength(before);
    expect(expectOk(await site.resolve("pages", "a", { rules: published }))).toMatchObject({ id: page.id });
    expect(paths.pathsOf("pages", page.id, "reachable")).toEqual({ de: "/a", en: null });
  });
});

describe("site/default routed paths: rebuild", () => {
  it("the first build reports seeded collisions, keeps the older holder and records no moves", async () => {
    const db = createFakePersistence();
    const raw = await createContentDefault(MODEL, db);
    const older = expectOk(await raw.create("pages", { slug: "x", title: "Older", status: "published" }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    const younger = expectOk(await raw.create("pages", { slug: "x", title: "Younger", status: "published" }));
    const errors: unknown[] = [];
    const logger = { ...silentLogger, error: (_m: string, data?: Record<string, unknown>) => void errors.push(data?.conflicts) };
    const { site, paths } = await routedSite({ model: MODEL, db, logger });
    expect(errors).toEqual([[{ path: "/x", locale: "de", winner: { type: "pages", id: older.id }, losers: [{ type: "pages", id: younger.id }], reason: "taken" }, { path: "/en/x", locale: "en", winner: { type: "pages", id: older.id }, losers: [{ type: "pages", id: younger.id }], reason: "taken" }]]);
    expect(expectOk(await site.resolve("pages", "x", { rules: published }))).toMatchObject({ id: older.id });
    expect((await runs(db)).flatMap((r) => r.moves)).toEqual([]);
    expect(paths.pathsOf("pages", younger.id, "valid")).toEqual({ de: null, en: null });
  });

  it("a rebuild keeps the current holder of a tail against an older document that took it by a direct write", async () => {
    const { content, raw, paths, site } = await routedSite({ model: MODEL });
    const older = expectOk(await content.create("pages", { slug: "alt", title: "Older", status: "published" }));
    const holder = expectOk(await content.create("pages", { slug: "x", title: "Holder", status: "published" }));
    expectOk(await raw.update("pages", older.id, { slug: "x" }));
    const plan = expectOk(await paths.planRebuild());
    const report = expectOk(await paths.applyRebuild(plan, "rebuild-run"));
    expect(report.conflicts).toEqual([
      { path: "/x", locale: "de", winner: { type: "pages", id: holder.id }, losers: [{ type: "pages", id: older.id }], reason: "taken" },
      { path: "/en/x", locale: "en", winner: { type: "pages", id: holder.id }, losers: [{ type: "pages", id: older.id }], reason: "taken" },
    ]);
    await paths.announce("rebuild-run");
    expect(expectOk(await site.resolve("pages", "x", { rules: published }))).toMatchObject({ id: holder.id });
    expect(expectOk(await site.resolve("pages", "alt", { rules: published }))).toBeNull();
  });

  it("a save that commits between plan and apply is recomputed inside the apply, and the rebuild's moves come after it", async () => {
    const { content, raw, paths, site, db } = await routedSite({ model: MODEL });
    const page = expectOk(await content.create("pages", { slug: "a", title: "A", status: "published" }));
    const drifted = expectOk(await content.create("pages", { slug: "d", title: "D", status: "published" }));
    expectOk(await raw.update("pages", drifted.id, { slug: "d-neu" }));
    const plan = expectOk(await paths.planRebuild());
    expectOk(await content.update("pages", page.id, { slug: "b" }));
    const saveSeq = (await runs(db)).at(-1)!.seq;
    const report = expectOk(await paths.applyRebuild(plan, "rebuild-run"));
    expect(report.conflicts).toEqual([]);
    await paths.announce("rebuild-run");
    expect(expectOk(await site.resolve("pages", "b", { rules: published }))).toMatchObject({ id: page.id });
    expect(expectOk(await site.resolve("pages", "d-neu", { rules: published }))).toMatchObject({ id: drifted.id });
    const rebuildRun = (await runs(db)).find((r) => r.runId === "rebuild-run")!;
    expect(rebuildRun.seq).toBeGreaterThan(saveSeq);
    expect(rebuildRun.moves.map(({ id, from, to, seq }) => ({ id, from, to, seq }))).toEqual([{ id: drifted.id, from: "/d", to: "/d-neu", seq: rebuildRun.seq }]);
  });

  it("adding a locale and rebooting makes the new locale resolve", async () => {
    const db = createFakePersistence();
    const deOnly: ContentModel = { ...MODEL, locales: ["de"] };
    const first = await routedSite({ model: deOnly, db });
    const page = expectOk(await first.content.create("pages", { slug: "x", title: "X", status: "published" }));
    const { site } = await routedSite({ model: MODEL, db });
    expect(expectOk(await site.resolve("pages", "en/x", { rules: { home: "home", fallback: true } }))).toMatchObject({ id: page.id, _locale: "en" });
  });

  it("a direct write followed by an ordinary save of another page is picked up at the next boot", async () => {
    const db = createFakePersistence();
    const first = await routedSite({ model: MODEL, db });
    const direct = expectOk(await first.content.create("pages", { slug: "a", title: "A", status: "published" }));
    const other = expectOk(await first.content.create("pages", { slug: "o", title: "O", status: "published" }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    expectOk(await first.raw.update("pages", direct.id, { slug: "b" }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    expectOk(await first.content.update("pages", other.id, { title: "O2" }));
    const { site, emitted, paths } = await routedSite({ model: MODEL, db });
    expect(expectOk(await site.resolve("pages", "b", { rules: published }))).toMatchObject({ id: direct.id });
    expect(expectOk(await site.resolve("pages", "a", { rules: published }))).toBeNull();
    await paths.resume();
    expect(emitted.flat().map(({ from, to }) => ({ from, to }))).toEqual([{ from: "/a", to: "/b" }]);
  });

  it("a restart with unchanged routes and content does not rebuild", async () => {
    const db = createFakePersistence();
    const first = await routedSite({ model: MODEL, db });
    expectOk(await first.content.create("pages", { slug: "a", title: "A", status: "published" }));
    const before = (await runs(db)).length;
    await routedSite({ model: MODEL, db });
    expect(await runs(db)).toHaveLength(before);
  });
});

describe("site/default routed paths: preview", () => {
  it("names the occupant, the locale and the fallback page a save would shadow", async () => {
    const { content, paths } = await routedSite({ model: MODEL });
    const occupant = expectOk(await content.create("pages", { slug: "x", title: "Occupant", status: "published" }));
    expectOk(await content.update("pages", occupant.id, { title: "Occupant EN", status: "published" }, { locale: "en" }));
    const mine = expectOk(await content.create("pages", { slug: "mine", title: "Mine", status: "published" }));
    expect(expectOk(await paths.preview("pages", { id: mine.id, slug: "x" }))).toMatchObject({ path: "/x", reachable: false, conflict: { path: "/x", locale: "de", type: "pages", id: occupant.id, label: "Occupant" } });
    expect(expectOk(await paths.preview("pages", { id: mine.id, locale: "en", slug: "x" }))).toMatchObject({ path: "/en/x", conflict: null, shadows: [{ type: "pages", id: occupant.id, label: "Occupant EN", path: "/en/x" }] });
    expect(expectOk(await paths.preview("pages", { id: mine.id, slug: "neu" }))).toMatchObject({ path: "/neu", reachable: true, reason: null });
  });
});

describe("site/default routed paths: configuration form", () => {
  it("formats every stored path with prefixPrimary when configured", async () => {
    const config: Partial<RoutesConfig> = { prefixPrimary: true };
    const { content, paths } = await routedSite({ model: MODEL, prefixPrimary: config.prefixPrimary ?? false });
    const page = expectOk(await content.create("pages", { slug: "x", title: "X", status: "published" }));
    expect(paths.pathsOf("pages", page.id, "reachable")).toEqual({ de: "/de/x", en: null });
  });

  it("works on a model without locales", async () => {
    const model: ContentModel = { types: { pages: { kind: "multi", fields: { slug: { type: "slug", required: true }, title: "text", status: { type: "enum", options: ["draft", "published"] } } } } };
    const { content, site, emitted } = await routedSite({ model });
    const page = expectOk(await content.create("pages", { slug: "home", title: "Start", status: "published" }));
    expect(expectOk(await site.resolve("pages", "", { rules: published }))).toMatchObject({ id: page.id, _paths: { "": "/" } });
    expect(emitted.flat()).toEqual([{ type: "pages", id: page.id, locale: "", from: null, to: "/", seq: expect.any(Number) as unknown }]);
    expect(site.pathOf("pages", expectOk(await content.get("pages", page.id))!, { rules: published })).toBe("/");
  });
});

describe("site/default routed paths: memory", () => {
  it("routedContent writes to unrouted types unchanged", async () => {
    const db = createFakePersistence();
    const raw = await createContentDefault(MODEL, db);
    const emitted: Move[][] = [];
    const paths = await createSitePaths({ routes: { pages: PAGES_ROUTE }, prefixPrimary: false, reservedPaths: [] }, { content: raw, db, events: recordingEvents(emitted), logger: silentLogger });
    const content = routedContent(raw, paths, db);
    expectOk(await content.create("posts", { permalink: "p", title: "P", status: "published" }));
    expect(emitted).toEqual([]);
  });
});
