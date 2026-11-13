import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { err, failure, ok } from "@michaelthielemann/kestrel-contracts/errors";
import type { EventData, Events } from "@michaelthielemann/kestrel-contracts/events";
import { renderFailed } from "@michaelthielemann/kestrel-contracts/helpers/renderer";
import type { Document, FindOptions, NewDocument, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Filter } from "@michaelthielemann/kestrel-contracts/query";
import type { Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createSiteDefault } from "@michaelthielemann/kestrel-site-default/impl";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { INDEXES_STALE, LLMS_STALE, STATE, STATUS, createDeliveryStatic, markerKeyFor, type Delivery, type StatusRow } from "./impl.ts";
import { buildRobotsTxt, buildSitemapXml, dedupeEntries, normalizeSiteUrl, pageUrl, sitemapUrls, type IndexEntry } from "./indexes.ts";
import { configSchema } from "./module.ts";

describe("site URL normalisation", () => {
  it("keeps a base path, strips trailing slashes, lower-cases the host and drops a default port", () => {
    expect(normalizeSiteUrl("https://Example.org/")).toBe("https://example.org");
    expect(normalizeSiteUrl("https://example.org:443/de/")).toBe("https://example.org/de");
    expect(normalizeSiteUrl(" http://127.0.0.1:4000 ")).toBe("http://127.0.0.1:4000");
    expect(normalizeSiteUrl("https://example.org/a/b//")).toBe("https://example.org/a/b");
  });

  it("refuses relative URLs, other schemes, credentials, queries and fragments", () => {
    for (const bad of ["example.org", "/de", "ftp://example.org", "https://user:pw@example.org", "https://example.org/?a=1", "https://example.org/#top"]) expect(() => normalizeSiteUrl(bad), bad).toThrow();
  });

  it("gives the home page a trailing slash and every other page none, so a sitemap loc equals the canonical URL", () => {
    const siteUrl = normalizeSiteUrl("https://Example.org/base/");
    expect(pageUrl(siteUrl, "/")).toBe("https://example.org/base/");
    expect(pageUrl(siteUrl, "/en/contact")).toBe("https://example.org/base/en/contact");
    expect(pageUrl(undefined, "/kontakt")).toBe("/kontakt");
  });
});

function entry(fields: Partial<IndexEntry> & Pick<IndexEntry, "docId" | "locale" | "path">): IndexEntry {
  return { rowId: `pages/${fields.docId}/${fields.locale}`, type: "pages", state: "live", url: `https://example.org${fields.path}`, title: fields.path, updatedAt: 0, html: async () => ok(null), ...fields };
}

describe("sitemap and robots builders", () => {
  it("writes absolute locs sorted, escapes XML, and gives lastmod only to live entries", () => {
    const xml = buildSitemapXml([{ loc: "https://example.org/b?x=1&y=<2>" }, { loc: "https://example.org/a", lastmod: Date.UTC(2026, 10, 1, 12) }]);
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        "  <url>",
        "    <loc>https://example.org/a</loc>",
        "    <lastmod>2026-11-01T12:00:00.000Z</lastmod>",
        "  </url>",
        "  <url>",
        "    <loc>https://example.org/b?x=1&amp;y=&lt;2&gt;</loc>",
        "  </url>",
        "</urlset>",
        "",
      ].join("\n"),
    );
    expect(buildSitemapXml([])).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n</urlset>\n');
  });

  it("lists every locale of a document as an alternate of each other, plus x-default for the default locale, and leaves lastmod out for error rows", () => {
    const urls = sitemapUrls([entry({ docId: "a", locale: "de", path: "/kontakt", updatedAt: 5 }), entry({ docId: "a", locale: "en", path: "/en/contact", state: "error", updatedAt: 5 }), entry({ docId: "b", locale: "en", path: "/en/only", updatedAt: 7 })], "de");
    const alternates = [
      { hreflang: "de", href: "https://example.org/kontakt" },
      { hreflang: "en", href: "https://example.org/en/contact" },
      { hreflang: "x-default", href: "https://example.org/kontakt" },
    ];
    expect(urls).toEqual([
      { loc: "https://example.org/kontakt", lastmod: 5, alternates },
      { loc: "https://example.org/en/contact", alternates },
      { loc: "https://example.org/en/only", lastmod: 7 },
    ]);
  });

  it("keeps one entry per URL, the live row first and then the lower row id", () => {
    const live = entry({ docId: "b", locale: "de", path: "/x", rowId: "z" });
    const failed = entry({ docId: "a", locale: "de", path: "/x", rowId: "a", state: "error" });
    expect(dedupeEntries([failed, live, entry({ docId: "c", locale: "de", path: "/a" })]).map((e) => [e.path, e.docId])).toEqual([
      ["/a", "c"],
      ["/x", "b"],
    ]);
    expect(dedupeEntries([entry({ docId: "b", locale: "de", path: "/x", rowId: "b" }), entry({ docId: "a", locale: "de", path: "/x", rowId: "a" })]).map((e) => e.docId)).toEqual(["a"]);
  });

  it("writes robots.txt for both policies, with extra lines and a Sitemap line only when a sitemap is written", () => {
    expect(buildRobotsTxt({ policy: "allow", extra: ["Disallow: /api/"], sitemapUrl: "https://example.org/sitemap.xml" })).toBe("User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: https://example.org/sitemap.xml\n");
    expect(buildRobotsTxt({ policy: "disallow", extra: [] })).toBe("User-agent: *\nDisallow: /\n");
  });
});

describe("index file config", () => {
  it("defaults to a sitemap, no robots policy and no extra lines", () => {
    const parsed = configSchema.parse({ types: {} });
    expect(parsed.sitemap).toBe(true);
    expect(parsed.robots).toEqual({ extra: [] });
    expect(parsed.siteUrl).toBeUndefined();
  });

  it("takes siteUrl at the top level only and validates it", () => {
    expect(configSchema.safeParse({ types: {}, siteUrl: "https://example.org/base/" }).success).toBe(true);
    expect(configSchema.safeParse({ types: {}, siteUrl: "example.org" }).success).toBe(false);
    expect(configSchema.safeParse({ types: {}, siteUrl: "https://example.org/?a" }).success).toBe(false);
    const nested = configSchema.safeParse({ types: {}, llms: { siteUrl: "https://example.org" } });
    expect(nested.success).toBe(false);
    expect(JSON.stringify(nested.error?.issues)).toContain("siteUrl");
  });

  it("refuses a robots line with a line break and an unknown policy", () => {
    expect(configSchema.safeParse({ types: {}, robots: { extra: ["Disallow: /a\nAllow: /"] } }).success).toBe(false);
    expect(configSchema.safeParse({ types: {}, robots: { policy: "maybe" } }).success).toBe(false);
  });
});

const model: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, unique: true, localized: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], localized: true },
        seo: { type: "json", localized: true },
      },
    },
    settings: { kind: "single", fields: { title: { type: "text", localized: true }, description: { type: "text", localized: true } } },
  },
};

interface Files extends Blobstore {
  files: Map<string, { text: string; contentType: string }>;
  puts: string[];
  failPut: Set<string>;
  onPut?: (key: string, text: string) => Promise<void>;
}

function memoryBlobs(): Files {
  const files = new Map<string, { text: string; contentType: string }>();
  const puts: string[] = [];
  const failPut = new Set<string>();
  const store: Files = {
    files,
    puts,
    failPut,
    async put(key, data, options) {
      if (failPut.has(key)) return err(failure("TRANSIENT", `cannot write ${key}`));
      puts.push(key);
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      await store.onPut?.(key, text);
      files.set(key, { text, contentType: options?.contentType ?? "application/octet-stream" });
      return ok();
    },
    async get(key) {
      const file = files.get(key);
      return ok(file === undefined ? null : new TextEncoder().encode(file.text));
    },
    async remove(key) {
      files.delete(key);
      return ok();
    },
    async move() {
      throw new Error("n/a");
    },
    async list(prefix) {
      return ok([...files].filter(([k]) => k.startsWith(prefix)).map(([key, f]) => ({ key, size: f.text.length })));
    },
  };
  return store;
}

function recordingLogger(): Logger & { errors: string[]; warnings: string[]; infos: Array<{ message: string; data?: Record<string, unknown> }> } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: Array<{ message: string; data?: Record<string, unknown> }> = [];
  return {
    errors,
    warnings,
    infos,
    step() {},
    info(message, data) {
      infos.push({ message, ...(data === undefined ? {} : { data }) });
    },
    error(message) {
      errors.push(message);
    },
    warn(message) {
      warnings.push(message);
    },
  };
}

interface Options {
  config?: Record<string, unknown>;
  nodeEnv?: string;
  db?: Persistence;
  content?: Content;
  blobs?: Files;
  render?: "events" | "background";
  clock?: { t: number };
  delay?: (ms: number) => Promise<void>;
}

const instances: Delivery[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
});

