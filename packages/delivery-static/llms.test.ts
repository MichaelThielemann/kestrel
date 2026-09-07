import { describe, it, expect } from "vitest";
import type { Blob, Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentDocument, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import type { Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import type { Site } from "@michaelthielemann/kestrel-contracts/site";
import { ok } from "@michaelthielemann/kestrel-contracts/errors";
import { createFakePersistence, matchesFilter } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { createDeliveryStatic, type Config } from "./impl.ts";
import { configSchema } from "./module.ts";
import { absolutize, buildLlmsFullTxt, buildLlmsTxt, extractMain, htmlToMarkdown } from "./llms.ts";

describe("llms builders (pure)", () => {
  it("writes llms.txt with header, blockquote and one section per type", () => {
    const out = buildLlmsTxt({
      siteName: "Example\nSite",
      siteDescription: "# A demo\nsite",
      sections: [
        { heading: "pages", entries: [{ title: "Kontakt [DE]", url: "https://example.org/kontakt", description: "Adresse\nund Zeiten" }, { title: "Home", url: "https://example.org/" }] },
        { heading: "empty", entries: [] },
      ],
    });
    expect(out).toBe(["# Example Site", "", "> \\# A demo site", "", "## pages", "", "- [Kontakt \\[DE\\]](https://example.org/kontakt): Adresse und Zeiten", "- [Home](https://example.org/)", ""].join("\n"));
  });

  it("writes llms-full.txt with Source lines and bodies", () => {
    const out = buildLlmsFullTxt({ siteName: "Site", sections: [{ heading: "pages", pages: [{ title: "Home", url: "/", description: "- lead", body: "#### Intro\n\nText" }, { title: "Empty", url: "/e", body: "" }] }] });
    expect(out).toBe("# Site\n\n## pages\n\n### Home\n\nSource: /\n\n\\- lead\n\n#### Intro\n\nText\n\n### Empty\n\nSource: /e\n");
  });

  it("extracts the <main> element greedily", () => {
    expect(extractMain('<body><nav>x</nav><main class="a"><p>1</p><main>2</main></main><footer/></body>')).toBe("<p>1</p><main>2</main>");
    expect(extractMain("<body><p>no main</p></body>")).toBeNull();
  });

  it("absolutizes root-relative URLs only", () => {
    expect(absolutize("/kontakt", "https://example.org")).toBe("https://example.org/kontakt");
    expect(absolutize("/kontakt", undefined)).toBe("/kontakt");
    expect(absolutize("//cdn.example.org/x.js", "https://example.org")).toBe("//cdn.example.org/x.js");
    expect(absolutize("https://other.org/", "https://example.org")).toBe("https://other.org/");
    expect(absolutize("#top", "https://example.org")).toBeNull();
    expect(absolutize("javascript:alert(1)", "https://example.org")).toBeNull();
    expect(absolutize(null, "https://example.org")).toBeNull();
  });

  it("converts HTML to Markdown with heading offset, absolute links and stripped chrome", () => {
    const html = '<h1>Titel</h1><script>x()</script><p>Hallo <a href="/kontakt">Kontakt</a> und <a href="#top">oben</a></p><img src="/media/a.jpg" alt="Bild"><ul><li>eins</li><li>zwei</li></ul><h6>Tief</h6><button>Klick</button>';
    expect(htmlToMarkdown(html, { siteUrl: "https://example.org", headingOffset: 3 })).toBe("#### Titel\n\nHallo [Kontakt](https://example.org/kontakt) und oben\n\n![Bild](https://example.org/media/a.jpg)\n\n-   eins\n-   zwei\n\n###### Tief");
  });
});

const model: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: { kind: "multi", fields: { slug: { type: "slug", localized: true, required: true }, title: { type: "text", localized: true }, status: { type: "enum", options: ["draft", "published"], localized: true }, seo: { type: "json", localized: true } } },
    settings: { kind: "single", fields: { title: { type: "text", localized: true }, description: { type: "text", localized: true } } },
  },
};

function fakeContent() {
  const rows = new Map<string, Record<string, unknown>>();
  const fields: Record<string, string[]> = { pages: ["slug", "title", "status", "seo"], settings: ["title", "description"] };
  const resolve = (type: string, row: Record<string, unknown>, locale: string, fallback: boolean): ContentDocument => {
    const pick = (f: string) => row[`${f}__${locale}`] ?? (fallback ? row[`${f}__de`] : undefined) ?? null;
    return { id: row.id as string, createdAt: 1, updatedAt: 1, ...Object.fromEntries((fields[type] ?? []).map((f) => [f, pick(f)])) };
  };
  const content: Content = {
    model: () => model,
    validate: () => ({ ok: true, data: {} }),
    async get(type, id, o) { const r = rows.get(id ?? type); return ok(r ? resolve(type, r, o?.locale ?? "de", o?.fallback ?? false) : null); },
    async list(type, filter = {}, o = {}) { const all = [...rows.values()].filter((r) => r.type === type).map((r) => resolve(type, r, o.locale ?? "de", false)).filter((d) => matchesFilter(d, filter)); return ok({ items: all.slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? all.length)), total: all.length }); },
    create: () => Promise.reject(new Error("n/a")),
    set: () => Promise.reject(new Error("n/a")),
    update: () => Promise.reject(new Error("n/a")),
    remove: () => Promise.reject(new Error("n/a")),
    removeTranslation: () => Promise.reject(new Error("n/a")),
  };
  const put = (type: string, id: string, values: Record<string, unknown>) => rows.set(id, { ...(rows.get(id) ?? { id, type }), ...values });
  return { content, put };
}

