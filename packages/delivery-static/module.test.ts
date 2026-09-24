import { describe, expect, it } from "vitest";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { CONTENT, type Content, type ContentDocument, type ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { ok } from "@michaelthielemann/kestrel-contracts/errors";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { RENDERER, type Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import { SITE, type Site } from "@michaelthielemann/kestrel-contracts/site";
import { createFakePersistence, matchesFilter } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Step } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps, StepDescription } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok as okStep } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import type { Delivery } from "./impl.ts";
import type { Introspection, Manifest } from "@michaelthielemann/kestrel";
import module, { checkEventsWiring, configSchema } from "./module.ts";

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

function fakeBlobs(): Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> } {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    blobs,
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
      return boundaryCast<T>(map.get(contract.name), "host");
    },
    find: <T>(): T | undefined => undefined,
    logger: silentLogger,
    root: process.cwd(),
    eventTriggers: [],
  };
}

const pagesType = { slugField: "slug", statusField: "status", publishedValue: "published", home: "home" };

async function boot(renderer: Renderer = fakeRenderer()): Promise<{ instance: Delivery; put: ReturnType<typeof fakeContent>["put"]; blobs: ReturnType<typeof fakeBlobs> }> {
  const { content, put } = fakeContent();
  const config = configSchema.parse({ types: { pages: pagesType }, prefix: "site/" });
  const blobs = fakeBlobs();
  const instance = boundaryCast<Delivery>(await module.setup(config, moduleDeps({ content, site, renderer, blobs, db: createFakePersistence() })), "host");
  return { instance, put, blobs };
}

const seedId: Step = async (ctx) => okStep({ ...ctx, result: { id: ctx.params.id } });

