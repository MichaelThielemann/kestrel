import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentDocument, ContentError, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { err, failure, isErr, ok, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import { renderFailed } from "@michaelthielemann/kestrel-contracts/helpers/renderer";
import type { Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createSiteDefault, createSitePaths, routesConfig } from "@michaelthielemann/kestrel-site-default/impl";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { createDeliveryStatic, type Delivery } from "./impl.ts";
import { configSchema } from "./module.ts";

const GOLDEN = join(import.meta.dirname, "__fixtures__", "index-files");

const model: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, localized: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], localized: true },
        seo: { type: "json", localized: true },
        body: { type: "richtext", localized: true },
        parent: { type: "ref", to: "pages" },
      },
    },
    posts: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, localized: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], localized: true },
        seo: { type: "json", localized: true },
        body: { type: "richtext", localized: true },
      },
    },
    events: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, localized: true },
        title: { type: "text", required: true, localized: true },
        visibility: { type: "enum", options: ["hidden", "public"], localized: true },
        seo: { type: "json", localized: true },
        body: { type: "richtext", localized: true },
      },
    },
    settings: { kind: "single", fields: { title: { type: "text", localized: true }, description: { type: "text", localized: true }, mounts: { type: "json" } } },
  },
};

const instances: Delivery[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
});

function memoryBlobs(): Blobstore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async put(key, data) {
      files.set(key, typeof data === "string" ? data : new TextDecoder().decode(data));
      return ok();
    },
    async get(key) {
      const file = files.get(key);
      return ok(file === undefined ? null : new TextEncoder().encode(file));
    },
    async remove(key) {
      files.delete(key);
      return ok();
    },
    async move() {
      throw new Error("not used");
    },
    async list(prefix) {
      return ok([...files].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.length })));
    },
  };
}

const quietEvents: Events = { emit: async () => {}, on: () => () => {} };

const pageRenderer = (failing: ReadonlySet<string>): Renderer => ({
  formats: () => ["html"],
  async render(input) {
    if (failing.has(input.id)) return err(renderFailed("renderer unavailable"));
    const body = typeof input.document.body === "string" ? input.document.body : "";
    return ok({ data: `<html><body><nav>Menü</nav><main><h1>${String(input.document.title)}</h1>${body}</main></body></html>`, contentType: "text/html", extension: "html" });
  },
});