const site: Site = {
  resolve: () => Promise.reject(new Error("n/a")),
  pathOf(_t, doc, o = {}) {
    const slug = doc.slug;
    if (typeof slug !== "string" || slug === "") return null;
    const prefixed = o.locale !== undefined && o.locale !== model.defaultLocale;
    return `/${[...(prefixed ? [o.locale] : []), ...(slug === o.rules?.home ? [] : [slug])].join("/")}`;
  },
  resolveLinks: async (_t, doc) => ok(doc),
};

function fakeBlobs(): Blobstore & { text(key: string): string | undefined } {
  const blobs = new Map<string, Blob>();
  return {
    text: (key) => { const b = blobs.get(key); return b ? new TextDecoder().decode(b.data) : undefined; },
    async put(k, b) { blobs.set(k, b); return ok(); },
    async get(k) { return ok(blobs.get(k) ?? null); },
    async remove(k) { blobs.delete(k); return ok(); },
    async move() { throw new Error("n/a"); },
    async list(p) { return ok([...blobs].filter(([k]) => k.startsWith(p)).map(([key, b]) => ({ key, size: b.data.byteLength, contentType: b.contentType }))); },
  };
}

const renderer: Renderer = {
  formats: () => ["html"],
  async render(input) {
    return ok({ data: `<html><body><nav>Menu</nav><main><h1>${String(input.document.title)}</h1><p>Body of <a href="/kontakt">${input.path}</a></p></main></body></html>`, contentType: "text/html", extension: "html" });
  },
};

function fakeLogger(): Logger & { errors: string[]; infos: string[] } {
  const errors: string[] = [];
  const infos: string[] = [];
  return { errors, infos, step() {}, info(m) { infos.push(m); }, error(m) { errors.push(m); } };
}

const base: Config = configSchema.parse({ types: { pages: {} }, prefix: "site/" });
const llms = { full: false, settings: { type: "settings", titleField: "title", descriptionField: "description" }, titleField: "title", seoField: "seo", headings: {} };

async function setup(config: Config) {
  const { content, put } = fakeContent();
  const blobs = fakeBlobs();
  const logger = fakeLogger();
  const delivery = await createDeliveryStatic(config, { content, site, renderer, blobs, db: createFakePersistence(), logger }, () => 42);
  put("settings", "settings", { title__de: "Example Site", description__de: "A demo site" });
  put("pages", "p1", { slug__de: "home", title__de: "Start", status__de: "published", status__en: "published", seo__de: { description: "Die Startseite" } });
  put("pages", "p2", { slug__de: "kontakt", slug__en: "contact", title__de: "Kontakt", title__en: "Contact", status__de: "published", status__en: "published", seo__en: { title: "Contact us" } });
  put("pages", "p3", { slug__de: "intern", title__de: "Intern", status__de: "published", seo__de: { noindex: true } });
  put("pages", "p4", { slug__de: "entwurf", title__de: "Entwurf", status__de: "draft" });
  for (const id of ["p1", "p2", "p3", "p4"]) expectOk(await delivery.publish("pages", id));
  return { delivery, blobs, logger, put };
}

