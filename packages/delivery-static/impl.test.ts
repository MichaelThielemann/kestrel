import { describe, it, expect, vi } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentDocument, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { err, failure, ok } from "@michaelthielemann/kestrel-contracts/errors";
import type { Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { renderFailed, type Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import type { Site } from "@michaelthielemann/kestrel-contracts/site";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { createSiteDefault } from "@michaelthielemann/kestrel-site-default/impl";
import { createFakePersistence, matchesFilter } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext } from "@michaelthielemann/kestrel/context";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { createDeliveryStatic, keyFor, STATUS } from "./impl.ts";
import module, { configSchema } from "./module.ts";

const model: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: { pages: { kind: "multi", fields: { slug: { type: "slug", localized: true, required: true }, title: { type: "text", localized: true }, body: { type: "text", localized: true }, status: { type: "enum", options: ["draft", "published"], localized: true } } } },
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
        assets: input.format === "html" ? [{ path: "/_app/app.js", data: "console.log(1)", contentType: "text/javascript" }] : [],
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
    expect([...blobs.blobs.keys()].sort()).toEqual(["site/_app/app.js", "site/en/kontakt/index.html", "site/kontakt/index.html"]);
    expect(renderer.calls.filter((c) => c.startsWith("html")).length).toBe(2);
    expect(new TextDecoder().decode(blobs.blobs.get("site/en/kontakt/index.html")?.data)).toBe("<h1>Kontakt</h1>");
    expect(renderer.documents.every((d) => d._links !== undefined)).toBe(true);
    expect(result[0]?.publishedAt).toBe(42);

    put("p1", { status__en: "draft" });
    const again = expectOk(await delivery.publish("pages", "p1"));
    expect(again.map((s) => [s.locale, s.state])).toEqual([["de", "live"], ["en", "draft"]]);
    expect([...blobs.blobs.keys()].sort()).toEqual(["site/_app/app.js", "site/kontakt/index.html"]);
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
    expect([...blobs.blobs.keys()].sort()).toEqual(["site/_app/app.js", "site/index.html", "site/index.pdf"]);
    put("p1", { slug__de: "start" });
    expectOk(await delivery.publish("pages", "p1"));
    expect([...blobs.blobs.keys()].sort()).toEqual(["site/_app/app.js", "site/start/index.html", "site/start/index.pdf"]);
    expect(expectOk(await delivery.unpublish("pages", "p1"))).toBe(2);
    expect([...blobs.blobs.keys()]).toEqual(["site/_app/app.js"]);
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

  it("publish answers VALIDATION when neither the result nor the payload names a document", async () => {
    const map = await steps();
    expect(expectErr(await map.publish("pages")(ctx({ id: "p1" })), "VALIDATION").status).toBe(400);
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

  it("fills an empty field from the default locale only when the default locale is itself published", async () => {
    const content = await createContentDefault(model, createFakePersistence());
    const withDefault = expectOk(await content.create("pages", { slug: "erste", title: "Erste", status: "published", body: "Text DE" }));
    expectOk(await content.update("pages", withDefault.id, { slug: "first", title: "First", status: "published" }, { locale: "en" }));
    const draftDefault = expectOk(await content.create("pages", { slug: "zweite", title: "Zweite", status: "draft", body: "Text DE" }));
    expectOk(await content.update("pages", draftDefault.id, { slug: "second", title: "Second", status: "published" }, { locale: "en" }));

    const renderer = fakeRenderer();
    const delivery = await createDeliveryStatic(config, { content, site: createSiteDefault(content), renderer, blobs: fakeBlobs(), db: createFakePersistence(), logger: fakeLogger() });
    expectOk(await delivery.publish("pages", withDefault.id));
    expectOk(await delivery.publish("pages", draftDefault.id));

    const bySlug = new Map(renderer.documents.map((d) => [d.slug, d]));
    expect(bySlug.get("first")).toMatchObject({ body: "Text DE" });
    expect(bySlug.get("second")).toMatchObject({ body: null });
  });

  it("keeps a locale that fails the filter out of _translations, even with complete fields", async () => {
    const content = await createContentDefault(model, createFakePersistence());
    const doc = expectOk(await content.create("pages", { slug: "dritte", title: "Dritte", status: "published" }));
    expectOk(await content.update("pages", doc.id, { slug: "third", title: "Third", status: "draft" }, { locale: "en" }));

    const renderer = fakeRenderer();
    const delivery = await createDeliveryStatic(config, { content, site: createSiteDefault(content), renderer, blobs: fakeBlobs(), db: createFakePersistence(), logger: fakeLogger() });
    const statuses = expectOk(await delivery.publish("pages", doc.id));
    expect(statuses.map((s) => [s.locale, s.state])).toEqual([["de", "live"], ["en", "draft"]]);
    expect(renderer.documents.find((d) => d.slug === "dritte")?._translations).toEqual({ de: true, en: false });
  });

  it("removes an inherited-slug locale's stale static output once the default locale it inherited from is unpublished", async () => {
    const content = await createContentDefault(model, createFakePersistence());
    const doc = expectOk(await content.create("pages", { slug: "erste", title: "Erste DE", status: "published" }));
    expectOk(await content.update("pages", doc.id, { status: "published" }, { locale: "en" }));

    const blobs = fakeBlobs();
    const delivery = await createDeliveryStatic(config, { content, site: createSiteDefault(content), renderer: fakeRenderer(), blobs, db: createFakePersistence(), logger: fakeLogger() });
    const first = expectOk(await delivery.publish("pages", doc.id));
    expect(first.map((s) => [s.locale, s.state, s.path])).toEqual([["de", "live", "/erste"], ["en", "live", "/en/erste"]]);
    expect([...blobs.blobs.keys()].filter((k) => k.endsWith("index.html")).sort()).toEqual(["site/en/erste/index.html", "site/erste/index.html"]);

    expectOk(await content.update("pages", doc.id, { status: "draft" }));
    const second = expectOk(await delivery.publish("pages", doc.id));
    expect(second.map((s) => [s.locale, s.state, s.path])).toEqual([["de", "draft", null], ["en", "error", null]]);
    expect([...blobs.blobs.keys()].filter((k) => k.endsWith("index.html"))).toEqual([]);
  });

  it("publishes a page that links to a type without the filter's fields instead of failing", async () => {
    const withPosts: ContentModel = {
      locales: ["de", "en"],
      defaultLocale: "de",
      types: {
        ...model.types,
        posts: { kind: "multi", fields: { permalink: { type: "slug", localized: true, required: true }, title: { type: "text", localized: true, required: true } } },
      },
    };
    const content = await createContentDefault(withPosts, createFakePersistence());
    const post = expectOk(await content.create("posts", { permalink: "ein-beitrag", title: "Ein Beitrag" }));
    const doc = expectOk(await content.create("pages", { slug: "mit-fremdlink", title: "Mit Fremdlink", status: "published", body: `<a href="kestrel:posts:${post.id}">Beitrag</a>` }));
    const delivery = await createDeliveryStatic(config, { content, site: createSiteDefault(content), renderer: fakeRenderer(), blobs: fakeBlobs(), db: createFakePersistence(), logger: fakeLogger() });
    const status = expectOk(await delivery.publish("pages", doc.id));
    expect(status.map((s) => [s.locale, s.state])).toEqual([["de", "live"], ["en", "draft"]]);
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

describe("delivery/static: reservedPaths", () => {
  it("rejects a 5.x media config", () => {
    expect(configSchema.safeParse({ ...config, media: { publicPath: "/media" } }).success).toBe(false);
  });

  it("fails a reserved page path without rendering, and keeps the previous live output", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const renderer = fakeRenderer();
    const db = createFakePersistence();
    const reserved = configSchema.parse({ ...config, reservedPaths: ["/media"] });
    const delivery = await createDeliveryStatic(reserved, { content, site, renderer, blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "kontakt", title__de: "Kontakt", status__de: "published", status__en: "published" });
    put("p2", { slug__de: "media", title__de: "Media", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    const before = renderer.calls.length;
    const status = expectOk(await delivery.publish("pages", "p2"));
    expect(status.find((s) => s.locale === "de")).toMatchObject({ state: "error", error: "path /media is reserved (/media)" });
    expect(renderer.calls.length).toBe(before);
  });

  it("does not treat a longer segment as reserved", async () => {
    const { content, put } = fakeContent();
    const db = createFakePersistence();
    const reserved = configSchema.parse({ ...config, reservedPaths: ["/media"] });
    const delivery = await createDeliveryStatic(reserved, { content, site, renderer: fakeRenderer(), blobs: fakeBlobs(), db, logger: fakeLogger() });
    put("p1", { slug__de: "mediax", title__de: "Mediax", status__de: "published" });
    const status = expectOk(await delivery.publish("pages", "p1"));
    expect(status.find((s) => s.locale === "de")).toMatchObject({ state: "live", path: "/mediax" });
  });

  it("fails a renderer asset under a reserved path", async () => {
    const { content, put } = fakeContent();
    const db = createFakePersistence();
    const renderer: Renderer = {
      formats: () => ["html"],
      async render() {
        return ok({ data: "<h1>x</h1>", contentType: "text/html", extension: "html", assets: [{ path: "/media/x.js", data: "1", contentType: "text/javascript" }] });
      },
    };
    const reserved = configSchema.parse({ ...config, reservedPaths: ["/media"] });
    const delivery = await createDeliveryStatic(reserved, { content, site, renderer, blobs: fakeBlobs(), db, logger: fakeLogger() });
    put("p1", { slug__de: "seite", title__de: "Seite", status__de: "published" });
    const status = expectOk(await delivery.publish("pages", "p1"));
    expect(status.find((s) => s.locale === "de")).toMatchObject({ state: "error", error: "asset /media/x.js lies under the reserved path /media" });
  });

  it("a renderer asset under a reserved path leaves the live page as it was, not overwritten", async () => {
    const { content, put } = fakeContent();
    const db = createFakePersistence();
    const blobs = fakeBlobs();
    let reservedAsset = false;
    const renderer: Renderer = {
      formats: () => ["html"],
      async render() {
        return ok({ data: reservedAsset ? "<h1>new</h1>" : "<h1>old</h1>", contentType: "text/html", extension: "html", assets: reservedAsset ? [{ path: "/media/x.js", data: "1", contentType: "text/javascript" }] : [] });
      },
    };
    const reserved = configSchema.parse({ ...config, reservedPaths: ["/media"] });
    const delivery = await createDeliveryStatic(reserved, { content, site, renderer, blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "seite", title__de: "Seite", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    reservedAsset = true;
    const status = expectOk(await delivery.publish("pages", "p1"));
    expect(status.find((s) => s.locale === "de")).toMatchObject({ state: "error", path: "/seite" });
    expect(new TextDecoder().decode(blobs.blobs.get("site/seite/index.html")?.data)).toBe("<h1>old</h1>");
    expect(blobs.blobs.has("site/media/x.js")).toBe(false);
  });
});

describe("delivery/static: rendered output is stored byte for byte, no media rewrite", () => {
  it("stores every spelling of a media reference unchanged", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const id = "11111111-1111-1111-1111-111111111111";
    const html = `<img src="/media/${id}/photo.jpg"><script>var u="\\u002Fmedia\\u002F${id}\\u002Fphoto.jpg";</script><a href="&#x2F;media&#x2F;${id}&#x2F;photo.jpg">x</a>`;
    const delivery = await createDeliveryStatic(config, { content, site, renderer: fakeHtmlRenderer(html), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "seite", title__de: "Seite", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    expect(new TextDecoder().decode(blobs.blobs.get("site/seite/index.html")?.data)).toBe(html);
  });

  it("reads and writes only its own collections, never media_items or images_variants", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const findManySpy = vi.spyOn(db, "findMany");
    const delivery = await createDeliveryStatic(config, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "seite", title__de: "Seite", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    expectOk(await delivery.status("pages", "p1"));
    const collections = new Set(findManySpy.mock.calls.map(([collection]) => collection));
    expect(collections.has(STATUS)).toBe(true);
    expect([...collections].every((c) => c.startsWith("delivery_"))).toBe(true);
  });
});

function failingPutOnce(blobs: ReturnType<typeof fakeBlobs>, matches: (key: string) => boolean): Blobstore {
  return {
    ...blobs,
    async put(key, data, options) {
      if (matches(key)) return err(failure("TRANSIENT", "disk full"));
      return blobs.put(key, data, options);
    },
  };
}

function mismatchedRenderer(): Renderer {
  return {
    formats: () => ["html", "pdf"],
    async render(input) {
      const extension = input.format === "html" ? "htm" : "pdf-doc";
      return ok({ data: `<h1>${String(input.document.title)}</h1>`, contentType: input.format === "pdf" ? "application/pdf" : "text/html", extension });
    },
  };
}

describe("delivery/static: removes exactly the keys it wrote", () => {
  it("a renderer whose extension differs from its format name leaves nothing behind on unpublish", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const delivery = await createDeliveryStatic({ ...config, formats: ["html", "pdf"] }, { content, site, renderer: mismatchedRenderer(), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "seite", title__de: "Seite", status__de: "published", status__en: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    expect([...blobs.blobs.keys()].sort()).toEqual(["site/en/seite/index.htm", "site/en/seite/index.pdf-doc", "site/seite/index.htm", "site/seite/index.pdf-doc"]);
    expect(expectOk(await delivery.unpublish("pages", "p1"))).toBe(2);
    expect(blobs.blobs.size).toBe(0);
  });

  it("removes the real files of a path a rename left, even when the renderer's extension differs from the format name", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const delivery = await createDeliveryStatic({ ...config, formats: ["html"] }, { content, site, renderer: mismatchedRenderer(), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "alt", title__de: "Alt", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    expect(blobs.blobs.has("site/alt/index.htm")).toBe(true);
    put("p1", { slug__de: "neu" });
    expectOk(await delivery.publish("pages", "p1"));
    expect(blobs.blobs.has("site/alt/index.htm")).toBe(false);
    expect(blobs.blobs.has("site/neu/index.htm")).toBe(true);
  });

  it("removes the real files of a locale that stops being published, even when the renderer's extension differs from the format name", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const delivery = await createDeliveryStatic({ ...config, formats: ["html"] }, { content, site, renderer: mismatchedRenderer(), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "seite", title__de: "Seite", status__de: "published", status__en: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    expect(blobs.blobs.has("site/en/seite/index.htm")).toBe(true);
    put("p1", { status__en: "draft" });
    expectOk(await delivery.publish("pages", "p1"));
    expect(blobs.blobs.has("site/en/seite/index.htm")).toBe(false);
    expect(blobs.blobs.has("site/seite/index.htm")).toBe(true);
  });

  it("a republish with a smaller format list removes the keys the previous render wrote but the new one does not", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const wide = await createDeliveryStatic({ ...config, formats: ["html", "pdf"] }, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "seite", title__de: "Seite", status__de: "published" });
    expectOk(await wide.publish("pages", "p1"));
    expect([...blobs.blobs.keys()].sort()).toEqual(["site/_nuxt/app.js", "site/seite/index.html", "site/seite/index.pdf"]);
    const narrow = await createDeliveryStatic({ ...config, formats: ["html"] }, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    expectOk(await narrow.publish("pages", "p1"));
    expect([...blobs.blobs.keys()].sort()).toEqual(["site/_nuxt/app.js", "site/seite/index.html"]);
  });

  it("a row published before written keys were recorded still loses every real file on unpublish", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const delivery = await createDeliveryStatic({ ...config, formats: ["html", "pdf"] }, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "seite", title__de: "Seite", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    const before = expectOk(await db.findOne<{ id: string }>(STATUS, { type: "pages", docId: "p1", locale: "de" }));
    expectOk(await db.updateMany(STATUS, { id: before!.id }, { writtenKeys: null }));
    expect(expectOk(await db.findOne<{ id: string; writtenKeys: Record<string, string> | null }>(STATUS, { id: before!.id }))?.writtenKeys).toBeNull();
    expect(expectOk(await delivery.unpublish("pages", "p1"))).toBe(2);
    expect(blobs.blobs.has("site/seite/index.html")).toBe(false);
    expect(blobs.blobs.has("site/seite/index.pdf")).toBe(false);
  });

  it("never removes a key another live output still owns at the same path, even while dropping keys its own re-render no longer writes", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const wide = await createDeliveryStatic({ ...config, formats: ["html", "pdf"] }, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "seite", title__de: "Seite Eins", status__de: "published" });
    expectOk(await wide.publish("pages", "p1"));
    put("p2", { slug__de: "seite", title__de: "Seite Zwei", status__de: "published" });
    expectOk(await wide.publish("pages", "p2"));
    expect(blobs.blobs.has("site/seite/index.pdf")).toBe(true);
    const narrow = await createDeliveryStatic({ ...config, formats: ["html"] }, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    expectOk(await narrow.publish("pages", "p1"));
    expect(blobs.blobs.has("site/seite/index.pdf")).toBe(true);
  });

  it("never deletes another live output's file when a row's recorded keys point at a path it no longer has", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const delivery = await createDeliveryStatic({ ...config, formats: ["html"] }, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    put("a", { slug__de: "x", title__de: "A", status__de: "published" });
    expectOk(await delivery.publish("pages", "a"));
    expect(blobs.blobs.has("site/x/index.html")).toBe(true);

    put("a", { slug__de: "y" });
    const rowA = expectOk(await db.findOne<{ id: string }>(STATUS, { type: "pages", docId: "a", locale: "de" }))!;
    expectOk(await db.updateMany(STATUS, { id: rowA.id }, { path: "/y" }));

    put("c", { slug__de: "x", title__de: "C", status__de: "published" });
    expectOk(await delivery.publish("pages", "c"));
    expect(blobs.blobs.has("site/x/index.html")).toBe(true);

    expectOk(await delivery.publish("pages", "a"));
    expect(blobs.blobs.has("site/y/index.html")).toBe(true);
    expect(blobs.blobs.has("site/x/index.html")).toBe(true);
  });

  it("exports llms-full.txt from the real stored file even when the renderer's extension differs from the format name", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const renderer: Renderer = {
      formats: () => ["html"],
      async render() {
        return ok({ data: "<main>Rendered body text</main>", contentType: "text/html", extension: "htm" });
      },
    };
    const withFull = configSchema.parse({ ...config, formats: ["html"], llms: { full: true } });
    const delivery = await createDeliveryStatic(withFull, { content, site, renderer, blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "seite", title__de: "Seite", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    expect(blobs.blobs.has("site/seite/index.htm")).toBe(true);
    expectOk(await delivery.exportLlms());
    const full = blobs.blobs.get("site/llms-full.txt");
    expect(full).toBeDefined();
    expect(new TextDecoder().decode(full!.data)).toContain("Rendered body text");
  });

  it("removes a first render's earlier-written files when a later format's write fails", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const failingBlobs = failingPutOnce(blobs, (key) => key.endsWith(".pdf"));
    const db = createFakePersistence();
    const delivery = await createDeliveryStatic({ ...config, formats: ["html", "pdf"] }, { content, site, renderer: fakeRenderer(), blobs: failingBlobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "seite", title__de: "Seite", status__de: "published" });
    const status = expectOk(await delivery.publish("pages", "p1"));
    expect(status.find((s) => s.locale === "de")).toMatchObject({ state: "error" });
    expect(blobs.blobs.has("site/seite/index.html")).toBe(false);
  });

  it("removes a rename's partly written new-path files when a later format's write fails, keeping the old output live", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const delivery = await createDeliveryStatic({ ...config, formats: ["html", "pdf"] }, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "alt", title__de: "Alt", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    expect(blobs.blobs.has("site/alt/index.html")).toBe(true);
    expect(blobs.blobs.has("site/alt/index.pdf")).toBe(true);

    const failingBlobs = failingPutOnce(blobs, (key) => key === "site/neu/index.pdf");
    const delivery2 = await createDeliveryStatic({ ...config, formats: ["html", "pdf"] }, { content, site, renderer: fakeRenderer(), blobs: failingBlobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "neu" });
    const status = expectOk(await delivery2.publish("pages", "p1"));
    expect(status.find((s) => s.locale === "de")).toMatchObject({ state: "error", path: "/alt" });
    expect(blobs.blobs.has("site/alt/index.html")).toBe(true);
    expect(blobs.blobs.has("site/alt/index.pdf")).toBe(true);
    expect(blobs.blobs.has("site/neu/index.html")).toBe(false);
    expect(blobs.blobs.has("site/neu/index.pdf")).toBe(false);
  });

  it("a same-path format shrink does not mark the page's own output stale", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const wide = await createDeliveryStatic({ ...config, formats: ["html", "pdf"] }, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "seite", title__de: "Seite", status__de: "published" });
    expectOk(await wide.publish("pages", "p1"));
    const narrow = await createDeliveryStatic({ ...config, formats: ["html"] }, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    const status = expectOk(await narrow.publish("pages", "p1"));
    expect(status.find((s) => s.locale === "de")).toMatchObject({ state: "live", stale: false });
  });

  it("keeps its own recorded key after a raw path move and back, so llms-full.txt reads its own body", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const renderer: Renderer = {
      formats: () => ["html"],
      async render() {
        return ok({ data: "<main>A's own body</main>", contentType: "text/html", extension: "html" });
      },
    };
    const withFull = configSchema.parse({ ...config, formats: ["html"], llms: { full: true } });
    const delivery = await createDeliveryStatic(withFull, { content, site, renderer, blobs, db, logger: fakeLogger() });
    put("a", { slug__de: "x", title__de: "A", status__de: "published" });
    expectOk(await delivery.publish("pages", "a"));
    expect(blobs.blobs.has("site/x/index.html")).toBe(true);

    const rowA = expectOk(await db.findOne<{ id: string }>(STATUS, { type: "pages", docId: "a", locale: "de" }))!;
    expectOk(await db.updateMany(STATUS, { id: rowA.id }, { path: "/y" }));

    expectOk(await delivery.publish("pages", "a"));
    expect(blobs.blobs.has("site/x/index.html")).toBe(true);

    expectOk(await delivery.exportLlms());
    const full = blobs.blobs.get("site/llms-full.txt");
    expect(full).toBeDefined();
    expect(new TextDecoder().decode(full!.data)).toContain("A's own body");
  });

  it("unpublish of a row moved by an older process removes its files at its current path", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const delivery = await createDeliveryStatic({ ...config, formats: ["html"] }, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    put("a", { slug__de: "x", title__de: "A", status__de: "published" });
    expectOk(await delivery.publish("pages", "a"));
    const rowA = expectOk(await db.findOne<{ id: string }>(STATUS, { type: "pages", docId: "a", locale: "de" }))!;
    blobs.blobs.delete("site/x/index.html");
    blobs.blobs.set("site/y/index.html", { data: new TextEncoder().encode("<h1>A</h1>"), contentType: "text/html" });
    expectOk(await db.updateMany(STATUS, { id: rowA.id }, { path: "/y" }));

    expect(expectOk(await delivery.unpublish("pages", "a"))).toBe(2);
    expect(blobs.blobs.has("site/y/index.html")).toBe(false);
  });

  it("removing a path's files never touches a key recorded under a different path, even if it slipped into the same row's map", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const db = createFakePersistence();
    const delivery = await createDeliveryStatic({ ...config, formats: ["html"] }, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    put("z", { slug__de: "z", title__de: "Z", status__de: "published" });
    expectOk(await delivery.publish("pages", "z"));
    expect(blobs.blobs.has("site/z/index.html")).toBe(true);

    put("a", { slug__de: "x", title__de: "A", status__de: "published" });
    expectOk(await delivery.publish("pages", "a"));
    const rowA = expectOk(await db.findOne<{ id: string }>(STATUS, { type: "pages", docId: "a", locale: "de" }))!;
    expectOk(await db.updateMany(STATUS, { id: rowA.id }, { writtenKeys: { html: "site/x/index.html", stray: "site/z/index.html" } }));

    expect(expectOk(await delivery.unpublish("pages", "a"))).toBe(2);
    expect(blobs.blobs.has("site/x/index.html")).toBe(false);
    expect(blobs.blobs.has("site/z/index.html")).toBe(true);
  });

  it("a transient failure checking ownership of a failed render's new path is logged, not returned, since the status write already succeeded", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const fake = createFakePersistence();
    let failNextCount = false;
    const db: Persistence = {
      ...fake,
      count: (collection, filter) => {
        if (failNextCount && collection === STATUS) {
          failNextCount = false;
          return Promise.resolve(err(failure("TRANSIENT", "store busy")));
        }
        return fake.count(collection, filter);
      },
    };
    const delivery = await createDeliveryStatic({ ...config, formats: ["html", "pdf"] }, { content, site, renderer: fakeRenderer(), blobs, db, logger: fakeLogger() });
    put("p1", { slug__de: "alt", title__de: "Alt", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    put("p1", { slug__de: "neu" });
    const failingBlobs = failingPutOnce(blobs, (key) => key === "site/neu/index.pdf");
    const delivery2 = await createDeliveryStatic({ ...config, formats: ["html", "pdf"] }, { content, site, renderer: fakeRenderer(), blobs: failingBlobs, db, logger: fakeLogger() });
    failNextCount = true;
    const status = expectOk(await delivery2.publish("pages", "p1"));
    expect(status.find((s) => s.locale === "de")).toMatchObject({ state: "error", path: "/alt" });
  });
});

describe("rewriteMedia (pure), removed", () => {
  it("rewriteMedia is no longer exported from ./impl", async () => {
    const impl = await import("./impl.ts");
    expect(Reflect.has(impl, "rewriteMedia")).toBe(false);
    expect(Reflect.has(impl, "MediaMatch")).toBe(false);
    expect(Reflect.has(impl, "contentTypeByExtension")).toBe(false);
  });
});