function indexFiles(blobs: { files: Map<string, string> }): Record<string, string> {
  return Object.fromEntries([...blobs.files].filter(([key]) => /^site\/[^/]+\.(txt|xml)$/.test(key)).sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function routedSite(options: { fallback: boolean }) {
  const db = createFakePersistence();
  let clock = Date.UTC(2026, 9, 1, 8);
  const raw = await createContentDefault(model, db, () => (clock += 60_000));
  const paths = await createSitePaths(
    routesConfig({
      routes: {
        pages: { home: "home", liveWhen: { status: "published" }, parentField: "parent" },
        posts: { liveWhen: { status: "published" }, mount: true },
        events: { liveWhen: { visibility: "public" }, mount: true },
      },
      mounts: { type: "settings", field: "mounts" },
    }),
    { content: raw, db, events: quietEvents, logger: silentLogger },
  );
  const grouped = async (write: () => Promise<Result<ContentDocument, ContentError>>, index: (doc: ContentDocument, runId: string) => Promise<Result<unknown, ContentError>>): Promise<Result<ContentDocument, ContentError>> => {
    const runId = randomUUID();
    let answer: Result<ContentDocument, ContentError> = err(failure("TRANSIENT", "not written"));
    const outcome = await db.scope({ pipeline: "test", group: 1 }, async () => {
      answer = await write();
      if (isErr(answer)) return "rollback";
      const indexed = await index(answer.value, runId);
      return isErr(indexed) ? "rollback" : "commit";
    });
    expect(outcome).toEqual({ kind: "settled", verdict: "commit" });
    await paths.announce(runId);
    return answer;
  };
  const content: Content = {
    ...raw,
    create: (type, data, opts) => grouped(() => raw.create(type, data, opts), (doc, runId) => paths.index(type, doc.id, runId, opts?.locale)),
    update: (type, id, patch, opts) => grouped(() => raw.update(type, id, patch, opts), (_doc, runId) => paths.index(type, id, runId, opts?.locale)),
    set: (type, data, opts) => grouped(() => raw.set(type, data, opts), (_doc, runId) => paths.indexMounts(runId)),
  };
  const blobs = memoryBlobs();
  const failing = new Set<string>();
  const config = configSchema.parse({
    types: { pages: { home: "home" }, posts: {}, events: { statusField: "visibility", publishedValue: "public" } },
    prefix: "site/",
    siteUrl: "https://example.org",
    robots: { policy: "allow" },
    fallback: options.fallback,
    llms: { full: true, headings: { pages: "Seiten", posts: "Beiträge", events: "Termine" } },
    dependencies: { render: "events" },
  });
  const delivery = await createDeliveryStatic(config, { content, site: createSiteDefault(raw, paths), renderer: pageRenderer(failing), blobs, db, logger: silentLogger, events: quietEvents });
  instances.push(delivery);

  const save = async (type: string, de: Record<string, unknown>, en?: Record<string, unknown>): Promise<string> => {
    const id = expectOk(await content.create(type, de, { locale: "de" })).id;
    if (en !== undefined) expectOk(await content.update(type, id, en, { locale: "en" }));
    expectOk(await delivery.publish(type, id));
    return id;
  };
  return { content, raw, delivery, failing, save, files: () => indexFiles(blobs) };
}

async function seedRouted(s: Awaited<ReturnType<typeof routedSite>>): Promise<void> {
  await s.save("pages", { slug: "home", title: "Start", status: "published", body: '<p>Willkommen auf der <a href="/kontakt">Startseite</a></p>' }, { slug: "home", title: "Home", status: "published", body: "<p>Welcome</p>" });
  await s.save("pages", { slug: "kontakt", title: "Kontakt", status: "published", seo: { description: "So erreichen Sie uns" }, body: "<p>Telefon und E-Mail</p>" }, { slug: "contact", title: "Contact", status: "published" });
  await s.save("pages", { slug: "intern", title: "Intern", status: "published", seo: { noindex: true } }, { slug: "internal", title: "Internal", status: "published" });
  await s.save("pages", { slug: "angebot", title: "Angebot", status: "published", seo: { title: "Unser Angebot", description: "Preise <und> Leistungen" } }, { slug: "offer", title: "Offer", status: "published", seo: { description: "Prices" } });
  await s.save("pages", { slug: "leistungen", title: "Leistungen", status: "published", seo: { title: "Alle Leistungen" } }, { slug: "services", title: "Services", status: "published" });
  await s.save("pages", { slug: "preise", title: "Preise", status: "published" }, { slug: "prices", status: "published" });
  await s.save("pages", { slug: "neu", title: "Neu", status: "draft" }, { slug: "new", status: "published" });
  await s.save("pages", { slug: "nur-englisch", title: "Nur Englisch", status: "draft", seo: { description: "Noch ein Entwurf" }, body: "<p>Entwurf</p>" }, { slug: "english-only", title: "English only", status: "published" });
  const about = await s.save("pages", { slug: "ueber-uns", title: "Über uns", status: "published" }, { slug: "about", title: "About", status: "published", seo: { noindex: false } });
  await s.save("pages", { slug: "team", title: "Team", status: "published", parent: about, body: "<h2>Wer wir sind</h2><p>Ein kleines Team</p>" }, { slug: "team", title: "Our team", status: "draft" });
  await s.save("pages", { slug: "geschichte", title: "Geschichte", status: "published", parent: about }, { slug: "history", title: "History", status: "published" });
  const stale = await s.save("pages", { slug: "alt", title: "Alt", status: "published" });
  expectOk(await s.content.update("pages", stale, { status: "draft" }, { locale: "de" }));
  const removed = await s.save("pages", { slug: "weg", title: "Weg", status: "published" }, { slug: "gone", title: "Gone", status: "published" });
  expectOk(await s.raw.remove("pages", removed));
  const broken = await s.save("pages", { slug: "kaputt", title: "Kaputt", status: "published" }, { slug: "broken", title: "Broken", status: "published" });
  s.failing.add(broken);
  expectOk(await s.delivery.publish("pages", broken));
  const blog = await s.save("pages", { slug: "blog", title: "Blog", status: "published" }, { slug: "news", title: "News", status: "published" });
  const calendar = await s.save("pages", { slug: "termine", title: "Termine", status: "published" }, { slug: "events", title: "Events", status: "published" });
  expectOk(await s.content.set("settings", { title: "Beispiel & Partner", description: "Alles über das Beispiel", mounts: { posts: blog, events: calendar } }, { locale: "de" }));
  await s.save("posts", { slug: "hallo", title: "Hallo Welt", status: "published", seo: { description: "Ein erster Beitrag" }, body: "<p>Der erste Beitrag</p>" }, { slug: "hello", title: "Hello world", status: "published" });
  await s.save("posts", { slug: "nur-deutsch", title: "Nur Deutsch", status: "published" });
  await s.save("posts", { slug: "geplant", title: "Geplant", status: "draft" }, { slug: "planned", title: "Planned", status: "draft" });
  await s.save("events", { slug: "sommerfest", title: "Sommerfest", visibility: "public", seo: { description: "Im Garten" } }, { slug: "summer-party", title: "Summer party", visibility: "hidden" });
  await s.save("events", { slug: "herbstmarkt", title: "Herbstmarkt", visibility: "hidden", seo: { description: "Noch nicht öffentlich" } }, { slug: "autumn-fair", title: "Autumn fair", visibility: "public" });
  await s.save("events", { slug: "winterkonzert", title: "Winterkonzert", visibility: "public" }, { slug: "winter-concert", title: "Winter concert", visibility: "public" });
}

function golden(variant: string): Record<string, string> {
  const dir = join(GOLDEN, variant);
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [`site/${name}`, readFileSync(join(dir, name), "utf8")]));
}

