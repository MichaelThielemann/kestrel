import { describe, expect, it } from "vitest";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { routedSite } from "./__fixtures__/routed.ts";
import { routeWith } from "./routes.ts";

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
    posts: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, localized: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], localized: true },
      },
    },
    events: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, localized: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], localized: true },
      },
    },
    settings: { kind: "single", fields: { title: { type: "text" }, mounts: { type: "json" } } },
  },
};

const ROUTES = {
  pages: routeWith({ home: "home", liveWhen: { status: "published" }, parentField: "parent" }),
  posts: routeWith({ liveWhen: { status: "published" }, mount: true }),
  events: routeWith({ liveWhen: { status: "published" }, mount: true }),
};
const published = { fallback: true, filter: { status: "published" } };

async function site() {
  const routed = await routedSite({ model: MODEL, routes: ROUTES, config: { mounts: { type: "settings", field: "mounts" } } });
  const create = async (type: string, fields: Record<string, unknown>, en?: Record<string, unknown>): Promise<string> => {
    const id = expectOk(await routed.content.create(type, { status: "published", title: String(fields.slug), ...fields })).id;
    if (en) expectOk(await routed.content.update(type, id, { status: "published", title: `${String(fields.slug)} en`, ...en }, { locale: "en" }));
    return id;
  };
  const resolve = async (type: string, path: string) => expectOk(await routed.site.resolve(type, path, { rules: { ...published, ...(type === "pages" ? { home: "home" } : {}) } }))?.id ?? null;
  const mount = (page: string | null) => routed.content.set("settings", { title: "Site", mounts: { posts: page } });
  const moves = () => routed.emitted.flat().map(({ id, locale, from, to }) => ({ id, locale, from, to }));
  return { ...routed, create, resolve, mount, moves };
}

describe("site/default mounted collections", () => {
  it("a collection mounted at a page resolves below that page's path in every locale", async () => {
    const s = await site();
    const blog = await s.create("pages", { slug: "blog" }, { slug: "news" });
    const post = await s.create("posts", { slug: "hallo" }, {});
    expectOk(await s.mount(blog));
    expect(await s.resolve("posts", "blog/hallo")).toBe(post);
    expect(await s.resolve("posts", "en/news/hallo")).toBe(post);
    expect(await s.resolve("posts", "hallo")).toBeNull();
    expect(s.paths.pathsOf("posts", post, "reachable")).toEqual({ de: "/blog/hallo", en: "/en/news/hallo" });
  });

  it("an unassigned collection lives at the top level and collides with pages there", async () => {
    const s = await site();
    const post = await s.create("posts", { slug: "hallo" });
    expect(await s.resolve("posts", "hallo")).toBe(post);
    const error = expectErr(await s.content.create("pages", { slug: "hallo", title: "Hallo", status: "published" }), "CONFLICT");
    expect(error.details?.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/hallo", type: "posts", id: post })]));
  });

  it("renaming the mount page moves every mounted document", async () => {
    const s = await site();
    const blog = await s.create("pages", { slug: "blog" });
    const a = await s.create("posts", { slug: "a" });
    const b = await s.create("posts", { slug: "b" });
    expectOk(await s.mount(blog));
    s.emitted.length = 0;
    expectOk(await s.content.update("pages", blog, { slug: "journal" }));
    expect(s.moves()).toEqual(
      expect.arrayContaining([
        { id: blog, locale: "de", from: "/blog", to: "/journal" },
        { id: a, locale: "de", from: "/blog/a", to: "/journal/a" },
        { id: b, locale: "de", from: "/blog/b", to: "/journal/b" },
      ]),
    );
    expect(await s.resolve("posts", "journal/a")).toBe(a);
  });

  it("switching to the top level with a colliding slug rejects the settings save and names the collision", async () => {
    const s = await site();
    const blog = await s.create("pages", { slug: "blog" });
    const page = await s.create("pages", { slug: "hallo" });
    expectOk(await s.mount(blog));
    await s.create("posts", { slug: "hallo" });
    const error = expectErr(await s.mount(null), "CONFLICT");
    expect(error.details?.fields).toContainEqual({ field: "mounts", message: expect.stringContaining("/hallo (de) is taken by pages") as unknown });
    expect(error.details?.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ id: page })]));
    expect(expectOk(await s.content.get("settings"))?.mounts).toEqual({ posts: blog });
  });

  it("rejects an assignment to a missing page, the home page or an unknown collection", async () => {
    const s = await site();
    const home = await s.create("pages", { slug: "home" });
    expectErr(await s.mount("missing"), "VALIDATION");
    const error = expectErr(await s.mount(home), "VALIDATION");
    expect(error.details).toEqual({ fields: [{ field: "mounts", message: "posts: the home page cannot hold a mounted collection" }] });
    expectErr(await s.content.set("settings", { title: "Site", mounts: { pages: home } }), "VALIDATION");
  });

  it("rejects one page assigned to two collections, naming both", async () => {
    const s = await site();
    const blog = await s.create("pages", { slug: "blog" });
    const error = expectErr(await s.content.set("settings", { title: "Site", mounts: { posts: blog, events: blog } }), "VALIDATION");
    expect(error.details?.fields).toContainEqual({ field: "mounts", message: `pages/${blog} is assigned to both posts and events` });
  });

  it("an unpublished mount page answers 404 while its mounted documents stay reachable", async () => {
    const s = await site();
    const blog = await s.create("pages", { slug: "blog" });
    const post = await s.create("posts", { slug: "a" });
    expectOk(await s.mount(blog));
    s.emitted.length = 0;
    expectOk(await s.content.update("pages", blog, { status: "draft" }));
    expect(await s.resolve("pages", "blog")).toBeNull();
    expect(await s.resolve("posts", "blog/a")).toBe(post);
    expect(s.moves()).toEqual([{ id: blog, locale: "de", from: "/blog", to: null }]);
  });

  it("refuses to remove the mount page", async () => {
    const s = await site();
    const blog = await s.create("pages", { slug: "blog" });
    expectOk(await s.mount(blog));
    const error = expectErr(await s.content.remove("pages", blog), "CONFLICT");
    expect(error.message).toContain("every posts (mounted here)");
  });

  it("a restart with a mount assignment written past the index rebuilds the mounted paths", async () => {
    const s = await site();
    const blog = await s.create("pages", { slug: "blog" });
    const post = await s.create("posts", { slug: "a" });
    expectOk(await s.raw.set("settings", { title: "Site", mounts: { posts: blog } }));
    const again = await routedSite({ model: MODEL, routes: ROUTES, db: s.db, config: { mounts: { type: "settings", field: "mounts" } } });
    expect(expectOk(await again.site.resolve("posts", "blog/a", { rules: published }))?.id).toBe(post);
  });
});