describe("delivery/static llms export", () => {
  it("validates the llms config against model and formats", async () => {
    const { content } = fakeContent();
    const deps = { content, site, renderer, blobs: fakeBlobs(), db: createFakePersistence(), logger: fakeLogger() };
    await expect(createDeliveryStatic({ ...base, llms: { ...llms, settings: { ...llms.settings, type: "nope" } } }, deps)).resolves.toBeDefined();
    await expect(createDeliveryStatic({ ...base, llms: { ...llms, settings: { ...llms.settings, type: "pages" } } }, deps)).rejects.toThrow(/single type/);
    await expect(createDeliveryStatic({ ...base, llms: { ...llms, settings: { ...llms.settings, titleField: "name" } } }, deps)).rejects.toThrow(/does not exist/);
    await expect(createDeliveryStatic({ ...base, formats: ["pdf"], llms: { ...llms, full: true } }, { ...deps, renderer: { formats: () => ["pdf"], render: (input) => renderer.render(input) } })).rejects.toThrow(/needs "html"/);
  });

  it("is enabled by default with paths only and no full file", () => {
    expect(configSchema.parse({ types: {} }).llms).toEqual({ full: false, settings: { type: "settings", titleField: "title", descriptionField: "description" }, titleField: "title", seoField: "seo", headings: {} });
  });

  it("falls back to the host or 'Website' when the model has no settings type", async () => {
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const delivery = await createDeliveryStatic({ ...base, llms: { ...llms, siteUrl: "https://example.org", settings: { ...llms.settings, type: "nope" } } }, { content, site, renderer, blobs, db: createFakePersistence(), logger: fakeLogger() });
    put("pages", "p1", { slug__de: "home", title__de: "Start", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    expectOk(await delivery.exportLlms());
    expect(blobs.text("site/llms.txt")).toBe("# example.org\n\n## pages\n\n- [Start](https://example.org/)\n");
  });

  it("writes llms.txt from live locales, skipping noindex and drafts, with absolute URLs", async () => {
    const { delivery, blobs } = await setup({ ...base, llms: { ...llms, siteUrl: "https://example.org/", headings: { pages: "Seiten" } } });
    expect(expectOk(await delivery.exportLlms())).toEqual({ entries: 4, full: false });
    expect(blobs.text("site/llms.txt")).toBe(
      ["# Example Site", "", "> A demo site", "", "## Seiten", "", "- [Start](https://example.org/): Die Startseite", "- [Start](https://example.org/en): Die Startseite", "- [Contact us](https://example.org/en/contact)", "- [Kontakt](https://example.org/kontakt)", ""].join("\n"),
    );
    expect(blobs.text("site/llms-full.txt")).toBeUndefined();
  });

  it("emits paths without siteUrl and falls back to the type name and 'Website'", async () => {
    const { delivery, blobs, put } = await setup({ ...base, llms });
    put("settings", "settings", { title__de: "", description__de: "" });
    expectOk(await delivery.exportLlms());
    expect(blobs.text("site/llms.txt")).toBe(["# Website", "", "## pages", "", "- [Start](/): Die Startseite", "- [Start](/en): Die Startseite", "- [Contact us](/en/contact)", "- [Kontakt](/kontakt)", ""].join("\n"));
  });

  it("writes llms-full.txt from the <main> of the stored HTML and removes it once disabled", async () => {
    const { delivery, blobs, logger } = await setup({ ...base, llms: { ...llms, full: true, siteUrl: "https://example.org" } });
    expect(expectOk(await delivery.exportLlms())).toEqual({ entries: 4, full: true });
    const full = blobs.text("site/llms-full.txt")!;
    expect(full.startsWith("# Example Site\n\n> A demo site\n\n## pages\n\n### Start\n\nSource: https://example.org/\n\nDie Startseite\n\n#### Start\n\nBody of [/](https://example.org/kontakt)\n\n### Start\n\nSource: https://example.org/en\n\n")).toBe(true);
    expect(full).not.toContain("Menu");
    expect(full).not.toContain("Intern");
    expect(logger.errors).toEqual([]);

    expectOk(await blobs.remove("site/en/contact/index.html"));
    expectOk(await delivery.exportLlms());
    expect(logger.errors).toEqual(["delivery/static: rendered output missing for llms-full.txt"]);
    expect(blobs.text("site/llms-full.txt")).toContain("### Contact us\n\nSource: https://example.org/en/contact\n\n### Kontakt");

    const off = await createDeliveryStatic({ ...base, llms }, { content: fakeContent().content, site, renderer, blobs, db: createFakePersistence(), logger });
    expectOk(await off.exportLlms());
    expect(blobs.text("site/llms-full.txt")).toBeUndefined();
    expect(blobs.text("site/llms.txt")).toBe("# Website\n");
  });

  it("uses the whole body when the renderer emits no <main>", async () => {
    const noMain: Renderer = { formats: () => ["html"], render: async (input) => ok({ data: `<html><body><p>${String(input.document.title)}</p></body></html>`, contentType: "text/html", extension: "html" }) };
    const { content, put } = fakeContent();
    const blobs = fakeBlobs();
    const logger = fakeLogger();
    const delivery = await createDeliveryStatic({ ...base, llms: { ...llms, full: true } }, { content, site, renderer: noMain, blobs, db: createFakePersistence(), logger });
    put("pages", "p1", { slug__de: "home", title__de: "Start", status__de: "published" });
    expectOk(await delivery.publish("pages", "p1"));
    expectOk(await delivery.exportLlms());
    expect(blobs.text("site/llms-full.txt")).toContain("### Start\n\nSource: /\n\nStart\n");
    expect(logger.infos).toEqual(["delivery/static: rendered output without <main>, llms-full.txt uses the whole body"]);
  });
});