describe("index files of a multi-locale site", () => {
  for (const [variant, fallback] of [["fallback", true], ["no-fallback", false]] as const) {
    it(`writes the same sitemap.xml, robots.txt, llms.txt and llms-full.txt for pages, subpages, posts and a collection with its own status field, ${fallback ? "filling empty fields from the default locale only where it is published" : "without filling empty fields"}`, async () => {
      const s = await routedSite({ fallback });
      await seedRouted(s);
      expect(expectOk(await s.delivery.exportIndexes()).entries).toBe(fallback ? 30 : 31);
      expect(expectOk(await s.delivery.exportLlmsFull()).entries).toBe(fallback ? 30 : 31);
      expect(s.files()).toEqual(golden(variant));
    });
  }
});

const plainModel: ContentModel = {
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true },
        title: { type: "text", required: true },
        status: { type: "enum", options: ["draft", "published"] },
        seo: { type: "json" },
      },
    },
  },
};

describe("index files of a site without locales", () => {
  it("lists the published pages that are not noindex and skips drafts, rows behind a later draft save and deleted documents", async () => {
    const db = createFakePersistence();
    let clock = Date.UTC(2026, 9, 1, 8);
    const content = await createContentDefault(plainModel, db, () => (clock += 60_000));
    const blobs = memoryBlobs();
    const config = configSchema.parse({ types: { pages: { home: "home" } }, prefix: "site/", siteUrl: "https://example.org", robots: { policy: "allow" }, dependencies: { render: "events" } });
    const delivery = await createDeliveryStatic(config, { content, site: createSiteDefault(content), renderer: pageRenderer(new Set()), blobs, db, logger: silentLogger, events: quietEvents });
    instances.push(delivery);
    const save = async (fields: Record<string, unknown>): Promise<string> => {
      const id = expectOk(await content.create("pages", fields)).id;
      expectOk(await delivery.publish("pages", id));
      return id;
    };
    await save({ slug: "home", title: "Start", status: "published" });
    await save({ slug: "kontakt", title: "Kontakt", status: "published", seo: { title: "Schreiben Sie uns", description: "Adresse & Anfahrt" } });
    await save({ slug: "intern", title: "Intern", status: "published", seo: { noindex: true } });
    await save({ slug: "entwurf", title: "Entwurf", status: "draft" });
    const stale = await save({ slug: "alt", title: "Alt", status: "published" });
    expectOk(await content.update("pages", stale, { status: "draft" }));
    const removed = await save({ slug: "weg", title: "Weg", status: "published" });
    expectOk(await content.remove("pages", removed));
    expect(expectOk(await delivery.exportIndexes())).toEqual({ entries: 2 });
    expect(indexFiles(blobs)).toEqual({
      "site/llms.txt": "# example.org\n\n## pages\n\n- [Start](https://example.org/)\n- [Schreiben Sie uns](https://example.org/kontakt): Adresse & Anfahrt\n",
      "site/robots.txt": "User-agent: *\nAllow: /\n\nSitemap: https://example.org/sitemap.xml\n",
      "site/sitemap.xml": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        "  <url>",
        "    <loc>https://example.org/</loc>",
        "    <lastmod>2026-10-01T08:01:00.000Z</lastmod>",
        "  </url>",
        "  <url>",
        "    <loc>https://example.org/kontakt</loc>",
        "    <lastmod>2026-10-01T08:02:00.000Z</lastmod>",
        "  </url>",
        "</urlset>",
        "",
      ].join("\n"),
    });
  });
});