describe("delivery/static module via runPipeline", () => {
  it("publish renders and stores the published locales of the document named by result.id, merging `_delivery` into the result", async () => {
    const { instance, put } = await boot();
    put("p1", { slug__de: "kontakt", title__de: "Kontakt", status__de: "published" });
    const pipeline = definePipeline({ name: "publish", steps: ["seed.id", "delivery.publish:pages"] });
    const result = await runPipeline(pipeline, { params: { id: "p1" } }, { modules: [{ module, instance }], steps: { "seed.id": seedId } });
    expect(result.status).toBe(200);
    const body = boundaryCast<{ id: string; _delivery: Array<{ locale: string; state: string }> }>(result.result, "host");
    expect(body.id).toBe("p1");
    expect(body._delivery).toContainEqual(expect.objectContaining({ locale: "de", state: "live" }));
  });

  it("publish falls back to the event payload's id when the result has none", async () => {
    const { instance, put } = await boot();
    put("p1", { slug__de: "kontakt", title__de: "Kontakt", status__de: "published" });
    const pipeline = definePipeline({ name: "publish", steps: ["delivery.publish:pages"] });
    const result = await runPipeline(pipeline, { payload: { id: "p1" } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(boundaryCast<{ _delivery: Array<{ locale: string; state: string }> }>(result.result, "host")._delivery).toContainEqual(expect.objectContaining({ locale: "de", state: "live" }));
  });

  it("publish answers 400 VALIDATION when neither the result nor the payload names a document", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "publish", steps: ["delivery.publish:pages"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
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
    const { instance, put, blobs } = await boot();
    put("p1", { slug__de: "kontakt", title__de: "Kontakt", status__de: "published" });
    const publish = definePipeline({ name: "publish", steps: ["seed.id", "delivery.publish:pages"] });
    await runPipeline(publish, { params: { id: "p1" } }, { modules: [{ module, instance }], steps: { "seed.id": seedId } });
    const publishedKeys = [...blobs.blobs.keys()];
    expect(publishedKeys.length).toBeGreaterThan(0);
    const pipeline = definePipeline({ name: "unpublish", steps: ["delivery.unpublish:pages"] });
    const result = await runPipeline(pipeline, { params: { id: "p1" } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    for (const key of publishedKeys) expect(blobs.blobs.has(key)).toBe(false);
  });

  it("unpublish falls back to the event payload's id when params carries none", async () => {
    const { instance, put, blobs } = await boot();
    put("p1", { slug__de: "kontakt", title__de: "Kontakt", status__de: "published" });
    const publish = definePipeline({ name: "publish", steps: ["seed.id", "delivery.publish:pages"] });
    await runPipeline(publish, { params: { id: "p1" } }, { modules: [{ module, instance }], steps: { "seed.id": seedId } });
    const publishedKeys = [...blobs.blobs.keys()];
    const pipeline = definePipeline({ name: "unpublish", steps: ["delivery.unpublish:pages"] });
    const result = await runPipeline(pipeline, { payload: { id: "p1" } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    for (const key of publishedKeys) expect(blobs.blobs.has(key)).toBe(false);
  });

  it("unpublish answers 400 VALIDATION when neither params nor the payload names a document", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "unpublish", steps: ["delivery.unpublish:pages"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
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
    expect(result.result).toMatchObject({ _llms: { entries: 1, full: false } });
  });

  it("readStatus answers VALIDATION without params.id (no step in this package declares a payload schema)", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "readStatus-invalid", steps: ["delivery.readStatus:pages"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
  });
});

describe("delivery/static: atomicSafe is pinned", () => {
  it("matches the shipped table", async () => {
    const { instance } = await boot();
    const describeMap = boundaryCast<Record<string, StepDescription | ((arg: string) => StepDescription)>>(module.describe!(instance), "host");
    const expected: Record<string, boolean> = { readStatus: true, publish: false, unpublish: false, publishAll: false, exportLlms: false, markDependents: false, markAll: false, checkBuild: false, republishOutput: false, requestLlms: false, resumeStale: false, retryStale: false, readStaleStatus: true };
    for (const [name, expect_] of Object.entries(expected)) {
      const description = describeMap[name];
      const resolved = typeof description === "function" ? description("pages") : description;
      expect(resolved?.atomicSafe === true, `${name}.atomicSafe`).toBe(expect_);
    }
  });
});

function introspection(parts: { pipelines: Array<{ name: string; steps: string[] }>; events: Array<{ event: string; pipeline: string }>; hook: string }): Introspection {
  const manifest: Manifest = {
    core: { version: "0.0.0" },
    contracts: [],
    modules: [{ name: parts.hook, use: parts.hook, version: null, provides: [], requires: [], optional: [], config: { schema: {}, variables: [] }, steps: [], eventHook: true, atomicScope: false, emits: [] }],
    steps: [],
    pipelines: parts.pipelines.map((p) => ({ name: p.name, steps: p.steps.map((step) => ({ spec: step, name: step, module: "delivery/static", description: { summary: "", reads: [], writes: [] } })) })),
    triggers: { http: [], events: parts.events, crons: [] },
    warnings: [],
  };
  return { describe: () => manifest, observe: () => () => {}, health: () => ({ ok: true, restartRequired: false, modules: [] }) };
}

describe("delivery/static: dependencies config and the events wiring", () => {
  const wired = {
    pipelines: [
      { name: "republishOutput", steps: ["delivery.republishOutput"] },
      { name: "refreshLlms", steps: ["delivery.exportLlms"] },
    ],
    events: [
      { event: "delivery.outputStale", pipeline: "republishOutput" },
      { event: "delivery.llmsStale", pipeline: "refreshLlms" },
    ],
  };

  it("defaults to the background loop with the documented bounds", () => {
    expect(configSchema.parse({ types: {} }).dependencies).toEqual({ render: "background", rendererReadsDocument: false, maxPerRender: 1000, renderTimeoutSeconds: 60, maxAttempts: 5, backoffSeconds: [60, 300, 900, 3600], claimTtlSeconds: 300, maxAgeSeconds: null });
  });

  it("refuses a render timeout that is not below the claim lifetime, naming both keys", () => {
    const parsed = configSchema.safeParse({ types: {}, dependencies: { renderTimeoutSeconds: 300, claimTtlSeconds: 300 } });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("dependencies.renderTimeoutSeconds (300) must be below dependencies.claimTtlSeconds (300)");
  });

  it("accepts the queue wiring", () => {
    expect(() => checkEventsWiring(introspection({ ...wired, hook: "events/queue" }))).not.toThrow();
  });

  it("refuses render \"events\" without a job trigger for delivery.outputStale", () => {
    expect(() => checkEventsWiring(introspection({ ...wired, events: [wired.events[1]!], hook: "events/queue" }))).toThrow('dependencies.render "events" needs a trigger that runs a pipeline with delivery.republishOutput on "delivery.outputStale"');
  });

  it("refuses render \"events\" when the delivery.outputStale trigger runs a pipeline without delivery.republishOutput", () => {
    const events = [{ event: "delivery.outputStale", pipeline: "refreshLlms" }, wired.events[1]!];
    expect(() => checkEventsWiring(introspection({ ...wired, events, hook: "events/queue" }))).toThrow(/delivery\.republishOutput/);
  });

  it("refuses render \"events\" without an export trigger for delivery.llmsStale", () => {
    expect(() => checkEventsWiring(introspection({ ...wired, events: [wired.events[0]!], hook: "events/queue" }))).toThrow('dependencies.render "events" needs a trigger that runs a pipeline with delivery.exportLlms on "delivery.llmsStale"');
  });

  it("refuses render \"events\" under events/direct, which would render inside the marking request", () => {
    expect(() => checkEventsWiring(introspection({ ...wired, hook: "events/direct" }))).toThrow(/events\/direct/);
  });

  it("refuses render \"events\" without an events@1 provider at setup", async () => {
    const { content } = fakeContent();
    const config = configSchema.parse({ types: { pages: pagesType }, dependencies: { render: "events" } });
    await expect(module.setup(config, moduleDeps({ content, site, renderer: fakeRenderer(), blobs: fakeBlobs(), db: createFakePersistence() }))).rejects.toThrow('dependencies.render "events" needs an events@1 provider');
  });
});

describe("delivery/static dependency steps via runPipeline", () => {
  it("markDependents reads the changed ids from payload id and ids and adds _dependents", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "dependents", steps: ["delivery.markDependents:speakers"] });
    const result = await runPipeline(pipeline, { payload: { id: null, ids: ["a", "b"] } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toEqual({ _dependents: { marked: 0 } });
  });

  it("checkBuild answers VALIDATION without a build", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "checkBuild", steps: ["delivery.checkBuild"] });
    const result = await runPipeline(pipeline, { payload: {} }, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
  });

  it("checkBuild, markAll, readStaleStatus and a publish answer their declared shapes", async () => {
    const { instance, put } = await boot();
    put("p1", { slug__de: "kontakt", title__de: "Kontakt", status__de: "published" });
    const publish = await runPipeline(definePipeline({ name: "publish", steps: ["delivery.publish:pages"] }), { payload: { id: "p1" } }, { modules: [{ module, instance }] });
    expect(boundaryCast<{ _delivery: unknown[] }>(publish.result, "host")._delivery[0]).toMatchObject({ locale: "de", state: "live", stale: false, staleSince: null, staleFailed: false, staleError: null, dependencies: 0 });
    const checked = await runPipeline(definePipeline({ name: "checkBuild", steps: ["delivery.checkBuild"] }), { payload: { build: "b1" } }, { modules: [{ module, instance }] });
    expect(checked.result).toEqual({ changed: true, marked: 2 });
    const all = await runPipeline(definePipeline({ name: "publishAll", steps: ["delivery.markAll:pages"] }), {}, { modules: [{ module, instance }] });
    expect(all.result).toEqual({ marked: 2 });
    const status = await runPipeline(definePipeline({ name: "staleStatus", steps: ["delivery.readStaleStatus"] }), {}, { modules: [{ module, instance }] });
    expect(status.status).toBe(200);
    expect(status.result).toMatchObject({ failed: 0, abandoned: 0 });
    await instance.close();
  });

  it("republishOutput answers VALIDATION without type, docId and locale", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "republishOutput", steps: ["delivery.republishOutput"] });
    const result = await runPipeline(pipeline, { payload: { type: "pages" } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
  });
});