async function harness(options: Options = {}) {
  const db = options.db ?? createFakePersistence();
  const content = options.content ?? (await createContentDefault(model, db));
  const site = createSiteDefault(content);
  const blobs = options.blobs ?? memoryBlobs();
  const state = { down: false, held: undefined as Promise<void> | undefined, renders: 0 };
  const renderer: Renderer = {
    formats: () => ["html"],
    async render(input) {
      state.renders += 1;
      if (state.held !== undefined && input.path !== "/neu") await state.held;
      if (state.down) return err(renderFailed("renderer unavailable"));
      return ok({ data: `<html><body><main><h1>${String(input.document.title)}</h1></main></body></html>`, contentType: "text/html", extension: "html" });
    },
  };
  const emitted: Array<{ name: string; data: EventData }> = [];
  const events: Events = {
    async emit(name, data) {
      emitted.push({ name, data });
    },
    on: () => () => {},
  };
  const logger = recordingLogger();
  let offset = 0;
  const config = configSchema.parse({ types: { pages: { home: "home" } }, prefix: "site/", siteUrl: "https://example.org", robots: { policy: "allow" }, dependencies: { render: options.render ?? "events" }, ...options.config });
  const clock = options.clock;
  const delivery = await createDeliveryStatic(config, { content, site, renderer, blobs, db, logger, events, delay: options.delay ?? (async () => {}), ...(options.nodeEnv === undefined ? {} : { nodeEnv: options.nodeEnv }) }, clock === undefined ? () => Date.now() + offset : () => clock.t);
  instances.push(delivery);
  const page = async (de: Record<string, unknown>, en?: Record<string, unknown>): Promise<string> => {
    const id = expectOk(await content.create("pages", de, { locale: "de" })).id;
    if (en !== undefined) expectOk(await content.update("pages", id, en, { locale: "en" }));
    expectOk(await delivery.publish("pages", id));
    return id;
  };
  const text = (name: string): string | undefined => blobs.files.get(`site/${name}`)?.text;
  return {
    db,
    content,
    blobs,
    delivery,
    emitted,
    logger,
    state,
    page,
    text,
    advance(ms: number) {
      offset += ms;
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function seed(h: Harness) {
  expectOk(await h.content.set("settings", { title: "Meine Company GmbH & Co KG", description: "Alles über uns" }, { locale: "de" }));
  const home = await h.page({ slug: "home", title: "Start", status: "published" }, { slug: "home", title: "Home", status: "published" });
  const kontakt = await h.page({ slug: "kontakt", title: "Kontakt", status: "published", seo: { description: "So erreichen Sie uns" } }, { slug: "contact", title: "Contact", status: "published" });
  const intern = await h.page({ slug: "intern", title: "Intern", status: "published", seo: { noindex: true } });
  const entwurf = await h.page({ slug: "entwurf", title: "Entwurf", status: "draft" });
  return { home, kontakt, intern, entwurf };
}

const SITEMAP_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" elementFormDefault="qualified">
  <xsd:import namespace="http://www.w3.org/1999/xhtml" schemaLocation="xhtml-link.xsd"/>
  <xsd:simpleType name="tLoc"><xsd:restriction base="xsd:anyURI"><xsd:minLength value="12"/><xsd:maxLength value="2048"/></xsd:restriction></xsd:simpleType>
  <xsd:simpleType name="tLastmod"><xsd:union memberTypes="xsd:date xsd:dateTime"/></xsd:simpleType>
  <xsd:element name="urlset">
    <xsd:complexType>
      <xsd:sequence>
        <xsd:element name="url" maxOccurs="unbounded">
          <xsd:complexType>
            <xsd:sequence>
              <xsd:element name="loc" type="tLoc"/>
              <xsd:element name="lastmod" type="tLastmod" minOccurs="0"/>
              <xsd:any namespace="##other" processContents="strict" minOccurs="0" maxOccurs="unbounded"/>
            </xsd:sequence>
          </xsd:complexType>
        </xsd:element>
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>
</xsd:schema>
`;

const XHTML_LINK_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="http://www.w3.org/1999/xhtml" elementFormDefault="qualified">
  <xsd:element name="link">
    <xsd:complexType>
      <xsd:attribute name="rel" type="xsd:string" use="required"/>
      <xsd:attribute name="hreflang" type="xsd:string" use="required"/>
      <xsd:attribute name="href" type="xsd:anyURI" use="required"/>
    </xsd:complexType>
  </xsd:element>
</xsd:schema>
`;

function locs(xml: string | undefined): string[] {
  return [...(xml ?? "").matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1] ?? "");
}

describe("delivery.exportIndexes", () => {
  it("writes sitemap.xml with absolute locs, symmetric hreflang and x-default, and no noindex page or draft", async () => {
    const h = await harness();
    await seed(h);
    expect(expectOk(await h.delivery.exportIndexes())).toEqual({ entries: 4 });
    const xml = h.text("sitemap.xml");
    expect(h.blobs.files.get("site/sitemap.xml")?.contentType).toBe("application/xml; charset=utf-8");
    expect(locs(xml)).toEqual(["https://example.org/", "https://example.org/en", "https://example.org/en/contact", "https://example.org/kontakt"]);
    const kontakt = xml!.slice(xml!.indexOf("<loc>https://example.org/kontakt</loc>"));
    expect(kontakt).toMatch(/^<loc>https:\/\/example\.org\/kontakt<\/loc>\n {4}<lastmod>\d{4}-\d\d-\d\dT[\d:.]+Z<\/lastmod>\n {4}<xhtml:link rel="alternate" hreflang="de" href="https:\/\/example\.org\/kontakt"\/>\n {4}<xhtml:link rel="alternate" hreflang="en" href="https:\/\/example\.org\/en\/contact"\/>\n {4}<xhtml:link rel="alternate" hreflang="x-default" href="https:\/\/example\.org\/kontakt"\/>/);
    expect(xml).not.toContain("intern");
    expect(xml).not.toContain("entwurf");
    expect(h.text("robots.txt")).toBe("User-agent: *\nAllow: /\n\nSitemap: https://example.org/sitemap.xml\n");
    expect(h.blobs.files.get("site/robots.txt")?.contentType).toBe("text/plain; charset=utf-8");
    expect(h.text("llms.txt")).toBe(
      ["# Meine Company GmbH & Co KG", "", "> Alles über uns", "", "## pages", "", "- [Start](https://example.org/)", "- [Home](https://example.org/en)", "- [Contact](https://example.org/en/contact): So erreichen Sie uns", "- [Kontakt](https://example.org/kontakt): So erreichen Sie uns", ""].join("\n"),
    );
  });

  it("keeps pages whose last render failed in sitemap.xml and llms.txt, without lastmod, so a renderer outage empties nothing", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.delivery.exportIndexes());
    const before = { sitemap: locs(h.text("sitemap.xml")), llms: h.text("llms.txt") };
    h.state.down = true;
    for (const id of [ids.home, ids.kontakt, ids.intern]) expectOk(await h.delivery.publish("pages", id));
    expect(expectOk(await h.db.count(STATUS, { state: "error" }))).toBe(5);
    expect(expectOk(await h.delivery.exportIndexes())).toEqual({ entries: 4 });
    expect(locs(h.text("sitemap.xml"))).toEqual(before.sitemap);
    expect(h.text("sitemap.xml")).not.toContain("<lastmod>");
    expect(h.text("llms.txt")).toBe(before.llms);
  });

  it("writes neither sitemap.xml nor llms.txt while published documents have no rendered output, but still writes robots.txt", async () => {
    const h = await harness();
    h.state.down = true;
    await seed(h);
    expect(expectOk(await h.db.count(STATUS, { state: "live" }))).toBe(0);
    expect(expectOk(await h.delivery.exportIndexes())).toEqual({ entries: 0 });
    expect(h.text("sitemap.xml")).toBeUndefined();
    expect(h.text("llms.txt")).toBeUndefined();
    expect(h.text("robots.txt")).toBe("User-agent: *\nAllow: /\n");
    expect(h.logger.warnings).toContain("delivery/static: published documents exist but none has a rendered output yet; sitemap.xml and llms.txt are left as they are");
    expect(expectOk(await h.delivery.readStaleStatus()).exports.indexes).toMatchObject({ entries: 0, error: null, skipped: true });
  });

  it("keeps the Sitemap line while published documents have no rendered output when an earlier sitemap.xml is still there, and with sitemap: false leaves a sitemap.xml and an llms-full.txt it did not write alone", async () => {
    const blobs = memoryBlobs();
    for (const name of ["sitemap.xml", "llms-full.txt"]) blobs.files.set(`site/${name}`, { text: "old", contentType: "text/plain" });
    const h = await harness({ blobs });
    h.state.down = true;
    await seed(h);
    expectOk(await h.delivery.exportIndexes());
    expect(h.text("robots.txt")).toBe("User-agent: *\nAllow: /\n\nSitemap: https://example.org/sitemap.xml\n");
    expect(h.text("sitemap.xml")).toBe("old");
    expect(h.text("llms-full.txt")).toBe("old");
    const off = await harness({ blobs, config: { sitemap: false } });
    off.state.down = true;
    await seed(off);
    expectOk(await off.delivery.exportIndexes());
    expect(off.text("sitemap.xml")).toBe("old");
    expect(off.text("robots.txt")).toBe("User-agent: *\nAllow: /\n");
    off.state.down = false;
    expectOk(await off.delivery.publishAll("pages"));
    expectOk(await off.delivery.exportIndexes());
    expect(off.text("sitemap.xml")).toBe("old");
  });

  it("records a regular export as not skipped", async () => {
    const h = await harness();
    await seed(h);
    expectOk(await h.delivery.exportIndexes());
    expect(expectOk(await h.delivery.readStaleStatus()).exports.indexes).toMatchObject({ entries: 4, error: null, skipped: false });
  });

  it("with robots: false neither writes nor removes robots.txt, and does not warn about a policy", async () => {
    const blobs = memoryBlobs();
    blobs.files.set("site/robots.txt", { text: "User-agent: *\nAllow: /own\n", contentType: "text/plain" });
    const h = await harness({ blobs, nodeEnv: "staging", config: { robots: false } });
    expect(h.logger.warnings).toEqual([]);
    await seed(h);
    expectOk(await h.delivery.exportIndexes());
    expect(h.text("robots.txt")).toBe("User-agent: *\nAllow: /own\n");
    expect(h.text("sitemap.xml")).toContain("<urlset");
  });

  it.skipIf(spawnSync("xmllint", ["--version"]).error !== undefined)("writes only sitemap.xml files that the sitemap 0.9 schema with xhtml:link alternates accepts, and none for a site with no listed page", async () => {
    const seeded = await harness();
    await seed(seeded);
    expectOk(await seeded.delivery.exportIndexes());
    const noindex = await harness();
    await noindex.page({ slug: "home", title: "Start", status: "published", seo: { noindex: true } });
    expectOk(await noindex.delivery.exportIndexes());
    const nothing = await harness();
    expectOk(await nothing.delivery.exportIndexes());
    const dir = mkdtempSync(join(tmpdir(), "delivery-sitemap-"));
    try {
      writeFileSync(join(dir, "xhtml-link.xsd"), XHTML_LINK_XSD);
      writeFileSync(join(dir, "sitemap.xsd"), SITEMAP_XSD);
      for (const h of [seeded, noindex, nothing]) {
        const xml = h.text("sitemap.xml");
        if (xml === undefined) continue;
        writeFileSync(join(dir, "sitemap.xml"), xml);
        expect(() => execFileSync("xmllint", ["--noout", "--schema", join(dir, "sitemap.xsd"), join(dir, "sitemap.xml")], { stdio: "pipe" })).not.toThrow();
      }
      expect(seeded.text("sitemap.xml")).toBeDefined();
      expect(noindex.text("sitemap.xml")).toBeUndefined();
      expect(nothing.text("sitemap.xml")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes sitemap.xml and leaves the Sitemap line out for a site whose every page is noindex, and still writes robots.txt", async () => {
    const blobs = memoryBlobs();
    blobs.files.set("site/sitemap.xml", { text: "old", contentType: "application/xml" });
    const h = await harness({ blobs });
    await h.page({ slug: "home", title: "Start", status: "published", seo: { noindex: true } });
    expect(expectOk(await h.delivery.exportIndexes())).toEqual({ entries: 0 });
    expect(h.text("sitemap.xml")).toBeUndefined();
    expect(h.text("robots.txt")).toBe("User-agent: *\nAllow: /\n");
  });

  it("writes no sitemap.xml for a site with nothing published yet", async () => {
    const h = await harness();
    expect(expectOk(await h.delivery.exportIndexes())).toEqual({ entries: 0 });
    expect(h.text("sitemap.xml")).toBeUndefined();
    expect(h.text("robots.txt")).toBe("User-agent: *\nAllow: /\n");
  });

  it("without siteUrl writes no sitemap, leaves one it did not write, leaves the Sitemap line out and warns once at setup", async () => {
    const blobs = memoryBlobs();
    blobs.files.set("site/sitemap.xml", { text: "old", contentType: "application/xml" });
    const h = await harness({ blobs, config: { siteUrl: undefined } });
    expect(h.logger.warnings).toEqual(["delivery/static: no siteUrl is set, so no sitemap.xml is written and llms.txt lists paths instead of URLs"]);
    await seed(h);
    expectOk(await h.delivery.exportIndexes());
    expect(h.text("sitemap.xml")).toBe("old");
    expect(h.text("robots.txt")).toBe("User-agent: *\nAllow: /\n");
    expect(h.text("llms.txt")).toContain("- [Kontakt](/kontakt)");
    expect((await harness({ config: { siteUrl: undefined, sitemap: false } })).logger.warnings).toEqual([]);
  });

  it("without siteUrl removes a sitemap.xml an earlier export with siteUrl wrote, also after a restart", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const before = await harness({ db, blobs });
    await seed(before);
    expectOk(await before.delivery.exportIndexes());
    expect(before.text("sitemap.xml")).toContain("<urlset");
    await before.delivery.close();
    const after = await harness({ db, blobs, content: before.content, config: { siteUrl: undefined } });
    expectOk(await after.delivery.exportIndexes());
    expect(after.text("sitemap.xml")).toBeUndefined();
    blobs.files.set("site/sitemap.xml", { text: "own", contentType: "application/xml" });
    const later = await harness({ db, blobs, content: before.content, config: { siteUrl: undefined } });
    expectOk(await later.delivery.exportIndexes());
    expect(later.text("sitemap.xml")).toBe("own");
  });

  it("warns at setup that a robots.txt under a base path of siteUrl is not read by crawlers", async () => {
    const h = await harness({ config: { siteUrl: "https://staging.example.org/firma" } });
    expect(h.logger.warnings).toEqual(["delivery/static: siteUrl has the base path /firma, so robots.txt is served at https://staging.example.org/firma/robots.txt, where crawlers do not look; serve a robots.txt at the root of the host"]);
    expect((await harness({ config: { siteUrl: "https://staging.example.org/firma", robots: false } })).logger.warnings).toEqual([]);
  });

  it("keeps a base path of siteUrl in every URL and takes the llms.txt fallback name from its host", async () => {
    const h = await harness({ config: { siteUrl: "https://Example.org/firma/" } });
    await h.page({ slug: "kontakt", title: "Kontakt", status: "published" });
    expectOk(await h.delivery.exportIndexes());
    expect(locs(h.text("sitemap.xml"))).toEqual(["https://example.org/firma/kontakt"]);
    expect(h.text("robots.txt")).toContain("Sitemap: https://example.org/firma/sitemap.xml");
    expect(h.text("llms.txt")).toBe("# example.org\n\n## pages\n\n- [Kontakt](https://example.org/firma/kontakt)\n");
  });

  it("picks the robots.txt policy from NODE_ENV when none is set, warns at setup, and rewrites robots.txt after a restart with another NODE_ENV", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const production = await harness({ db, blobs, nodeEnv: "production", config: { robots: {} } });
    expect(production.logger.warnings).toEqual(['delivery/static: robots.policy is not set, robots.txt uses "allow" because NODE_ENV is "production"']);
    await production.page({ slug: "kontakt", title: "Kontakt", status: "published" });
    expectOk(await production.delivery.exportIndexes());
    expect(production.text("robots.txt")).toBe("User-agent: *\nAllow: /\n\nSitemap: https://example.org/sitemap.xml\n");
    await production.delivery.close();
    const staging = await harness({ db, blobs, content: production.content, nodeEnv: "staging", config: { robots: {} } });
    expect(staging.logger.warnings).toEqual(['delivery/static: robots.policy is not set, robots.txt uses "disallow" because NODE_ENV is "staging"']);
    expectOk(await staging.delivery.exportIndexes());
    expect(staging.text("robots.txt")).toBe("User-agent: *\nDisallow: /\n\nSitemap: https://example.org/sitemap.xml\n");
    expect((await harness({ nodeEnv: "production", config: { robots: { policy: "disallow", extra: ["Allow: /presse"] } } })).logger.warnings).toEqual([]);
  });

  it("skips files whose content did not change since this process last wrote them", async () => {
    const h = await harness();
    await seed(h);
    expectOk(await h.delivery.exportIndexes());
    h.blobs.puts.length = 0;
    expectOk(await h.delivery.exportIndexes());
    expect(h.blobs.puts).toEqual([]);
    expectOk(await h.content.set("settings", { title: "Meine Company GmbH" }, { locale: "de" }));
    expectOk(await h.delivery.exportIndexes());
    expect(h.blobs.puts).toEqual(["site/llms.txt"]);
  });

  it("without llms.full leaves an llms-full.txt it did not write alone, and exportLlmsFull then writes nothing", async () => {
    const blobs = memoryBlobs();
    blobs.files.set("site/llms-full.txt", { text: "old", contentType: "text/plain" });
    const h = await harness({ blobs });
    await seed(h);
    expectOk(await h.delivery.exportIndexes());
    expect(h.text("llms-full.txt")).toBe("old");
    h.blobs.puts.length = 0;
    expect(expectOk(await h.delivery.exportLlmsFull())).toEqual({ entries: 0 });
    expect(h.blobs.puts).toEqual([]);
  });

  it("removes an llms-full.txt an earlier export wrote once llms.full is off, also after a restart, and leaves a later one of the site's own", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const before = await harness({ db, blobs, config: { llms: { full: true } } });
    await seed(before);
    expectOk(await before.delivery.exportLlmsFull());
    expect(before.text("llms-full.txt")).toContain("### Kontakt");
    await before.delivery.close();
    const after = await harness({ db, blobs, content: before.content });
    expectOk(await after.delivery.exportIndexes());
    expect(after.text("llms-full.txt")).toBeUndefined();
    blobs.files.set("site/llms-full.txt", { text: "own", contentType: "text/plain" });
    const later = await harness({ db, blobs, content: before.content });
    expectOk(await later.delivery.exportIndexes());
    expect(later.text("llms-full.txt")).toBe("own");
  });

  it("with sitemap: false removes a sitemap.xml an earlier export wrote, also after a restart, and leaves a later one of the site's own", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const before = await harness({ db, blobs });
    await seed(before);
    expectOk(await before.delivery.exportIndexes());
    expect(before.text("sitemap.xml")).toContain("<urlset");
    await before.delivery.close();
    const after = await harness({ db, blobs, content: before.content, config: { sitemap: false } });
    expectOk(await after.delivery.exportIndexes());
    expect(after.text("sitemap.xml")).toBeUndefined();
    expect(after.text("robots.txt")).toBe("User-agent: *\nAllow: /\n");
    blobs.files.set("site/sitemap.xml", { text: "own", contentType: "application/xml" });
    const later = await harness({ db, blobs, content: before.content, config: { sitemap: false } });
    expectOk(await later.delivery.exportIndexes());
    expect(later.text("sitemap.xml")).toBe("own");
  });

  it("records each export's outcome for readStaleStatus, the error of a failed one included", async () => {
    const h = await harness({ config: { llms: { full: true } } });
    await seed(h);
    expect(expectOk(await h.delivery.readStaleStatus()).exports).toEqual({ indexes: null, llmsFull: null });
    expectOk(await h.delivery.exportIndexes());
    h.blobs.failPut.add("site/llms-full.txt");
    expectErr(await h.delivery.exportLlmsFull(), "TRANSIENT");
    const { exports } = expectOk(await h.delivery.readStaleStatus());
    expect(exports.indexes).toMatchObject({ entries: 4, error: null });
    expect(exports.llmsFull).toMatchObject({ entries: 0, error: "cannot write site/llms-full.txt" });
    expect(typeof exports.indexes?.at).toBe("number");
  });

  it("writes llms-full.txt from the stored HTML of the same entries, failed pages included", async () => {
    const h = await harness({ config: { llms: { full: true } } });
    const ids = await seed(h);
    h.state.down = true;
    expectOk(await h.delivery.publish("pages", ids.kontakt));
    expect(expectOk(await h.delivery.exportLlmsFull())).toEqual({ entries: 4 });
    const full = h.text("llms-full.txt")!;
    expect(full.startsWith("# Meine Company GmbH & Co KG\n\n> Alles über uns\n\n## pages\n\n### Start\n\nSource: https://example.org/\n\n#### Start")).toBe(true);
    expect(full).toContain("### Kontakt\n\nSource: https://example.org/kontakt\n\nSo erreichen Sie uns\n\n#### Kontakt");
  });

  it("answers TRANSIENT and records nothing once the process is stopping", async () => {
    const h = await harness();
    await seed(h);
    await h.delivery.close();
    expectErr(await h.delivery.exportIndexes(), "TRANSIENT");
    expect(h.text("sitemap.xml")).toBeUndefined();
    expect(expectOk(await h.db.findOne(STATE, { id: "export:indexes" }))).toBeNull();
  });
});