const singleModel: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: { kind: "multi", fields: { slug: { type: "slug", required: true, localized: true }, title: { type: "text", localized: true }, status: { type: "enum", options: ["draft", "published"], localized: true }, seo: { type: "json", localized: true } } },
    imprint: { kind: "single", fields: { slug: { type: "slug", localized: true }, title: { type: "text", localized: true }, status: { type: "enum", options: ["draft", "published"], localized: true }, seo: { type: "json", localized: true } } },
  },
};

describe("index files with a delivered single type", () => {
  it("lists each published locale of the single document next to the pages, filled from the default locale", async () => {
    const db = createFakePersistence();
    let clock = Date.UTC(2026, 9, 1, 8);
    const content = await createContentDefault(singleModel, db, () => (clock += 60_000));
    const blobs = memoryBlobs();
    const config = configSchema.parse({ types: { pages: { home: "home" }, imprint: {} }, prefix: "site/", siteUrl: "https://example.org", robots: { policy: "allow" }, dependencies: { render: "events" } });
    const delivery = await createDeliveryStatic(config, { content, site: createSiteDefault(content), renderer: pageRenderer(new Set()), blobs, db, logger: silentLogger, events: quietEvents });
    instances.push(delivery);
    const home = expectOk(await content.create("pages", { slug: "home", title: "Start", status: "published" }, { locale: "de" })).id;
    expectOk(await content.update("pages", home, { slug: "home", status: "published" }, { locale: "en" }));
    expectOk(await delivery.publish("pages", home));
    const imprint = expectOk(await content.set("imprint", { slug: "impressum", title: "Impressum", status: "published", seo: { description: "Angaben zum Anbieter" } }, { locale: "de" })).id;
    expectOk(await content.set("imprint", { slug: "imprint", status: "published" }, { locale: "en" }));
    expectOk(await delivery.publish("imprint", imprint));
    expect(expectOk(await delivery.exportIndexes())).toEqual({ entries: 4 });
    expect(indexFiles(blobs)).toEqual({
      "site/llms.txt": "# example.org\n\n## pages\n\n- [Start](https://example.org/)\n- [Start](https://example.org/en)\n\n## imprint\n\n- [Impressum](https://example.org/en/imprint): Angaben zum Anbieter\n- [Impressum](https://example.org/impressum): Angaben zum Anbieter\n",
      "site/robots.txt": "User-agent: *\nAllow: /\n\nSitemap: https://example.org/sitemap.xml\n",
      "site/sitemap.xml": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        "  <url>",
        "    <loc>https://example.org/</loc>",
        "    <lastmod>2026-10-01T08:02:00.000Z</lastmod>",
        '    <xhtml:link rel="alternate" hreflang="de" href="https://example.org/"/>',
        '    <xhtml:link rel="alternate" hreflang="en" href="https://example.org/en"/>',
        '    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.org/"/>',
        "  </url>",
        "  <url>",
        "    <loc>https://example.org/en</loc>",
        "    <lastmod>2026-10-01T08:02:00.000Z</lastmod>",
        '    <xhtml:link rel="alternate" hreflang="de" href="https://example.org/"/>',
        '    <xhtml:link rel="alternate" hreflang="en" href="https://example.org/en"/>',
        '    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.org/"/>',
        "  </url>",
        "  <url>",
        "    <loc>https://example.org/en/imprint</loc>",
        "    <lastmod>2026-10-01T08:04:00.000Z</lastmod>",
        '    <xhtml:link rel="alternate" hreflang="de" href="https://example.org/impressum"/>',
        '    <xhtml:link rel="alternate" hreflang="en" href="https://example.org/en/imprint"/>',
        '    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.org/impressum"/>',
        "  </url>",
        "  <url>",
        "    <loc>https://example.org/impressum</loc>",
        "    <lastmod>2026-10-01T08:04:00.000Z</lastmod>",
        '    <xhtml:link rel="alternate" hreflang="de" href="https://example.org/impressum"/>',
        '    <xhtml:link rel="alternate" hreflang="en" href="https://example.org/en/imprint"/>',
        '    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.org/impressum"/>',
        "  </url>",
        "</urlset>",
        "",
      ].join("\n"),
    });
  });
});
