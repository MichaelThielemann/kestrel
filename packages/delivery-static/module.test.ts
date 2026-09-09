import { describe, expect, it } from "vitest";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { CONTENT, type Content, type ContentDocument, type ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { ok } from "@michaelthielemann/kestrel-contracts/errors";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { RENDERER, type Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import { SITE, type Site } from "@michaelthielemann/kestrel-contracts/site";
import { createFakePersistence, matchesFilter } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import type { Step } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok as okStep } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import type { Delivery } from "./impl.ts";
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
    async get(_t, id, o) {
      const r = id === undefined ? undefined : rows.get(id);
      return ok(r ? resolve(r, o?.locale ?? "de", o?.fallback ?? false) : null);
    },
    async list(_t, filter = {}, o = {}) {
      const all = [...rows.values()].map((r) => resolve(r, o.locale ?? "de", false)).filter((d) => matchesFilter(d, filter));
      return ok({ items: all.slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? all.length)), total: all.length });
    },
    create: () => Promise.reject(new Error("n/a")),
    set: () => Promise.reject(new Error("n/a")),
    update: () => Promise.reject(new Error("n/a")),
    remove: () => Promise.reject(new Error("n/a")),
    removeTranslation: () => Promise.reject(new Error("n/a")),
  };
  const put = (id: string, values: Record<string, unknown>) => rows.set(id, { ...(rows.get(id) ?? { id }), ...values });
  return { content, put };
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

function fakeBlobs(): Blobstore {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    async put(k, data, options) {
      blobs.set(k, { data, contentType: options?.contentType ?? "application/octet-stream" });
      return ok();
    },
    async get(k) {
      return ok(blobs.get(k)?.data ?? null);
    },
    async remove(k) {
      blobs.delete(k);
      return ok();
    },
    async move(from, to) {
      const b = blobs.get(from);
      if (!b) throw new Error(`${from} not found`);
      blobs.set(to, b);
      blobs.delete(from);
      return ok();
    },
    async list(p) {
      return ok([...blobs].filter(([k]) => k.startsWith(p)).map(([key, b]) => ({ key, size: b.data.byteLength })));
    },
  };
}

function fakeRenderer(): Renderer {
  return {
    formats: () => ["html"],
    async render(input) {
      return ok({ data: `<h1>${String(input.document.title)}</h1>`, contentType: "text/html", extension: "html" });
    },
  };
}

function moduleDeps(providers: { content: Content; site: Site; renderer: Renderer; blobs: Blobstore; db: ReturnType<typeof createFakePersistence> }): Deps {
  const map = new Map<string, unknown>([
    [CONTENT.name, providers.content],
    [SITE.name, providers.site],
    [RENDERER.name, providers.renderer],
    [BLOBSTORE.name, providers.blobs],
    [PERSISTENCE.name, providers.db],
  ]);
  return {
    get<T>(contract: Contract<T>): T {
      if (!map.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
      return map.get(contract.name) as T;
    },
    find: <T>(): T | undefined => undefined,
    logger: silentLogger,
    root: process.cwd(),
  };
}

const pagesType = { slugField: "slug", statusField: "status", publishedValue: "published", home: "home" };

async function boot(renderer: Renderer = fakeRenderer()): Promise<{ instance: Delivery; put: ReturnType<typeof fakeContent>["put"] }> {
  const { content, put } = fakeContent();
  const config = configSchema.parse({ types: { pages: pagesType }, prefix: "site/" });
  const instance = (await module.setup(config, moduleDeps({ content, site, renderer, blobs: fakeBlobs(), db: createFakePersistence() }))) as Delivery;
  return { instance, put };
}

const seedId: Step = async (ctx) => okStep({ ...ctx, result: { id: ctx.params.id } });

describe("delivery/static module via runPipeline", () => {
  it("publish renders and stores the published locales of the document named by result.id", async () => {
    const { instance, put } = await boot();
    put("p1", { slug__de: "kontakt", title__de: "Kontakt", status__de: "published" });
    const pipeline = definePipeline({ name: "publish", steps: ["seed.id", "delivery.publish:pages"] });
    const result = await runPipeline(pipeline, { params: { id: "p1" } }, { modules: [{ module, instance }], steps: { "seed.id": seedId } });
    expect(result.status).toBe(200);
    expect((result.result as { delivery: Array<{ locale: string; state: string }> }).delivery).toContainEqual(expect.objectContaining({ locale: "de", state: "live" }));
  });

  it("readStatus reports publish status per locale", async () => {
    const { instance, put } = await boot();
    put("p1", { slug__de: "kontakt", title__de: "Kontakt", status__de: "published" });
    const publish = definePipeline({ name: "publish", steps: ["seed.id", "delivery.publish:pages"] });
    await runPipeline(publish, { params: { id: "p1" } }, { modules: [{ module, instance }], steps: { "seed.id": seedId } });
    const pipeline = definePipeline({ name: "readStatus", steps: ["delivery.readStatus:pages"] });
    const result = await runPipeline(pipeline, { params: { id: "p1" } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(Array.isArray(result.result)).toBe(true);
  });

  it("unpublish removes the rendered output", async () => {
    const { instance, put } = await boot();
    put("p1", { slug__de: "kontakt", title__de: "Kontakt", status__de: "published" });
    const publish = definePipeline({ name: "publish", steps: ["seed.id", "delivery.publish:pages"] });
    await runPipeline(publish, { params: { id: "p1" } }, { modules: [{ module, instance }], steps: { "seed.id": seedId } });
    const pipeline = definePipeline({ name: "unpublish", steps: ["delivery.unpublish:pages"] });
    const result = await runPipeline(pipeline, { params: { id: "p1" } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
  });

  it("publishAll re-renders every document of the type", async () => {
    const { instance, put } = await boot();
    put("p1", { slug__de: "p1", title__de: "1", status__de: "published" });
    const pipeline = definePipeline({ name: "publishAll", steps: ["delivery.publishAll:pages"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ documents: 1, live: 1, errors: 0 });
  });

  it("exportLlms writes llms.txt from the live output of every delivered type", async () => {
    const { instance, put } = await boot();
    put("p1", { slug__de: "p1", title__de: "1", status__de: "published" });
    const publish = definePipeline({ name: "publish", steps: ["seed.id", "delivery.publish:pages"] });
    await runPipeline(publish, { params: { id: "p1" } }, { modules: [{ module, instance }], steps: { "seed.id": seedId } });
    const pipeline = definePipeline({ name: "exportLlms", steps: ["delivery.exportLlms"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ llms: { entries: 1, full: false } });
  });

  it("readStatus answers VALIDATION without params.id (no step in this package declares a payload schema)", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "readStatus-invalid", steps: ["delivery.readStatus:pages"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
  });
});
