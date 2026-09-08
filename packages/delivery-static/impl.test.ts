import { describe, it, expect, vi } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentDocument, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { err, ok } from "@michaelthielemann/kestrel-contracts/errors";
import { renderFailed, type Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import type { Site } from "@michaelthielemann/kestrel-contracts/site";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { createSiteDefault } from "@michaelthielemann/kestrel-site-default/impl";
import { createFakePersistence, matchesFilter } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext } from "@michaelthielemann/kestrel/context";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { createDeliveryStatic, keyFor, rewriteMedia, STATUS } from "./impl.ts";
import module, { configSchema } from "./module.ts";

const model: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: { pages: { kind: "multi", fields: { slug: { type: "slug", localized: true, required: true }, title: { type: "text", localized: true }, status: { type: "enum", options: ["draft", "published"], localized: true } } } },
};

function fakeContent() {
  const rows = new Map<string, Record<string, unknown>>();
  const resolve = (row: Record<string, unknown>, locale: string, fallback: boolean): ContentDocument => {
    const pick = (f: string) => row[`${f}__${locale}`] ?? (fallback ? row[`${f}__de`] : undefined) ?? null;
    return { id: String(row.id), createdAt: 1, updatedAt: 1, slug: pick("slug"), title: pick("title"), status: pick("status") };
  };
  const content: Content = {
    model: () => model,
    validate: () => ({ ok: true, data: {} }),
    async get(_t, id, o) { const r = id === undefined ? undefined : rows.get(id); return ok(r ? resolve(r, o?.locale ?? "de", o?.fallback ?? false) : null); },
    async list(_t, filter = {}, o = {}) { const all = [...rows.values()].map((r) => resolve(r, o.locale ?? "de", false)).filter((d) => matchesFilter(d, filter)); return ok({ items: all.slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? all.length)), total: all.length }); },
    async create() { throw new Error("use set()"); },
    set: () => Promise.reject(new Error("n/a")),
    update: () => Promise.reject(new Error("n/a")),
    remove: () => Promise.reject(new Error("n/a")),
    removeTranslation: () => Promise.reject(new Error("n/a")),
  };
  const put = (id: string, values: Record<string, unknown>) => rows.set(id, { ...(rows.get(id) ?? { id }), ...values });
  return { content, put, rows };
}

// Stands in for site-default: enough of site@1 for delivery to build paths and hand the renderer a
// document whose internal references were rewritten.
const site: Site = {
  resolve: () => Promise.reject(new Error("n/a")),
  pathOf(_t, doc, o = {}) {
    const slug = doc.slug;
    if (typeof slug !== "string" || slug === "") return null;
    const locale = o.locale ?? doc._locale;
    const rules = o.rules ?? {};
    const prefixed = locale !== undefined && (rules.prefixPrimary === true || locale !== model.defaultLocale);
    return `/${[...(prefixed ? [locale] : []), ...(slug === rules.home ? [] : [slug])].join("/")}`;
  },
  resolveLinks: async (_t, doc) => ok({ ...doc, _links: { resolved: { path: "/x", locale: "de" } } }),
};

function fakeBlobs(): Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> } {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    blobs,
    async put(k, data, options) { blobs.set(k, { data, contentType: options?.contentType ?? "application/octet-stream" }); return ok(); },
    async get(k) { return ok(blobs.get(k)?.data ?? null); },
    async remove(k) { blobs.delete(k); return ok(); },
    async move(from, to) { const b = blobs.get(from); if (!b) throw new Error(`${from} not found`); blobs.set(to, b); blobs.delete(from); return ok(); },
    async list(p) { return ok([...blobs].filter(([k]) => k.startsWith(p)).map(([key, b]) => ({ key, size: b.data.byteLength }))); },
  };
}