describe("index export requests with render \"events\"", () => {
  it("requestIndexes raises indexesStale and, with llms.full, llmsStale", async () => {
    const h = await harness({ config: { llms: { full: true } } });
    expectOk(await h.delivery.requestIndexes());
    expect(h.emitted).toEqual([
      { name: INDEXES_STALE, data: { coalesceKey: "indexes" } },
      { name: LLMS_STALE, data: { coalesceKey: "llms" } },
    ]);
  });

  it("a re-render asks for llms-full.txt every time but for the index files only when the output's path entered, left or changed", async () => {
    const h = await harness({ config: { llms: { full: true } } });
    const ids = await seed(h);
    const rerender = async (): Promise<string[]> => {
      h.emitted.length = 0;
      expectOk(await h.delivery.markAll("pages"));
      h.emitted.length = 0;
      await h.delivery.republishOutput({ type: "pages", docId: ids.kontakt, locale: "de" });
      return h.emitted.map((e) => e.name);
    };
    expect(await rerender()).toEqual([LLMS_STALE]);
    h.state.down = true;
    expect(await rerender()).toEqual([LLMS_STALE]);
    h.state.down = false;
    expectOk(await h.content.update("pages", ids.kontakt, { slug: "kontakt-neu" }, { locale: "de" }));
    expect(await rerender()).toEqual([LLMS_STALE, INDEXES_STALE]);
    expectOk(await h.content.update("pages", ids.kontakt, { status: "draft" }, { locale: "de" }));
    expect(await rerender()).toEqual([LLMS_STALE, INDEXES_STALE]);
  });

  it("the recovery pass asks for the index files every time, and for llms-full.txt only while its last export failed", async () => {
    const h = await harness({ config: { llms: { full: true } } });
    await seed(h);
    const resumed = async (): Promise<string[]> => {
      h.emitted.length = 0;
      expectOk(await h.delivery.resumeStale());
      return h.emitted.map((e) => e.name);
    };
    expect(await resumed()).toEqual([INDEXES_STALE]);
    h.blobs.failPut.add("site/llms-full.txt");
    expectErr(await h.delivery.exportLlmsFull(), "TRANSIENT");
    expect(await resumed()).toEqual([INDEXES_STALE, LLMS_STALE]);
    h.blobs.failPut.clear();
    expectOk(await h.delivery.exportLlmsFull());
    expect(await resumed()).toEqual([INDEXES_STALE]);
  });

  it("a deleted page whose export never ran leaves sitemap.xml with the export the next recovery pass asks for", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.delivery.exportIndexes());
    expect(locs(h.text("sitemap.xml"))).toContain("https://example.org/kontakt");
    expectOk(await h.delivery.unpublish("pages", ids.kontakt));
    h.emitted.length = 0;
    expectOk(await h.delivery.resumeStale());
    expect(h.emitted.map((e) => e.name)).toContain(INDEXES_STALE);
    expectOk(await h.delivery.exportIndexes());
    expect(locs(h.text("sitemap.xml"))).toEqual(["https://example.org/", "https://example.org/en"]);
  });
});

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("index exports in the background loop", () => {
  it("exports the index files once the window passed, before the next batch of a re-render backlog", async () => {
    const h = await harness({ render: "background" });
    await seed(h);
    for (let i = 0; i < 12; i++) await h.page({ slug: `seite-${i}`, title: `Seite ${i}`, status: "published" });
    let release: () => void = () => {};
    h.state.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    expectOk(await h.delivery.markAll("pages"));
    await until(() => h.state.renders > 0);
    await h.page({ slug: "neu", title: "Neu", status: "published" });
    expectOk(await h.delivery.requestIndexes());
    const marked = expectOk(await h.delivery.readStaleStatus()).stale;
    expect(marked).toBeGreaterThan(20);
    let staleAtExport = -1;
    h.blobs.onPut = async (key, text) => {
      if (key === "site/sitemap.xml" && text.includes("https://example.org/neu")) staleAtExport = expectOk(await h.db.count(STATUS, { staleToken: { ne: null } }));
    };
    h.advance(1000);
    h.state.held = undefined;
    release();
    await until(() => staleAtExport >= 0);
    expect(staleAtExport).toBeGreaterThanOrEqual(marked - 5);
  });

  it("an index export that keeps failing never stops marked outputs from rendering, and is retried with a backoff", async () => {
    const h = await harness({ render: "background", config: { dependencies: { render: "background", indexesDelayMs: 0, backoffSeconds: [60] } } });
    await seed(h);
    h.blobs.failPut.add("site/llms.txt");
    expectOk(await h.delivery.requestIndexes());
    expectOk(await h.delivery.markAll("pages"));
    await until(async () => {
      const status = expectOk(await h.delivery.readStaleStatus());
      return status.stale === 0 && status.rendering === 0 && status.exports.indexes?.error === "cannot write site/llms.txt";
    });
    expect(h.logger.errors).toContain("delivery/static: the index export failed, the re-renders go on and the export is retried");
    h.blobs.failPut.clear();
    h.advance(61_000);
    expectOk(await h.delivery.markAll("pages"));
    await until(async () => expectOk(await h.delivery.readStaleStatus()).exports.indexes?.error === null);
    expect(h.text("llms.txt")).toContain("# Meine Company GmbH & Co KG");
  });

  it("exports llms-full.txt after the renders, once nothing else is due", async () => {
    const h = await harness({ render: "background", config: { llms: { full: true } } });
    await seed(h);
    expectOk(await h.content.set("settings", { title: "Neuer Titel" }, { locale: "de" }));
    expectOk(await h.delivery.markAll("pages"));
    await until(() => (h.text("llms-full.txt") ?? "").startsWith("# Neuer Titel"));
    expect(expectOk(await h.delivery.readStaleStatus()).stale).toBe(0);
  });
});