function fakeRenderer(failFor: Set<string> = new Set()): Renderer & { calls: string[]; documents: Record<string, unknown>[] } {
  const calls: string[] = [];
  const documents: Record<string, unknown>[] = [];
  return {
    calls,
    documents,
    formats: () => ["html", "pdf"],
    async render(input) {
      calls.push(`${input.format} ${input.locale ?? "-"} ${input.path}`);
      documents.push(input.document);
      if (failFor.has(input.path)) return err(renderFailed(`boom at ${input.path}`));
      return ok({
        data: `<h1>${String(input.document.title)}</h1>`,
        contentType: input.format === "pdf" ? "application/pdf" : "text/html",
        extension: input.format,
        assets: input.format === "html" ? [{ path: "/_nuxt/app.js", data: "console.log(1)", contentType: "text/javascript" }] : [],
      });
    },
  };
}

function fakeLogger(): Logger & { errors: Array<{ message: string; data?: Record<string, unknown> }> } {
  const errors: Array<{ message: string; data?: Record<string, unknown> }> = [];
  return {
    errors,
    step() {},
    info() {},
    error(message, data) {
      errors.push(data === undefined ? { message } : { message, data });
    },
  };
}

const pagesType = { slugField: "slug", statusField: "status", publishedValue: "published", home: "home" };
const config = configSchema.parse({ types: { pages: pagesType }, prefix: "site/" });

describe("delivery/static", () => {
  it("computes blob keys", () => {
    expect(keyFor("site/", "/", "html")).toBe("site/index.html");
    expect(keyFor("", "/en/kontakt", "pdf")).toBe("en/kontakt/index.pdf");
  });

  it("validates config against model and renderer", async () => {
    const { content } = fakeContent();
    const deps = { content, site, renderer: fakeRenderer(), blobs: fakeBlobs(), db: createFakePersistence(), logger: fakeLogger() };
    await expect(createDeliveryStatic({ ...config, types: { posts: pagesType } }, deps)).rejects.toThrow(/unknown content type/);
    await expect(createDeliveryStatic({ ...config, types: { pages: { ...pagesType, statusField: "nope" } } }, deps)).rejects.toThrow(/does not exist/);
    await expect(createDeliveryStatic({ ...config, formats: ["epub"] }, deps)).rejects.toThrow(/does not support format/);
  });

  it("publishes only locales that are published themselves, with field fallback", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const renderer = fakeRenderer();
    const db = createFakePersistence();
    const delivery = await createDeliveryStatic(config, { content, site, renderer, blobs, db, logger: fakeLogger() }, () => 42);
    put("p1", { slug__de: "kontakt", title__de: "Kontakt", status__de: "published", status__en: "published" });
    const result = expectOk(await delivery.publish("pages", "p1"));
    expect(result.map((s) => [s.locale, s.state, s.path])).toEqual([["de", "live", "/kontakt"], ["en", "live", "/en/kontakt"]]);
    expect([...blobs.blobs.keys()].sort()).toEqual(["site/_nuxt/app.js", "site/en/kontakt/index.html", "site/kontakt/index.html"]);
    expect(renderer.calls.filter((c) => c.startsWith("html")).length).toBe(2);
    expect(new TextDecoder().decode(blobs.blobs.get("site/en/kontakt/index.html")?.data)).toBe("<h1>Kontakt</h1>");
    expect(renderer.documents.every((d) => d._links !== undefined)).toBe(true);
    expect(result[0]?.publishedAt).toBe(42);

    put("p1", { status__en: "draft" });
    const again = expectOk(await delivery.publish("pages", "p1"));
    expect(again.map((s) => [s.locale, s.state])).toEqual([["de", "live"], ["en", "draft"]]);
    expect([...blobs.blobs.keys()].sort()).toEqual(["site/_nuxt/app.js", "site/kontakt/index.html"]);
    expect(expectOk(await db.count(STATUS, {}))).toBe(2);
  });

  it("records render failures per locale and keeps the last live output", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const good = await createDeliveryStatic(config, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "team", title__de: "Team", status__de: "published" });
    expectOk(await good.publish("pages", "p1"));
    const failing = await createDeliveryStatic(config, { content, site, renderer: fakeRenderer(new Set(["/team"])), blobs, db, logger: fakeLogger() });
    const [de] = expectOk(await failing.publish("pages", "p1"));
    expect(de).toMatchObject({ state: "error", error: "boom at /team", path: "/team" });
    expect(blobs.blobs.has("site/team/index.html")).toBe(true);
    expect(expectOk(await failing.status("pages", "p1")).map((s) => s.state)).toEqual(["error", "draft"]);
  });

  it("renders every configured format, moves output on slug change and unpublishes", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const delivery = await createDeliveryStatic({ ...config, formats: ["html", "pdf"] }, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "home", title__de: "Start", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    expect([...blobs.blobs.keys()].sort()).toEqual(["site/_nuxt/app.js", "site/index.html", "site/index.pdf"]);
    put("p1", { slug__de: "start" });
    expectOk(await delivery.publish("pages", "p1"));
    expect([...blobs.blobs.keys()].sort()).toEqual(["site/_nuxt/app.js", "site/start/index.html", "site/start/index.pdf"]);
    expect(expectOk(await delivery.unpublish("pages", "p1"))).toBe(2);
    expect([...blobs.blobs.keys()]).toEqual(["site/_nuxt/app.js"]);
    expect(expectOk(await delivery.status("pages", "p1"))).toEqual([]);
  });

  it("publishAll walks every document", async () => {
    const { content, put } = fakeContent();
    const delivery = await createDeliveryStatic(config, { content, site, renderer: fakeRenderer(new Set(["/p2"])), blobs: fakeBlobs(), db: createFakePersistence(), logger: fakeLogger() });
    put("p1", { slug__de: "p1", title__de: "1", status__de: "published" });
    put("p2", { slug__de: "p2", title__de: "2", status__de: "published" });
    put("p3", { slug__de: "p3", title__de: "3", status__de: "draft" });
    expect(expectOk(await delivery.publishAll("pages"))).toEqual({ documents: 3, live: 1, errors: 1 });
  });

  it("answers a transient persistence failure with a retryable TRANSIENT", async () => {
    const { content, put } = fakeContent();
    const db = createFakePersistence();
    const delivery = await createDeliveryStatic(config, { content, site, renderer: fakeRenderer(), blobs: fakeBlobs(), db, logger: fakeLogger() });
    put("p1", { slug__de: "p1", title__de: "1", status__de: "published" });
    db.failNext("TRANSIENT");
    const error = expectErr(await delivery.publish("pages", "p1"), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe("delivery/static steps", () => {
  async function steps(db = createFakePersistence()) {
    const { content } = fakeContent();
    const delivery = await createDeliveryStatic(config, { content, site, renderer: fakeRenderer(), blobs: fakeBlobs(), db, logger: fakeLogger() });
    return module.steps!(delivery);
  }
  const ctx = (params: Record<string, string> = {}) => createContext({ trigger: { kind: "http", name: "t" }, params });

  it("unpublish and readStatus reject a missing id with VALIDATION", async () => {
    const map = await steps();
    expect(expectErr(await map.unpublish("pages")(ctx()), "VALIDATION").status).toBe(400);
    expect(expectErr(await map.readStatus("pages")(ctx()), "VALIDATION").status).toBe(400);
  });

  it("publish is a bug path when result carries no document id", async () => {
    const map = await steps();
    await expect(map.publish("pages")(ctx({ id: "p1" }))).rejects.toThrow(/without a document id in result/);
  });

  it("passes a persistence TRANSIENT failure through as a retryable 503", async () => {
    const db = createFakePersistence();
    const map = await steps(db);
    db.failNext("TRANSIENT");
    const error = expectErr(await map.readStatus("pages")(ctx({ id: "p1" })), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe("delivery/static against site/default", () => {
  async function publishInto(prefixPrimary: boolean) {
    const content = await createContentDefault(model, createFakePersistence());
    const home = expectOk(await content.create("pages", { slug: "home", title: "Start", status: "published" }));
    expectOk(await content.update("pages", home.id, { slug: "home", title: "Home", status: "published" }, { locale: "en" }));
    const kontakt = expectOk(await content.create("pages", { slug: "kontakt", title: "Kontakt", status: "published" }));
    expectOk(await content.update("pages", kontakt.id, { slug: "contact", title: "Contact", status: "published" }, { locale: "en" }));
    const blobs = fakeBlobs();
    const delivery = await createDeliveryStatic(
      { ...config, prefixPrimary },
      { content, site: createSiteDefault(content), renderer: fakeRenderer(), blobs, db: createFakePersistence(), logger: fakeLogger() },
    );
    expectOk(await delivery.publish("pages", home.id));
    expectOk(await delivery.publish("pages", kontakt.id));
    return [...blobs.blobs.keys()].filter((k) => k.endsWith("index.html")).sort();
  }

  it("writes the real site paths per locale", async () => {
    expect(await publishInto(false)).toEqual(["site/en/contact/index.html", "site/en/index.html", "site/index.html", "site/kontakt/index.html"]);
  });

  it("prefixes every locale with prefixPrimary", async () => {
    expect(await publishInto(true)).toEqual(["site/de/index.html", "site/de/kontakt/index.html", "site/en/contact/index.html", "site/en/index.html"]);
  });

  it("drops the static file of a removed translation on the next publish, also for the default locale", async () => {
    const content = await createContentDefault(model, createFakePersistence());
    const kontakt = expectOk(await content.create("pages", { slug: "kontakt", title: "Kontakt", status: "published" }));
    expectOk(await content.update("pages", kontakt.id, { slug: "contact", title: "Contact", status: "published" }, { locale: "en" }));
    const blobs = fakeBlobs();
    const site = createSiteDefault(content);
    const delivery = await createDeliveryStatic(config, { content, site, renderer: fakeRenderer(), blobs, db: createFakePersistence(), logger: fakeLogger() });
    expectOk(await delivery.publish("pages", kontakt.id));
    expect([...blobs.blobs.keys()].filter((k) => k.endsWith("index.html")).sort()).toEqual(["site/en/contact/index.html", "site/kontakt/index.html"]);

    expectOk(await content.removeTranslation("pages", kontakt.id, "de"));
    const status = expectOk(await delivery.publish("pages", kontakt.id));
    expect(status.map((s) => [s.locale, s.state, s.path])).toEqual([["de", "draft", null], ["en", "live", "/en/contact"]]);
    expect([...blobs.blobs.keys()].filter((k) => k.endsWith("index.html"))).toEqual(["site/en/contact/index.html"]);
    expect(expectOk(await site.resolve("pages", "kontakt", { rules: { filter: { status: "published" } } }))).toBeNull();
    expect(expectOk(await site.resolve("pages", "en/contact", { rules: { filter: { status: "published" } } }))).toMatchObject({ slug: "contact", _locale: "en", _translations: { de: false, en: true } });
    expect(site.pathOf("pages", expectOk(await content.get("pages", kontakt.id, { locale: "en" }))!, { locale: "en" })).toBe("/en/contact");
    expect(site.pathOf("pages", expectOk(await content.get("pages", kontakt.id))!, { locale: "de" })).toBeNull();
  });
});

function fakeHtmlRenderer(html: string): Renderer {
  return {
    formats: () => ["html"],
    async render() {
      return ok({ data: html, contentType: "text/html", extension: "html" });
    },
  };
}

describe("rewriteMedia (pure)", () => {
  it("rewrites known ids in src and comma-separated srcset candidates, leaves unknown ids", () => {
    const known = "11111111-1111-1111-1111-111111111111";
    const unknown = "22222222-2222-2222-2222-222222222222";
    const html = `<img src="/media/${known}/file" srcset="/media/${known}/variants/thumb.webp 1x, /media/${unknown}/variants/thumb.webp 2x">`;
    const out = rewriteMedia(html, "/media", (m) => (m.id === known ? `/site/media/x/y${m.size ? `.${m.size}.webp` : ""}` : undefined));
    expect(out).toBe(`<img src="/site/media/x/y" srcset="/site/media/x/y.thumb.webp 1x, /media/${unknown}/variants/thumb.webp 2x">`);
  });

  it("only matches at a segment boundary, but still rewrites through a query string or trailing segment", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const resolve = () => "/site/media/x/y";
    expect(rewriteMedia(`/media/${id}/file-x`, "/media", resolve)).toBe(`/media/${id}/file-x`);
    expect(rewriteMedia(`/media/${id}/fileabc`, "/media", resolve)).toBe(`/media/${id}/fileabc`);
    expect(rewriteMedia(`/media/${id}/variants/thumb.webp.bak`, "/media", resolve)).toBe(`/media/${id}/variants/thumb.webp.bak`);
    expect(rewriteMedia(`/media/${id}/file?v=2`, "/media", resolve)).toBe(`/site/media/x/y?v=2`);
    expect(rewriteMedia(`/media/${id}/variants/thumb.webp/extra`, "/media", resolve)).toBe(`/site/media/x/y/extra`);
  });
});

describe("delivery/static media rewrite", () => {
  const mediaId = "11111111-1111-1111-1111-111111111111";
  const mediaConfig = { publicPath: "/media", collection: "media_items", variants: "images_variants", target: "media/" };

  async function seedMedia(db: ReturnType<typeof createFakePersistence>): Promise<void> {
    expectOk(await db.ensureCollection(mediaConfig.collection, { filename: "string", folder: "string", contentType: "string", key: "string", updatedAt: "number" }));
    expectOk(await db.ensureCollection(mediaConfig.variants, { mediaId: "string", size: "string", key: "string", state: "string", format: "string" }));
  }

  async function seedOneMedia(db: ReturnType<typeof createFakePersistence>, blobs: Blobstore): Promise<void> {
    await seedMedia(db);
    expectOk(await db.createOne(mediaConfig.collection, { id: mediaId, filename: "cat.jpg", folder: "pics", contentType: "image/jpeg", key: "media/pics/cat.jpg", updatedAt: 1 }));
    expectOk(await db.createOne(mediaConfig.variants, { id: "v1", mediaId, size: "thumb", key: "media-variants/pics/thumb.webp", state: "done", format: "webp" }));
    expectOk(await db.createOne(mediaConfig.variants, { id: "v2", mediaId, size: "large", key: "media-variants/pics/large.webp", state: "pending", format: "webp" }));
    expectOk(await blobs.put("media/pics/cat.jpg", new TextEncoder().encode("cat-bytes"), { contentType: "image/jpeg" }));
    expectOk(await blobs.put("media-variants/pics/thumb.webp", new TextEncoder().encode("thumb-bytes"), { contentType: "image/webp" }));
  }

  it("copies the original and done variants, rewrites URLs, leaves pending ones and logs once", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    await seedOneMedia(db, blobs);
    const html = `<img src="/media/${mediaId}/file"><img srcset="/media/${mediaId}/variants/thumb.webp 1x, /media/${mediaId}/variants/large.webp 2x">`;
    const logger = fakeLogger();
    const delivery = await createDeliveryStatic({ ...config, media: mediaConfig }, { content, site, renderer: fakeHtmlRenderer(html), blobs, db, logger });
    put("p1", { slug__de: "team", title__de: "Team", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));

    const out = new TextDecoder().decode(blobs.blobs.get("site/team/index.html")?.data);
    expect(out).toContain('src="/media/pics/cat.jpg"');
    expect(out).toContain("/media/pics/cat.jpg.thumb.webp");
    expect(out).toContain(`/media/${mediaId}/variants/large.webp`);
    expect(blobs.blobs.has("site/media/pics/cat.jpg")).toBe(true);
    expect(blobs.blobs.has("site/media/pics/cat.jpg.thumb.webp")).toBe(true);
    expect(logger.errors).toEqual([{ message: "delivery/static: media reference not exported", data: { id: mediaId, size: "large", path: `/media/${mediaId}/variants/large.webp` } }]);
  });

  it("copies media only once per process, publishAll refreshes it", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    await seedOneMedia(db, blobs);
    const html = `<img src="/media/${mediaId}/file"><img srcset="/media/${mediaId}/variants/thumb.webp 1x">`;
    const delivery = await createDeliveryStatic({ ...config, media: mediaConfig }, { content, site, renderer: fakeHtmlRenderer(html), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "team", title__de: "Team", status__de: "published" });
    put("p2", { slug__de: "other", title__de: "Other", status__de: "published" });

    const putSpy = vi.spyOn(blobs, "put");
    const mediaCopies = () => putSpy.mock.calls.filter(([key]) => key === "site/media/pics/cat.jpg" || key === "site/media/pics/cat.jpg.thumb.webp").length;

    expectOk(await delivery.publish("pages", "p1"));
    expect(mediaCopies()).toBe(2);
    expectOk(await delivery.publish("pages", "p2"));
    expect(mediaCopies()).toBe(2);

    expectOk(await delivery.publishAll("pages"));
    expect(mediaCopies()).toBe(4);
  });

  it("leaves HTML unchanged and copies nothing when media is not configured", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const html = `<img src="/media/${mediaId}/file">`;
    const delivery = await createDeliveryStatic(config, { content, site, renderer: fakeHtmlRenderer(html), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "team", title__de: "Team", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    expect(new TextDecoder().decode(blobs.blobs.get("site/team/index.html")?.data)).toBe(html);
    expect([...blobs.blobs.keys()]).toEqual(["site/team/index.html"]);
  });

  it("supports a custom publicPath", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    await seedMedia(db);
    expectOk(await db.createOne(mediaConfig.collection, { id: mediaId, filename: "cat.jpg", folder: "pics", contentType: "image/jpeg", key: "media/pics/cat.jpg", updatedAt: 1 }));
    expectOk(await blobs.put("media/pics/cat.jpg", new TextEncoder().encode("cat-bytes"), { contentType: "image/jpeg" }));
    const html = `<img src="/api/media/${mediaId}/file">`;
    const delivery = await createDeliveryStatic({ ...config, media: { ...mediaConfig, publicPath: "/api/media" } }, { content, site, renderer: fakeHtmlRenderer(html), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "team", title__de: "Team", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    const out = new TextDecoder().decode(blobs.blobs.get("site/team/index.html")?.data);
    expect(out).toContain('src="/media/pics/cat.jpg"');
    expect(blobs.blobs.has("site/media/pics/cat.jpg")).toBe(true);
  });

  it("fails the locale instead of rewriting to a blob that was never copied", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    await seedMedia(db);
    expectOk(await db.createOne(mediaConfig.collection, { id: mediaId, filename: "cat.jpg", folder: "pics", contentType: "image/jpeg", key: "media/pics/cat.jpg", updatedAt: 1 }));
    // no blob put for "media/pics/cat.jpg" -> the row exists but its blob is missing
    const html = `<img src="/media/${mediaId}/file">`;
    const delivery = await createDeliveryStatic({ ...config, media: mediaConfig }, { content, site, renderer: fakeHtmlRenderer(html), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "team", title__de: "Team", status__de: "published" });
    const [status] = expectOk(await delivery.publish("pages", "p1"));
    expect(status).toMatchObject({ state: "error", error: `delivery/static: media blob media/pics/cat.jpg missing for ${mediaId}` });
    expect(blobs.blobs.has("site/team/index.html")).toBe(false);
  });

  it("rejects a media row whose folder attempts path traversal", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    await seedMedia(db);
    expectOk(await db.createOne(mediaConfig.collection, { id: mediaId, filename: "cat.jpg", folder: "../..", contentType: "image/jpeg", key: "media/pics/cat.jpg", updatedAt: 1 }));
    expectOk(await blobs.put("media/pics/cat.jpg", new TextEncoder().encode("cat-bytes"), { contentType: "image/jpeg" }));
    const html = `<img src="/media/${mediaId}/file">`;
    const delivery = await createDeliveryStatic({ ...config, media: mediaConfig }, { content, site, renderer: fakeHtmlRenderer(html), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "team", title__de: "Team", status__de: "published" });
    const [status] = expectOk(await delivery.publish("pages", "p1"));
    expect(status?.state).toBe("error");
    expect(status?.error).toMatch(/invalid media folder "\.\.\/\.\.".*for/);
    expect(blobs.blobs.has("site/media/../../cat.jpg")).toBe(false);
    expect([...blobs.blobs.keys()]).toEqual(["media/pics/cat.jpg"]);
  });
});