interface LoopProbe {
  settle(wake: () => Promise<unknown>): Promise<void>;
}

function probeLoop(db: Persistence): LoopProbe {
  let started = 0;
  let endedStart = 0;
  let current = 0;
  const updateMany = db.updateMany.bind(db);
  const findMany = db.findMany.bind(db);
  db.updateMany = async (collection, filter, patch) => {
    if (collection === STATUS && Object.keys(filter).join() === "claimedAt") current = ++started;
    return updateMany(collection, filter, patch);
  };
  db.findMany = async <T extends Document>(collection: string, filter: Filter, options?: FindOptions) => {
    const found = await findMany<T>(collection, filter, options);
    if (collection === STATUS && options?.limit === 1 && isRecord(filter.staleRetryAt) && "gt" in filter.staleRetryAt) endedStart = current;
    return found;
  };
  return {
    async settle(wake) {
      const before = started;
      await wake();
      await until(() => endedStart > before);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("index exports in the background loop, on a manual clock", () => {
  async function background(config: Record<string, unknown> = {}) {
    const clock = { t: Date.UTC(2026, 10, 2, 9) };
    const db = createFakePersistence();
    const probe = probeLoop(db);
    const h = await harness({ db, clock, render: "background", config: { ...config, dependencies: { render: "background", ...(isRecord(config.dependencies) ? config.dependencies : {}) } } });
    await seed(h);
    const sitemapPuts = (): number => h.blobs.puts.filter((k) => k === "site/sitemap.xml").length;
    const failures = (): number => h.logger.errors.filter((e) => e === "delivery/static: the index export failed, the re-renders go on and the export is retried").length;
    const rendered = async (): Promise<void> => {
      await probe.settle(async () => expectOk(await h.delivery.markAll("pages")));
      await until(async () => expectOk(await h.delivery.readStaleStatus()).stale === 0);
    };
    return { ...h, clock, probe, sitemapPuts, failures, rendered };
  }

  it("exports the index files indexesDelayMs after the first request, and a second request inside the window does not move it", async () => {
    const h = await background();
    h.blobs.puts.length = 0;
    await h.probe.settle(() => h.delivery.requestIndexes());
    expect(h.sitemapPuts()).toBe(0);
    h.clock.t += 999;
    await h.probe.settle(() => h.delivery.requestIndexes());
    expect(h.sitemapPuts()).toBe(0);
    h.clock.t += 1;
    await h.probe.settle(() => h.delivery.requestIndexes());
    expect(h.sitemapPuts()).toBe(1);
  });

  it("does not try a failed index export again before its backoff ended", async () => {
    const h = await background({ dependencies: { backoffSeconds: [60] } });
    h.blobs.failPut.add("site/llms.txt");
    await h.probe.settle(() => h.delivery.requestIndexes());
    h.clock.t += 1000;
    await h.probe.settle(() => h.delivery.requestIndexes());
    expect(h.failures()).toBe(1);
    h.clock.t += 59_999;
    await h.rendered();
    expect(h.failures()).toBe(1);
    h.blobs.failPut.clear();
    h.clock.t += 1;
    await h.rendered();
    await until(async () => expectOk(await h.delivery.readStaleStatus()).exports.indexes?.error === null);
    expect(h.failures()).toBe(1);
  });

  it("a request after a failed export runs it once the window passed, without waiting for the backoff", async () => {
    const h = await background({ dependencies: { backoffSeconds: [60] } });
    h.blobs.failPut.add("site/llms.txt");
    await h.probe.settle(() => h.delivery.requestIndexes());
    h.clock.t += 1000;
    await h.probe.settle(() => h.delivery.requestIndexes());
    expect(h.failures()).toBe(1);
    h.blobs.failPut.clear();
    h.clock.t += 5000;
    await h.page({ slug: "neu", title: "Neu", status: "published" });
    await h.probe.settle(() => h.delivery.requestIndexes());
    expect(h.text("sitemap.xml") ?? "").not.toContain("https://example.org/neu");
    h.clock.t += 1000;
    await h.probe.settle(() => h.delivery.requestIndexes());
    expect(h.text("sitemap.xml")).toContain("https://example.org/neu");
  });

  function slowHtml(h: Harness) {
    const waiting: Array<() => void> = [];
    let open = false;
    const get = h.blobs.get.bind(h.blobs);
    h.blobs.get = async (key) => {
      if (!open && key.endsWith("index.html")) await new Promise<void>((resolve) => waiting.push(resolve));
      return get(key);
    };
    return {
      waiting: () => waiting.length,
      releaseOne: () => waiting.shift()?.(),
      releaseAll: () => {
        open = true;
        for (const resolve of waiting.splice(0)) resolve();
      },
    };
  }

  it("a save exports sitemap.xml, robots.txt and llms.txt once the window passed, before a slow llms-full.txt export", async () => {
    const h = await background({ llms: { full: true } });
    const html = slowHtml(h);
    await h.page({ slug: "neu", title: "Neu", status: "published" });
    await h.probe.settle(() => h.delivery.requestIndexes());
    h.clock.t += 1000;
    await h.delivery.requestIndexes();
    await until(() => (h.text("sitemap.xml") ?? "").includes("https://example.org/neu"));
    expect(h.text("llms.txt")).toContain("https://example.org/neu");
    expect(h.text("llms-full.txt")).toBeUndefined();
    html.releaseAll();
    await until(() => h.text("llms-full.txt") !== undefined);
  });

  it("an llms-full.txt export that is already reading pages lets a due index export run between two pages", async () => {
    const h = await background({ llms: { full: true } });
    const html = slowHtml(h);
    expectOk(await h.delivery.markAll("pages"));
    await until(() => html.waiting() === 1);
    await h.page({ slug: "neu", title: "Neu", status: "published" });
    expectOk(await h.delivery.requestIndexes());
    h.clock.t += 1000;
    html.releaseOne();
    await until(() => (h.text("sitemap.xml") ?? "").includes("https://example.org/neu"));
    expect(h.text("llms-full.txt")).toBeUndefined();
    html.releaseAll();
    await until(() => h.text("llms-full.txt") !== undefined);
  });
});

const MARKER_KEY = "site.delivery-marker";

describe("a database restored from a backup", () => {
  it("keeps the marker next to the prefix, outside the files it serves, and keeps none with an empty prefix", () => {
    expect(markerKeyFor("site/")).toBe(MARKER_KEY);
    expect(markerKeyFor("prod/site/")).toBe("prod/site.delivery-marker");
    expect(markerKeyFor("")).toBeNull();
  });

  it("two sites in one blob store under different prefixes never take each other's marker for a restore", async () => {
    const blobs = memoryBlobs();
    const prod = await harness({ blobs, config: { prefix: "prod/site/" } });
    const staging = await harness({ blobs, config: { prefix: "staging/site/" } });
    expect(expectOk(await prod.delivery.checkBuild("b1"))).toMatchObject({ restored: false });
    expect(expectOk(await staging.delivery.checkBuild("b1"))).toMatchObject({ restored: false });
    expect(expectOk(await prod.delivery.checkBuild("b1"))).toEqual({ changed: false, restored: false, marked: 0 });
    expect(expectOk(await staging.delivery.checkBuild("b1"))).toEqual({ changed: false, restored: false, marked: 0 });
    expect([...blobs.files.keys()].filter((k) => k.endsWith(".delivery-marker")).sort()).toEqual(["prod/site.delivery-marker", "staging/site.delivery-marker"]);
  });

  it("with an empty prefix writes no marker into the served root and still checks the build", async () => {
    const h = await harness({ config: { prefix: "" } });
    await h.page({ slug: "kontakt", title: "Kontakt", status: "published" });
    expect(expectOk(await h.delivery.checkBuild("b1"))).toMatchObject({ changed: true, restored: false });
    expect(expectOk(await h.delivery.checkBuild("b1"))).toEqual({ changed: false, restored: false, marked: 0 });
    await h.delivery.close();
    expect([...h.blobs.files.keys()].filter((k) => k.includes("marker"))).toEqual([]);
  });

  it("still marks and stores a changed build when the marker cannot be read, and leaves the marker as it is", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const first = await harness({ db, blobs });
    await seed(first);
    expectOk(await first.delivery.checkBuild("b1"));
    await first.delivery.close();
    const marker = blobs.files.get(MARKER_KEY)!.text;
    const get = blobs.get.bind(blobs);
    blobs.get = async (key) => (key === MARKER_KEY ? err(failure("TRANSIENT", "store unavailable")) : get(key));
    const next = await harness({ db, blobs, content: first.content });
    const checked = expectOk(await next.delivery.checkBuild("b2"));
    expect(checked).toMatchObject({ changed: true, restored: false });
    expect(checked.marked).toBeGreaterThan(0);
    expect(next.logger.errors).toContain("delivery/static: could not read the restore marker, this build check cannot tell whether the database was restored");
    expect(expectOk(await db.findOne<{ id: string; value: string }>(STATE, { id: "build" }))!.value).toBe("b2");
    await next.delivery.close();
    expect(blobs.files.get(MARKER_KEY)!.text).toBe(marker);
    expect(expectOk(await db.findOne<{ id: string; value: string }>(STATE, { id: "marker" }))!.value).toBe(marker);
  });

  it("checkBuild renders every output again when the database is older than the delivered files, even with the same build", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const first = await harness({ db, blobs });
    await seed(first);
    expect(expectOk(await first.delivery.checkBuild("b1"))).toMatchObject({ changed: true, restored: false });
    expectOk(await first.delivery.resumeStale());
    const backup = expectOk(await db.findOne<{ id: string; value: string }>(STATE, { id: "marker" }))!.value;
    await first.page({ slug: "neu", title: "Neu", status: "published" });
    await first.delivery.close();
    expect(blobs.files.has(MARKER_KEY)).toBe(true);
    expect(expectOk(await db.findOne<{ id: string; value: string }>(STATE, { id: "marker" }))!.value).toBe(blobs.files.get(MARKER_KEY)!.text);

    const restarted = await harness({ db, blobs, content: first.content });
    expect(expectOk(await restarted.delivery.checkBuild("b1"))).toEqual({ changed: false, restored: false, marked: 0 });
    await restarted.delivery.close();

    expectOk(await db.updateMany(STATE, { id: "marker" }, { value: backup }));
    const restored = await harness({ db, blobs, content: first.content });
    const checked = expectOk(await restored.delivery.checkBuild("b1"));
    expect(checked).toMatchObject({ changed: false, restored: true });
    expect(checked.marked).toBeGreaterThan(0);
    expect(restored.logger.warnings).toContain("delivery/static: the database is older than the delivered files (restored from a backup), so every output is rendered again");
    expect(expectOk(await restored.delivery.checkBuild("b1"))).toEqual({ changed: false, restored: false, marked: 0 });
  });

  it("detects a restore that lost a page written after the last recovery pass, when the process stopped without shutting down", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const first = await harness({ db, blobs });
    await seed(first);
    expectOk(await first.delivery.checkBuild("b1"));
    expectOk(await first.delivery.resumeStale());
    const replicated = expectOk(await db.findOne<{ id: string; value: string }>(STATE, { id: "marker" }))!.value;
    const neu = await first.page({ slug: "neu", title: "Neu", status: "published" });
    expect(blobs.files.has("site/neu/index.html")).toBe(true);

    expectOk(await db.deleteMany(STATUS, { docId: neu }));
    expectOk(await db.updateMany(STATE, { id: "marker" }, { value: replicated }));
    const restarted = await harness({ db, blobs, content: first.content });
    expect(expectOk(await restarted.delivery.checkBuild("b1"))).toMatchObject({ changed: false, restored: true });
  });

  it("a restart with no output changed writes no marker, neither at the build check nor at shutdown", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const first = await harness({ db, blobs });
    await seed(first);
    expectOk(await first.delivery.checkBuild("b1"));
    await first.delivery.close();
    const marker = blobs.files.get(MARKER_KEY)!.text;
    blobs.puts.length = 0;
    const next = await harness({ db, blobs, content: first.content });
    expect(expectOk(await next.delivery.checkBuild("b1"))).toEqual({ changed: false, restored: false, marked: 0 });
    expectOk(await next.delivery.resumeStale());
    await next.delivery.close();
    expect(blobs.puts.filter((key) => key === MARKER_KEY)).toEqual([]);
    expect(blobs.files.get(MARKER_KEY)!.text).toBe(marker);
    expect(expectOk(await db.findOne<{ id: string; value: string }>(STATE, { id: "marker" }))!.value).toBe(marker);
  });

  const stateValue = async (db: Persistence, id: string): Promise<string | undefined> => expectOk(await db.findOne<{ id: string; value: string }>(STATE, { id }))?.value;
  const blobMarker = (blobs: Files): string | undefined => blobs.files.get(MARKER_KEY)?.text;
  const holdRenders = (h: Harness): (() => void) => {
    let release = (): void => {};
    h.state.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      h.state.held = undefined;
      release();
    };
  };

  it("a process puts a new marker before its next write once another process stored its own, so a backup taken in between is detected", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const a = await harness({ db, blobs });
    const b = await harness({ db, blobs, content: a.content });
    expectOk(await a.delivery.checkBuild("b1"));
    expectOk(await b.delivery.checkBuild("b1"));
    await b.page({ slug: "von-b", title: "Von B", status: "published" });
    await a.page({ slug: "von-a", title: "Von A", status: "published" });
    expectOk(await a.delivery.resumeStale());
    const backup = await stateValue(db, "marker");
    expect(blobMarker(blobs)).toBe(backup);

    const lost = await b.page({ slug: "verloren", title: "Verloren", status: "published" });
    expect(blobs.files.has("site/verloren/index.html")).toBe(true);
    expect(blobMarker(blobs)).not.toBe(backup);
    await b.delivery.close();
    await a.delivery.close();

    expectOk(await db.deleteMany(STATUS, { docId: lost }));
    expectOk(await db.updateMany(STATE, { id: "marker" }, { value: backup }));
    const c = await harness({ db, blobs, content: a.content });
    expect(expectOk(await c.delivery.checkBuild("b1"))).toMatchObject({ restored: true });
  });

  it("the database takes the marker of a recovery pass once the renders in flight at that pass finished, also while later renders keep starting", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.delivery.checkBuild("b1"));
    await h.page({ slug: "eins", title: "Eins", status: "published" });
    const sealedBefore = await stateValue(h.db, "marker");
    for (const id of [ids.kontakt, ids.home]) {
      const release = holdRenders(h);
      const rendering = h.delivery.publish("pages", id);
      const passMarker = blobMarker(h.blobs);
      expectOk(await h.delivery.resumeStale());
      expect(await stateValue(h.db, "marker")).not.toBe(passMarker);
      release();
      expectOk(await rendering);
      await expect.poll(() => stateValue(h.db, "marker")).toBe(passMarker);
    }
    expect(await stateValue(h.db, "marker")).not.toBe(sealedBefore);
  });

  it("an idle process stores its marker a few seconds after its last write, so an unclean stop after that is no restore", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const db = createFakePersistence();
      const blobs = memoryBlobs();
      const first = await harness({ db, blobs });
      await seed(first);
      expectOk(await first.delivery.checkBuild("b1"));
      await first.page({ slug: "neu", title: "Neu", status: "published" });
      expect(await stateValue(db, "marker")).not.toBe(blobMarker(blobs));
      await vi.advanceTimersByTimeAsync(10_000);
      await expect.poll(() => stateValue(db, "marker")).toBe(blobMarker(blobs));
      const restarted = await harness({ db, blobs, content: first.content });
      expect(expectOk(await restarted.delivery.checkBuild("b1"))).toEqual({ changed: false, restored: false, marked: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a graceful stop waits for the render in flight and stores the marker, and refuses renders that start after it", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const first = await harness({ db, blobs });
    const ids = await seed(first);
    expectOk(await first.delivery.checkBuild("b1"));
    expectOk(await first.delivery.markAll("pages"));
    const release = holdRenders(first);
    const rendering = first.delivery.publish("pages", ids.kontakt);
    const closing = first.delivery.close();
    expectErr(await first.delivery.publish("pages", ids.home), "TRANSIENT");
    expectErr(await first.delivery.republishOutput({ type: "pages", docId: ids.home, locale: "de" }), "TRANSIENT");
    expectErr(await first.delivery.unpublish("pages", ids.home), "TRANSIENT");
    release();
    expectOk(await rendering);
    await closing;
    expect(await stateValue(db, "marker")).toBe(blobMarker(blobs));
    const restarted = await harness({ db, blobs, content: first.content });
    expect(expectOk(await restarted.delivery.checkBuild("b1"))).toMatchObject({ changed: false, restored: false });
  });

  it("writes no file when the marker cannot be written, and the next write tries the marker again", async () => {
    const h = await harness();
    await seed(h);
    expectOk(await h.delivery.checkBuild("b1"));
    expectOk(await h.delivery.resumeStale());
    h.blobs.failPut.add(MARKER_KEY);
    const zwei = await h.page({ slug: "zwei", title: "Zwei", status: "published" });
    expect(h.blobs.files.has("site/zwei/index.html")).toBe(false);
    expect(expectOk(await h.db.findOne<StatusRow>(STATUS, { docId: zwei, locale: "de" }))).toMatchObject({ state: "error" });
    h.blobs.failPut.delete(MARKER_KEY);
    h.blobs.puts.length = 0;
    await h.page({ slug: "drei", title: "Drei", status: "published" });
    expect(h.blobs.puts.indexOf(MARKER_KEY)).toBe(0);
    expect(h.blobs.files.has("site/drei/index.html")).toBe(true);
  });

  it("a process whose build check could not read the marker reads it again before its first write, and writes no file while it cannot", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const first = await harness({ db, blobs });
    await seed(first);
    expectOk(await first.delivery.checkBuild("b1"));
    await first.delivery.close();
    const get = blobs.get.bind(blobs);
    let unreadable = true;
    blobs.get = async (key) => (key === MARKER_KEY && unreadable ? err(failure("TRANSIENT", "store unavailable")) : get(key));
    const next = await harness({ db, blobs, content: first.content });
    expect(expectOk(await next.delivery.checkBuild("b1"))).toEqual({ changed: false, restored: false, marked: 0 });
    await next.page({ slug: "neu", title: "Neu", status: "published" });
    expect(blobs.files.has("site/neu/index.html")).toBe(false);
    unreadable = false;
    blobs.puts.length = 0;
    await next.page({ slug: "spaeter", title: "Später", status: "published" });
    expect(blobs.puts.indexOf(MARKER_KEY)).toBe(0);
    expect(blobs.files.has("site/spaeter/index.html")).toBe(true);
    expect(blobMarker(blobs)).not.toBe(await stateValue(db, "marker"));
  });

  it("a marker the database holds but the blob store lacks counts as a restore, as after a lost blob volume or a changed prefix", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const first = await harness({ db, blobs });
    await seed(first);
    expectOk(await first.delivery.checkBuild("b1"));
    await first.delivery.close();
    const moved = await harness({ db, blobs, content: first.content, config: { prefix: "www/" } });
    const checked = expectOk(await moved.delivery.checkBuild("b1"));
    expect(checked).toMatchObject({ changed: false, restored: true });
    expect(checked.marked).toBeGreaterThan(0);
    await moved.delivery.close();
    blobs.files.clear();
    const lost = await harness({ db, blobs, content: first.content });
    expect(expectOk(await lost.delivery.checkBuild("b1"))).toMatchObject({ changed: false, restored: true });
  });

  it("a process that never checked a build checks the marker before its first write and stores it at shutdown", async () => {
    const h = await harness();
    await seed(h);
    await h.delivery.close();
    expect(blobMarker(h.blobs)).toBeDefined();
    expect(await stateValue(h.db, "marker")).toBe(blobMarker(h.blobs));
  });

  const RESTORE_WARNING = "delivery/static: the database is older than the delivered files (restored from a backup), so every output is rendered again";

  it("a process whose build check failed before it read the marker still covers its writes, so a restore of a backup taken before them is detected", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const first = await harness({ db, blobs });
    await seed(first);
    expectOk(await first.delivery.checkBuild("b1"));
    await first.delivery.close();
    const backup = await stateValue(db, "marker");
    const findOne = db.findOne.bind(db);
    let failBuildRead = true;
    db.findOne = async <T extends Document>(collection: string, filter: Filter) => {
      if (failBuildRead && collection === STATE && filter.id === "build") {
        failBuildRead = false;
        return err(failure("TRANSIENT", "database is locked"));
      }
      return findOne<T>(collection, filter);
    };
    const next = await harness({ db, blobs, content: first.content });
    expectErr(await next.delivery.checkBuild("b1"), "TRANSIENT");
    const lost = await next.page({ slug: "neu", title: "Neu", status: "published" });
    expect(blobs.files.has("site/neu/index.html")).toBe(true);
    expect(blobMarker(blobs)).not.toBe(backup);
    await next.delivery.close();

    expectOk(await db.deleteMany(STATUS, { docId: lost }));
    expectOk(await db.updateMany(STATE, { id: "marker" }, { value: backup }));
    const restored = await harness({ db, blobs, content: first.content });
    expect(expectOk(await restored.delivery.checkBuild("b1"))).toMatchObject({ changed: false, restored: true });
  });

  it("a page a queue renders before the build check is covered by the marker", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const first = await harness({ db, blobs });
    await seed(first);
    expectOk(await first.delivery.checkBuild("b1"));
    await first.delivery.close();
    const backup = await stateValue(db, "marker");
    const next = await harness({ db, blobs, content: first.content });
    const lost = await next.page({ slug: "neu", title: "Neu", status: "published" });
    expect(blobMarker(blobs)).not.toBe(backup);
    expect(expectOk(await next.delivery.checkBuild("b1"))).toEqual({ changed: false, restored: false, marked: 0 });
    await next.delivery.close();

    expectOk(await db.deleteMany(STATUS, { docId: lost }));
    expectOk(await db.updateMany(STATE, { id: "marker" }, { value: backup }));
    const restored = await harness({ db, blobs, content: first.content });
    expect(expectOk(await restored.delivery.checkBuild("b1"))).toMatchObject({ changed: false, restored: true });
  });

  it("a marker put that keeps failing after a detected restore marks every output once, and the failed re-renders count their attempts", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const first = await harness({ db, blobs });
    const ids = await seed(first);
    expectOk(await first.delivery.checkBuild("b1"));
    const backup = await stateValue(db, "marker");
    await first.page({ slug: "neu", title: "Neu", status: "published" });
    await first.delivery.close();
    expectOk(await db.updateMany(STATE, { id: "marker" }, { value: backup }));

    const next = await harness({ db, blobs, content: first.content });
    blobs.failPut.add(MARKER_KEY);
    const checked = expectOk(await next.delivery.checkBuild("b1"));
    expect(checked).toMatchObject({ changed: false, restored: true });
    const raised = next.emitted.length;
    expect(raised).toBe(checked.marked);
    for (let attempt = 0; attempt < 3; attempt++) expectErr(await next.delivery.republishOutput({ type: "pages", docId: ids.kontakt, locale: "de" }), "TRANSIENT");
    expect(next.logger.warnings.filter((w) => w === RESTORE_WARNING)).toHaveLength(1);
    expect(next.emitted.filter((e) => e.name === "delivery.outputStale")).toHaveLength(raised);
    expect(expectOk(await db.findOne<StatusRow>(STATUS, { docId: ids.kontakt, locale: "de" }))).toMatchObject({ staleAttempts: 3 });

    blobs.failPut.delete(MARKER_KEY);
    expectOk(await next.delivery.republishOutput({ type: "pages", docId: ids.kontakt, locale: "de" }));
    await next.delivery.close();
    expect(await stateValue(db, "marker")).toBe(blobMarker(blobs));
    const later = await harness({ db, blobs, content: first.content });
    expect(expectOk(await later.delivery.checkBuild("b1"))).toEqual({ changed: false, restored: false, marked: 0 });
  });

  it("a marker put that fails on the first start leaves no marker behind that a later check takes for a restore", async () => {
    const h = await harness();
    h.blobs.failPut.add(MARKER_KEY);
    await seed(h);
    expectOk(await h.delivery.checkBuild("b1"));
    h.blobs.failPut.delete(MARKER_KEY);
    await h.page({ slug: "neu", title: "Neu", status: "published" });
    expect(h.blobs.files.has("site/neu/index.html")).toBe(true);
    expect(h.logger.warnings).not.toContain(RESTORE_WARNING);
  });

  it("a graceful stop waits for a re-render job that passed its stopping check before the stop", async () => {
    const db = createFakePersistence();
    let gate: Promise<void> | null = null;
    const updateMany = db.updateMany.bind(db);
    db.updateMany = async <T extends Document>(collection: string, filter: Filter, patch: Partial<Omit<T, "id">>) => {
      if (gate !== null && collection === STATUS && filter.claimedBy === null && isRecord(patch) && typeof patch.claimedBy === "string") await gate;
      return updateMany<T>(collection, filter, patch);
    };
    const first = await harness({ db });
    const ids = await seed(first);
    expectOk(await first.delivery.checkBuild("b1"));
    expectOk(await first.delivery.markAll("pages"));
    expectOk(await first.delivery.resumeStale());
    expect(await stateValue(db, "marker")).toBe(blobMarker(first.blobs));
    let open = (): void => {};
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const job = first.delivery.republishOutput({ type: "pages", docId: ids.kontakt, locale: "de" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closing = first.delivery.close();
    gate = null;
    open();
    expect(expectOk(await job)).toMatchObject({ rendered: true });
    await closing;
    expect(await stateValue(db, "marker")).toBe(blobMarker(first.blobs));
    const next = await harness({ db, blobs: first.blobs, content: first.content });
    expect(expectOk(await next.delivery.checkBuild("b1"))).toEqual({ changed: false, restored: false, marked: 0 });
  });

  it("a marker put that lands after a later one never lets the database take a marker while a later write is uncommitted", async () => {
    const db = createFakePersistence();
    let gate: Promise<void> | null = null;
    const createOne = db.createOne.bind(db);
    db.createOne = async <T extends Document>(collection: string, row: NewDocument<T>) => {
      if (gate !== null && collection === STATUS && isRecord(row) && row.path === "/r3") await gate;
      return createOne<T>(collection, row);
    };
    const h = await harness({ db });
    await seed(h);
    expectOk(await h.delivery.checkBuild("b1"));
    expectOk(await h.delivery.resumeStale());
    let slow = true;
    h.blobs.onPut = async (key) => {
      if (key !== MARKER_KEY || !slow) return;
      slow = false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    };
    const r1 = h.page({ slug: "r1", title: "R1", status: "published" });
    await until(() => !slow);
    expectOk(await h.delivery.resumeStale());
    await h.page({ slug: "r2", title: "R2", status: "published" });
    await r1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    let open = (): void => {};
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const r3 = h.page({ slug: "r3", title: "R3", status: "published" });
    await until(() => h.blobs.files.has("site/r3/index.html"));
    expect(await stateValue(db, "marker")).not.toBe(blobMarker(h.blobs));
    gate = null;
    open();
    await r3;
  });

  it("a process that starts next to one whose marker the database has not taken yet reports no restore", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const db = createFakePersistence();
      const blobs = memoryBlobs();
      const running = await harness({ db, blobs });
      await seed(running);
      expectOk(await running.delivery.checkBuild("b1"));
      expectOk(await running.delivery.resumeStale());
      await running.page({ slug: "neu", title: "Neu", status: "published" });
      expect(await stateValue(db, "marker")).not.toBe(blobMarker(blobs));
      const starting = await harness({
        db,
        blobs,
        content: running.content,
        delay: async (ms) => {
          await vi.advanceTimersByTimeAsync(ms);
        },
      });
      expect(expectOk(await starting.delivery.checkBuild("b1"))).toEqual({ changed: false, restored: false, marked: 0 });
      expect(starting.logger.warnings).not.toContain(RESTORE_WARNING);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the one-time removal of orphaned output files", () => {
  const CLAIM_TTL_MS = 300_000;

  async function upgraded(options: Options = {}): Promise<Harness> {
    const first = await harness(options);
    await seed(first);
    await first.delivery.close();
    expectOk(await first.db.deleteMany(STATE, { id: { in: ["orphans", "marker"] } }));
    expectOk(await first.db.createOne(STATE, { id: "build", value: "b1", seq: null, updatedAt: 0 }));
    first.blobs.files.delete(MARKER_KEY);
    const upgradedHarness = await harness({ ...options, db: first.db, content: first.content, blobs: first.blobs });
    expect(expectOk(await upgradedHarness.delivery.checkBuild("b1"))).toEqual({ changed: false, restored: false, marked: 0 });
    return upgradedHarness;
  }

  async function withOrphans() {
    const h = await upgraded({ config: { reservedPaths: ["/media"] } });
    for (const key of ["site/alt/index.html", "site/en/old/index.html", "site/media/index.html", "site/alt/photo.jpg", "site/index.pdf"]) h.blobs.files.set(key, { text: "x", contentType: "text/html" });
    return h;
  }

  async function sweep(h: Harness): Promise<number> {
    const first = expectOk(await h.delivery.resumeStale()).orphans;
    h.advance(CLAIM_TTL_MS + 1);
    return first + expectOk(await h.delivery.resumeStale()).orphans;
  }

  const placed = (h: Harness, ...keys: string[]): void => {
    for (const key of keys) h.blobs.files.set(key, { text: "x", contentType: "text/html" });
  };

  it("removes index files at paths no status row has, logs each one, records that it ran and never runs again", async () => {
    const h = await withOrphans();
    expect(await sweep(h)).toBe(2);
    expect([...h.blobs.files.keys()].filter((k) => k.endsWith("index.html") || k.endsWith("index.pdf")).sort()).toEqual(["site/en/contact/index.html", "site/en/index.html", "site/index.html", "site/index.pdf", "site/intern/index.html", "site/kontakt/index.html", "site/media/index.html"]);
    expect(h.blobs.files.has("site/alt/photo.jpg")).toBe(true);
    expect(h.logger.infos.filter((i) => i.message === "delivery/static: removed an orphaned output file no status row owns").map((i) => i.data)).toEqual([
      { path: "/alt", key: "site/alt/index.html" },
      { path: "/en/old", key: "site/en/old/index.html" },
    ]);
    expect(expectOk(await h.db.findOne(STATE, { id: "orphans" }))).not.toBeNull();
    h.blobs.files.set("site/later/index.html", { text: "x", contentType: "text/html" });
    expect(await sweep(h)).toBe(0);
    expect(h.blobs.files.has("site/later/index.html")).toBe(true);
  });

  it("removes nothing on the first pass, and a path only when a pass at least claimTtlSeconds later still finds it unowned", async () => {
    const h = await withOrphans();
    placed(h, "site/neu/index.html");
    expect(expectOk(await h.delivery.resumeStale()).orphans).toBe(0);
    for (const key of ["site/alt/index.html", "site/en/old/index.html", "site/neu/index.html"]) expect(h.blobs.files.has(key), key).toBe(true);
    await h.page({ slug: "neu", title: "Neu", status: "published" });
    h.advance(CLAIM_TTL_MS - 1000);
    expect(expectOk(await h.delivery.resumeStale()).orphans).toBe(0);
    expect(h.blobs.files.has("site/alt/index.html")).toBe(true);
    h.advance(2000);
    expect(expectOk(await h.delivery.resumeStale()).orphans).toBe(2);
    expect(h.blobs.files.has("site/alt/index.html")).toBe(false);
    expect(h.blobs.files.get("site/neu/index.html")?.text).toContain("Neu");
  });

  it("keeps the page a publish puts at an orphaned path while the removal runs", async () => {
    const h = await withOrphans();
    placed(h, "site/neu/index.html");
    expect(expectOk(await h.delivery.resumeStale()).orphans).toBe(0);
    h.advance(CLAIM_TTL_MS + 1);
    const remove = h.blobs.remove.bind(h.blobs);
    let neu: string | undefined;
    h.blobs.remove = async (key) => {
      if (key === "site/alt/index.html" && neu === undefined) neu = await h.page({ slug: "neu", title: "Neu", status: "published" });
      return remove(key);
    };
    expectOk(await h.delivery.resumeStale());
    expect(h.blobs.files.get("site/neu/index.html")?.text).toContain("Neu");
    expect(expectOk(await h.db.findOne<StatusRow>(STATUS, { docId: neu!, locale: "de" }))).toMatchObject({ state: "live", path: "/neu", staleToken: null });
    expectOk(await h.delivery.resumeStale());
    expect(h.blobs.files.has("site/en/old/index.html")).toBe(false);
    expect(h.blobs.files.get("site/neu/index.html")?.text).toContain("Neu");
    expect(expectOk(await h.db.findOne(STATE, { id: "orphans" }))).not.toBeNull();
  });

  it("waits while a published document has no live output", async () => {
    const h = await withOrphans();
    h.state.down = true;
    await h.page({ slug: "neu", title: "Neu", status: "published" });
    expect(await sweep(h)).toBe(0);
    expect(h.blobs.files.has("site/alt/index.html")).toBe(true);
    expect(expectOk(await h.db.findOne(STATE, { id: "orphans" }))).toBeNull();
    h.state.down = false;
    const neu = expectOk(await h.db.findOne<StatusRow>(STATUS, { path: null, state: "error" }))!;
    expectOk(await h.delivery.publish("pages", neu.docId));
    expect(await sweep(h)).toBe(2);
  });

  it("removes only page outputs of the configured formats, never media copies or renderer assets named index.<ext>", async () => {
    const h = await upgraded();
    placed(h, "site/alt/index.html", "site/assets/index.css", "site/media/abc123/index.png", "site/downloads/index.pdf");
    expect(await sweep(h)).toBe(1);
    expect(h.blobs.files.has("site/alt/index.html")).toBe(false);
    for (const key of ["site/assets/index.css", "site/media/abc123/index.png", "site/downloads/index.pdf"]) expect(h.blobs.files.has(key), key).toBe(true);
  });

  it("never removes the page file at the root path, which reservedPaths cannot list", async () => {
    const h = await upgraded({ config: { types: { pages: { home: "start" } } } });
    expect(expectOk(await h.db.count(STATUS, { path: "/" }))).toBe(0);
    placed(h, "site/index.html", "site/alt/index.html");
    expect(await sweep(h)).toBe(1);
    expect(h.blobs.files.has("site/index.html")).toBe(true);
    expect(h.blobs.files.has("site/alt/index.html")).toBe(false);
  });

  it("leaves the pages of another deployment whose prefix lies below this one's alone", async () => {
    const h = await upgraded();
    placed(h, "site/preview.delivery-marker", "site/preview/index.html", "site/preview/about/index.html", "site/alt/index.html");
    expect(await sweep(h)).toBe(1);
    expect(h.blobs.files.has("site/preview/index.html")).toBe(true);
    expect(h.blobs.files.has("site/preview/about/index.html")).toBe(true);
    expect(h.blobs.files.has("site/alt/index.html")).toBe(false);
  });

  it("never runs with an empty prefix, where the whole blob store would be compared", async () => {
    const h = await upgraded({ config: { prefix: "" } });
    for (const key of ["alt/index.html", "media/abc123/index.png"]) h.blobs.files.set(key, { text: "x", contentType: "application/octet-stream" });
    expect(await sweep(h)).toBe(0);
    expect(h.blobs.files.has("alt/index.html")).toBe(true);
    expect(h.blobs.files.has("media/abc123/index.png")).toBe(true);
  });

  it("never runs with a prefix that does not end in a slash, whose listing also holds a sibling deployment's keys", async () => {
    const h = await upgraded({ config: { prefix: "site" } });
    placed(h, "site-preview/about/index.html", "sitealt/index.html");
    expect(await sweep(h)).toBe(0);
    expect(h.blobs.files.has("site-preview/about/index.html")).toBe(true);
    expect(h.blobs.files.has("sitealt/index.html")).toBe(true);
  });

  it("gives up a run during which a page started to render, even one that finished before the files were listed", async () => {
    const h = await upgraded({ config: { reservedPaths: ["/media"] } });
    const content = h.content;
    const kontakt = expectOk(await h.db.findOne<StatusRow>(STATUS, { path: "/kontakt" }))!.docId;
    h.blobs.files.set("site/alt/index.html", { text: "x", contentType: "text/html" });
    const list = content.list.bind(content);
    let armed = true;
    content.list = async (type, filter, options) => {
      if (armed) {
        armed = false;
        expectOk(await h.delivery.publish("pages", kontakt));
      }
      return list(type, filter, options);
    };
    expect(expectOk(await h.delivery.resumeStale()).orphans).toBe(0);
    expect(expectOk(await h.db.findOne(STATE, { id: "orphans:candidates" }))).toBeNull();
    expect(h.blobs.files.has("site/alt/index.html")).toBe(true);
    expect(await sweep(h)).toBe(1);
  });

  it("a restore that checkBuild detects does not run it again, so files the restored database lacks stay", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    const first = await harness({ db, blobs });
    await seed(first);
    expectOk(await first.delivery.checkBuild("b1"));
    expectOk(await first.delivery.publishAll("pages"));
    expect(expectOk(await first.delivery.resumeStale()).orphans).toBe(0);
    expect(expectOk(await db.findOne(STATE, { id: "orphans" }))).not.toBeNull();
    const backup = expectOk(await db.findOne<{ id: string; value: string }>(STATE, { id: "marker" }))!.value;
    const later = await first.page({ slug: "spaeter", title: "Später", status: "published" });
    await first.delivery.close();
    expect(blobs.files.has("site/spaeter/index.html")).toBe(true);

    expectOk(await first.content.update("pages", later, { status: "draft" }, { locale: "de" }));
    expectOk(await db.deleteMany(STATUS, { docId: later }));
    expectOk(await db.updateMany(STATE, { id: "marker" }, { value: backup }));
    const restored = await harness({ db, blobs, content: first.content });
    expect(expectOk(await restored.delivery.checkBuild("b1"))).toMatchObject({ restored: true });
    expectOk(await restored.delivery.publishAll("pages"));
    expect(await sweep(restored)).toBe(0);
    expect(blobs.files.has("site/spaeter/index.html")).toBe(true);
  });

  it("a restore of a backup taken after this version first started, before the removal finished, does not run it again", async () => {
    const h = await upgraded();
    expect(expectOk(await h.delivery.checkBuild("b2"))).toMatchObject({ changed: true, restored: false });
    expect(expectOk(await h.delivery.resumeStale()).orphans).toBe(0);
    const backup = expectOk(await h.db.findOne<{ id: string; value: string }>(STATE, { id: "marker" }))!.value;
    expect(expectOk(await h.db.findOne(STATE, { id: "orphans:candidates" }))).toBeNull();
    expectOk(await h.delivery.publishAll("pages"));
    expect(await sweep(h)).toBe(0);
    expect(expectOk(await h.db.findOne(STATE, { id: "orphans" }))).not.toBeNull();
    const later = await h.page({ slug: "spaeter", title: "Später", status: "published" });
    await h.delivery.close();
    expect(h.blobs.files.has("site/spaeter/index.html")).toBe(true);

    expectOk(await h.content.update("pages", later, { status: "draft" }, { locale: "de" }));
    expectOk(await h.db.deleteMany(STATUS, { docId: later }));
    expectOk(await h.db.deleteMany(STATE, { id: { in: ["orphans", "orphans:candidates"] } }));
    expectOk(await h.db.updateMany(STATE, { id: "marker" }, { value: backup }));
    const restored = await harness({ db: h.db, blobs: h.blobs, content: h.content });
    expect(expectOk(await restored.delivery.checkBuild("b2"))).toMatchObject({ restored: true });
    expectOk(await restored.delivery.publishAll("pages"));
    expect(await sweep(restored)).toBe(0);
    expect(restored.blobs.files.has("site/spaeter/index.html")).toBe(true);
  });

  it("keeps the file of a page published at an orphaned path while the removal checks that path for an owner", async () => {
    const h = await upgraded();
    placed(h, "site/neu/index.html");
    expect(expectOk(await h.delivery.resumeStale()).orphans).toBe(0);
    h.advance(CLAIM_TTL_MS + 1);
    const count = h.db.count.bind(h.db);
    let neu: string | undefined;
    h.db.count = async (collection, filter) => {
      const answer = await count(collection, filter);
      if (neu === undefined && collection === STATUS && filter.path === "/neu") neu = await h.page({ slug: "neu", title: "Neu", status: "published" });
      return answer;
    };
    expectOk(await h.delivery.resumeStale());
    expect(neu).toBeDefined();
    expect(h.blobs.files.get("site/neu/index.html")?.text).toContain("Neu");
    expect(expectOk(await h.db.findOne<StatusRow>(STATUS, { docId: neu!, locale: "de" }))).toMatchObject({ state: "live", path: "/neu", staleToken: null });
  });

  it("does not run after an unclean stop of a process that started on an empty database against a published site", async () => {
    const blobs = memoryBlobs();
    const old = await harness({ blobs });
    await seed(old);
    expectOk(await old.delivery.checkBuild("b1"));
    expectOk(await old.delivery.resumeStale());
    await old.delivery.close();
    const oldPages = [...blobs.files.keys()].filter((k) => k.endsWith("index.html")).sort();

    const db = createFakePersistence();
    const fresh = await harness({ blobs, db });
    expect(expectOk(await fresh.delivery.checkBuild("b1"))).toMatchObject({ restored: true });
    for (const slug of ["eins", "zwei", "drei", "vier", "fuenf", "sechs"]) await fresh.page({ slug, title: slug, status: "published" });
    expectOk(await fresh.delivery.resumeStale());
    await fresh.page({ slug: "sieben", title: "Sieben", status: "published" });

    const after = await harness({ blobs, db, content: fresh.content });
    expectOk(await after.delivery.checkBuild("b1"));
    expectOk(await after.delivery.publishAll("pages"));
    expect(await sweep(after)).toBe(0);
    for (const key of oldPages) expect(blobs.files.has(key), key).toBe(true);
  });

  it("never runs on a database that held no status row when the process started, whatever files the prefix holds", async () => {
    const blobs = memoryBlobs();
    for (const key of ["site/alt/index.html", "site/en/old/index.html"]) blobs.files.set(key, { text: "x", contentType: "text/html" });
    const h = await harness({ blobs });
    await seed(h);
    expect(await sweep(h)).toBe(0);
    expect(blobs.files.has("site/alt/index.html")).toBe(true);
    expect(blobs.files.has("site/en/old/index.html")).toBe(true);
  });

  it("removes nothing when the process starts on an empty database against a published site", async () => {
    const blobs = memoryBlobs();
    const first = await harness({ blobs });
    await seed(first);
    expectOk(await first.delivery.checkBuild("b1"));
    expectOk(await first.delivery.resumeStale());
    await first.delivery.close();
    const pages = [...blobs.files.keys()].filter((k) => k.endsWith("index.html")).sort();
    expect(pages.length).toBeGreaterThan(0);

    const empty = await harness({ blobs });
    expect(expectOk(await empty.delivery.checkBuild("b1"))).toMatchObject({ changed: true, restored: true, marked: 0 });
    expect(expectOk(await empty.delivery.resumeStale()).orphans).toBe(0);
    await empty.page({ slug: "neu", title: "Neu", status: "published" });
    expect(await sweep(empty)).toBe(0);
    for (const key of pages) expect(blobs.files.has(key), key).toBe(true);
  });

  it("waits while no output is live", async () => {
    const h = await withOrphans();
    for (const row of expectOk(await h.db.findMany<StatusRow>(STATUS, { state: "live" })).items) expectOk(await h.content.update("pages", row.docId, { status: "draft" }, { locale: row.locale }));
    expectOk(await h.db.updateMany(STATUS, { state: "live" }, { state: "error" }));
    expect(await sweep(h)).toBe(0);
    expect(h.blobs.files.has("site/alt/index.html")).toBe(true);
    expect(expectOk(await h.db.findOne(STATE, { id: "orphans" }))).toBeNull();
  });

  it("gives up for good, removing nothing, when more paths look orphaned than status rows own", async () => {
    const h = await upgraded();
    for (const name of ["a", "b", "c", "d", "e", "f"]) h.blobs.files.set(`site/${name}/index.html`, { text: "x", contentType: "text/html" });
    expect(await sweep(h)).toBe(0);
    for (const name of ["a", "b", "c", "d", "e", "f"]) expect(h.blobs.files.has(`site/${name}/index.html`)).toBe(true);
    expect(h.logger.warnings.some((w) => w.includes("6 paths") && w.includes("removes nothing"))).toBe(true);
    expect(expectOk(await h.db.findOne(STATE, { id: "orphans" }))).not.toBeNull();
  });

  it("a failing removal leaves the recovery pass's own result, logs the error and is tried again on the next run", async () => {
    const h = await withOrphans();
    const list = h.blobs.list.bind(h.blobs);
    h.blobs.list = async (prefix) => (prefix === "site/" ? err(failure("TRANSIENT", "listing denied")) : list(prefix));
    const failed = expectOk(await h.delivery.resumeStale());
    expect(failed.orphans).toBe(0);
    expect(h.logger.errors).toContain("delivery/static: the one-time removal of orphaned output files failed, the next recovery pass tries again");
    h.blobs.list = list;
    expectOk(await h.delivery.resumeStale());
    h.advance(CLAIM_TTL_MS + 1);
    const remove = h.blobs.remove.bind(h.blobs);
    h.blobs.remove = async (key) => (key === "site/alt/index.html" ? err(failure("TRANSIENT", "object is locked")) : remove(key));
    expect(expectOk(await h.delivery.resumeStale()).orphans).toBe(0);
    expect(h.logger.errors.filter((e) => e === "delivery/static: could not remove an orphaned output file")).toHaveLength(1);
    h.blobs.remove = remove;
    expect(expectOk(await h.delivery.resumeStale()).orphans).toBe(2);
  });

  it("waits while outputs are marked for a re-render", async () => {
    const h = await withOrphans();
    expectOk(await h.delivery.markAll("pages"));
    h.emitted.length = 0;
    expect(await sweep(h)).toBe(0);
    expect(h.blobs.files.has("site/alt/index.html")).toBe(true);
  });
});

