import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { z } from "zod";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { MEDIA } from "@michaelthielemann/kestrel-contracts/media";
import { createFakeMedia, type FakeMedia } from "@michaelthielemann/kestrel-contracts/testing/fakeMedia";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boot, KestrelBootError, type Introspection, type Manifest, type ModuleDefinition } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createContext, type Context, type Step, type StepFactory } from "@michaelthielemann/kestrel/context";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger, type Logger } from "@michaelthielemann/kestrel/logger";
import { validateSchema } from "@michaelthielemann/kestrel/schema";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import module, { configSchema } from "./module.ts";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_RENDER_TIMEOUT_MS, JOBS, VARIANTS, createImages, whenIdle, type Config, type Images, type Job, type Variant } from "./impl.ts";
import type { Renderer } from "./generate.ts";

function fakeBlobstore(): Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> } {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    blobs,
    async put(key, data, options) { blobs.set(key, { data, contentType: options?.contentType ?? "application/octet-stream" }); return ok(); },
    async get(key) { return ok(blobs.get(key)?.data ?? null); },
    async remove(key) { blobs.delete(key); return ok(); },
    async move(from, to) { const b = blobs.get(from); if (!b) return err(failure("NOT_FOUND", `${from} not found`)); blobs.set(to, b); blobs.delete(from); return ok(); },
    async list(prefix) { return ok([...blobs].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.data.byteLength }))); },
  };
}

interface ImageSteps {
  register: Step;
  listSizes: Step;
  plan: Step;
  generate: Step;
  sync: Step;
  resume: Step;
  retryFailed: Step;
  prune: Step;
  readStatus: Step;
  remove: Step;
  removeMany: Step;
  attach: Step;
  serve: Step;
  syncPublic: Step;
  export: StepFactory;
}

const OBJECT_BINDING_PROOF_FILE = join(process.cwd(), "node_modules", ".cache", "kestrel-object-binding-proofs.ndjson");

function provesObjectBinding(moduleName: string, step: string): void {
  mkdirSync(dirname(OBJECT_BINDING_PROOF_FILE), { recursive: true });
  appendFileSync(OBJECT_BINDING_PROOF_FILE, `${moduleName}#${step}\n`);
}

function fakeCtx(overrides: Partial<Context> = {}): Context {
  return { ...createContext({ trigger: { kind: "http", name: "t" } }), ...overrides };
}

function introspectionOf(manifest: Manifest): Introspection {
  return { describe: () => manifest, observe: () => () => {}, health: () => ({ ok: true, restartRequired: false, modules: [] }) };
}
function manifestWithPipelines(names: Array<{ pipeline: string; module: string; step: string }>): Manifest {
  return {
    core: { version: "0.0.0" },
    contracts: [],
    modules: [],
    steps: [],
    pipelines: [...new Set(names.map((n) => n.pipeline))].map((pipeline) => ({
      name: pipeline,
      steps: names.filter((n) => n.pipeline === pipeline).map((n) => ({ spec: n.step, name: n.step, module: n.module, description: { summary: "", reads: [], writes: [] } })),
    })),
    triggers: { http: [], events: [], crons: [] },
    warnings: [],
  };
}

const noLogger: Logger = { step() {}, info() {}, error() {} };
const baseConfig: Config = { prefix: "media-variants/", publicPath: "/media", chunk: 20, staleAfterMs: 60000, maxAttempts: DEFAULT_MAX_ATTEMPTS, renderTimeoutMs: DEFAULT_RENDER_TIMEOUT_MS };

async function jpeg(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } }).jpeg().toBuffer();
}

async function make(config: Partial<Config> = {}) {
  const blobs = fakeBlobstore();
  const db = createFakePersistence();
  const media = createFakeMedia();
  const images = await createImages({ ...baseConfig, ...config }, { blobs, db, media, logger: noLogger });
  const steps: ImageSteps = module.steps!(images);
  return { images, blobs, db, media, steps };
}

function addImage(media: FakeMedia, id: string, data: Uint8Array, contentType = "image/jpeg"): void {
  media.add({ id, contentType, data, filename: `${id}.jpg`, createdAt: 1000 });
}

describe("images/default configSchema", () => {
  it("applies defaults", () => {
    const parsed = configSchema.parse({});
    expect(parsed).toEqual({ prefix: "media-variants/", publicPath: "/media", chunk: 20, staleAfterMs: 60000, maxAttempts: 5, renderTimeoutMs: 30000 });
    expect(parsed.publicCopy).toBeUndefined();
  });

  it("rejects a media option: media is read through media@1, never from a configured collection", () => {
    const parsed = configSchema.safeParse({ media: { collection: "media_items" } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe('Unrecognized key: "media"');
  });

  it("rejects unknown keys and an invalid publicPath", () => {
    expect(configSchema.safeParse({ nope: true }).success).toBe(false);
    expect(configSchema.safeParse({ publicPath: "/media/" }).success).toBe(false);
    expect(configSchema.safeParse({ publicPath: "/api/media" }).success).toBe(true);
    expect(configSchema.safeParse({ publicCopy: { prefix: "site/" } }).success).toBe(true);
  });

  it("rejects a renderTimeoutMs that is not less than staleAfterMs, so a render ends before its lease on the item runs out", () => {
    const parsed = configSchema.safeParse({ staleAfterMs: 30000, renderTimeoutMs: 30000 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({ path: ["renderTimeoutMs"], message: "renderTimeoutMs must be less than staleAfterMs" });
    expect(configSchema.safeParse({ staleAfterMs: 30001, renderTimeoutMs: 30000 }).success).toBe(true);
  });

  it("compares renderTimeoutMs with the default staleAfterMs, and reports it next to another invalid option", () => {
    expect(configSchema.safeParse({ renderTimeoutMs: 60000 }).error?.issues).toMatchObject([{ path: ["renderTimeoutMs"], message: "renderTimeoutMs must be less than staleAfterMs" }]);
    expect(configSchema.safeParse({ staleAfterMs: 20000, chunk: 0 }).error?.issues).toMatchObject([
      { path: ["chunk"], message: "Too small: expected number to be >=1" },
      { path: ["renderTimeoutMs"], message: "renderTimeoutMs must be less than staleAfterMs" },
    ]);
  });
});

describe("images/default at boot", () => {
  const empty = z.object({}).strict();
  const blobstoreModule: ModuleDefinition = { name: "blobstore/memory", provides: [BLOBSTORE], requires: [], configSchema: empty, setup: async () => fakeBlobstore() };
  const persistenceModule: ModuleDefinition = { name: "persistence/memory", provides: [PERSISTENCE], requires: [], configSchema: empty, setup: async () => createFakePersistence() };
  const mediaModule: ModuleDefinition = { name: "media/memory", provides: [MEDIA], requires: [], configSchema: empty, setup: async () => createFakeMedia() };
  const images = (config: Record<string, unknown> = {}) => ({ use: "@michaelthielemann/kestrel-images-default", config });

  it("fails without a media@1 provider, naming the contract", async () => {
    const booting = boot({ config: { modules: [{ use: "./blobstore-memory" }, { use: "./persistence-memory" }, images()], triggers: [] }, modules: [blobstoreModule, persistenceModule, module], pipelines: [], logger: silentLogger });
    await expect(booting).rejects.toThrow(new KestrelBootError("images/default", 'requires "media@1" but no active module provides it', "missing-provider"));
    await expect(booting).rejects.toMatchObject({ code: "missing-provider" });
  });

  it("fails with a media option in its config", async () => {
    const booting = boot({ config: { modules: [{ use: "./blobstore-memory" }, { use: "./persistence-memory" }, { use: "./media-memory" }, images({ media: { collection: "media_items" } })], triggers: [] }, modules: [blobstoreModule, persistenceModule, mediaModule, module], pipelines: [], logger: silentLogger });
    await expect(booting).rejects.toThrow(new KestrelBootError("images/default", 'invalid config: (root): Unrecognized key: "media"', "invalid-module-config"));
  });

  it("boots with a media@1 provider and requires it", async () => {
    expect(module.requires).toContain(MEDIA);
    expect(module.emits).toEqual(["images.variantsChanged"]);
    const kestrel = await boot({ config: { modules: [{ use: "./blobstore-memory" }, { use: "./persistence-memory" }, { use: "./media-memory" }, images()], triggers: [], http: null }, modules: [blobstoreModule, persistenceModule, mediaModule, module], pipelines: [], logger: silentLogger });
    expect(kestrel.describe().modules.find((m) => m.name === "images/default")?.requires).toEqual(["blobstore@1", "persistence@1", "media@1"]);
    await kestrel.stop();
  });
});

describe("register step", () => {
  it("answers VALIDATION for an empty list", async () => {
    const { steps } = await make();
    const error = expectErr(await steps.register(fakeCtx({ payload: { sizes: [] } })), "VALIDATION");
    expect(error.status).toBe(400);
    expect(error.message).toContain("images: registry must not be empty");
  });

  it("answers CONFLICT for a config collision", async () => {
    const { steps } = await make({ sizes: [{ name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 }] });
    const error = expectErr(await steps.register(fakeCtx({ payload: { sizes: [{ name: "thumb", width: 999 }] } })), "CONFLICT");
    expect(error.status).toBe(409);
    expect(error.message).toContain('images: size "thumb" is defined in config');
  });
});

describe("plan step", () => {
  it("writes result.id for a single id, result.ids for a batch", async () => {
    const { media, steps } = await make();
    addImage(media, "a", await jpeg(400, 300));
    const single = expectOk(await steps.plan(fakeCtx({ payload: { id: "a" } })));
    expect(boundaryCast<{ id: string }>(single.result, "host")).toEqual({ id: "a" });

    addImage(media, "b", await jpeg(400, 300));
    const batch = expectOk(await steps.plan(fakeCtx({ payload: { ids: ["a", "b"] } })));
    expect(boundaryCast<{ ids: string[] }>(batch.result, "host")).toEqual({ ids: ["a", "b"] });
  });

  it("answers VALIDATION without a media id", async () => {
    const { steps } = await make();
    expectErr(await steps.plan(fakeCtx()), "VALIDATION");
  });
});

describe("sync step", () => {
  it("answers CONFLICT for a fresh running job", async () => {
    const { images, media, steps } = await make({ chunk: 1 });
    addImage(media, "a", await jpeg(200, 200));
    expectOk(await images.sync());
    const error = expectErr(await steps.sync(fakeCtx()), "CONFLICT");
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/images: sync job .* is running/);
    await images.close();
  });
});

describe("retryFailed step", () => {
  const corrupt = async () => {
    const made = await make({ maxAttempts: 1 });
    addImage(made.media, "a", new Uint8Array([1, 2, 3]));
    return made;
  };

  it("answers NOT_FOUND for an unknown media id", async () => {
    const { steps } = await corrupt();
    const error = expectErr(await steps.retryFailed(fakeCtx({ payload: { id: "nope" } })), "NOT_FOUND");
    expect(error.status).toBe(404);
  });

  it("lifts the quarantine on one media item taken from the body", async () => {
    let fail = true;
    const flaky: Renderer = async (_data, _size, planned) => {
      if (fail) throw new Error("render failed");
      return { data: new Uint8Array([1]), width: planned.width, height: planned.height, format: planned.format, ext: planned.format === "webp" ? "webp" : planned.format, contentType: `image/${planned.format}` };
    };
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    const media = createFakeMedia();
    addImage(media, "a", await jpeg(400, 300));
    const images = await createImages({ ...baseConfig, maxAttempts: 1 }, { blobs, db, media, logger: noLogger, render: flaky });
    const steps: ImageSteps = module.steps!(images);
    expectOk(await images.plan(["a"]));
    expectOk(await images.generate("a"));
    fail = false;
    const ctx = expectOk(await steps.retryFailed(fakeCtx({ payload: { id: "a" } })));
    expect(boundaryCast<{ variants: number; media: number; job: Job | null }>(ctx.result, "host")).toEqual({ variants: 5, media: 1, job: null });
    expect(expectOk(await images.status()).failed.variants).toBe(0);
  });
});

describe("readStatus step", () => {
  it("answers TRANSIENT with retryable and 503 when persistence is unavailable", async () => {
    const { db, steps } = await make();
    db.failNext("TRANSIENT");
    const error = expectErr(await steps.readStatus(fakeCtx()), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe("generate step", () => {
  it("reads the media id from payload.id (the media.uploaded event envelope)", async () => {
    const { media, steps } = await make();
    addImage(media, "a", await jpeg(400, 300));
    const ctx = expectOk(await steps.generate(fakeCtx({ payload: { event: "media.uploaded", at: 1, identity: null, params: {}, id: "a" } })));
    const result = boundaryCast<{ id: string; variants: unknown[] }>(ctx.result, "host");
    expect(result.id).toBe("a");
    expect(result.variants).toHaveLength(5);
  });

  it("answers variant rows with exactly the fields its output declares", async () => {
    const { images, media, steps } = await make();
    addImage(media, "a", await jpeg(400, 300));
    const ctx = expectOk(await steps.generate(fakeCtx({ params: { id: "a" } })));
    const variants = boundaryCast<{ variants: Array<Record<string, unknown>> }>(ctx.result, "host").variants;
    const output = boundaryCast<{ oneOf: Array<{ properties: { variants?: { items: { properties: Record<string, unknown> } } } }> }>(module.describe!(images).generate.output, "host");
    const declared = Object.keys(output.oneOf[0]!.properties.variants!.items.properties).sort();
    for (const variant of variants) expect(Object.keys(variant).sort()).toEqual(declared);
  });

  it("answers VALIDATION without a media id", async () => {
    const { steps } = await make();
    expectErr(await steps.generate(fakeCtx()), "VALIDATION");
  });

  it("answers NOT_FOUND for an item the provider does not report as ready, and so does retryFailed", async () => {
    const { media, steps } = await make();
    addImage(media, "a", await jpeg(400, 300));
    media.remove("a");
    expect(expectErr(await steps.generate(fakeCtx({ params: { id: "a" } })), "NOT_FOUND").status).toBe(404);
    expect(expectErr(await steps.retryFailed(fakeCtx({ payload: { id: "a" } })), "NOT_FOUND").status).toBe(404);
  });

  it("answers NOT_FOUND for an unknown id", async () => {
    const { steps } = await make();
    const error = expectErr(await steps.generate(fakeCtx({ params: { id: "nope" } })), "NOT_FOUND");
    expect(error.status).toBe(404);
    expect(error.message).toContain("images: media/nope not found");
  });

  it("generates for each id in payload.ids (bulk media.uploaded envelope), skipping unknown ids", async () => {
    const { media, steps } = await make();
    addImage(media, "a", await jpeg(400, 300));
    addImage(media, "b", await jpeg(200, 200));
    const ctx = expectOk(await steps.generate(fakeCtx({ payload: { event: "media.uploaded", at: 1, identity: null, params: {}, id: null, ids: ["a", "b", "nope"] } })));
    const result = boundaryCast<{ items: Array<{ id: string; variants: unknown[] }> }>(ctx.result, "host");
    expect(result.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(result.items[0]?.variants).toHaveLength(5);
  });
});

describe("sync step's job", () => {
  it("counts the ready items that get variants, not every media item", async () => {
    const { images, media } = await make({ chunk: 1 });
    addImage(media, "a", await jpeg(200, 200));
    addImage(media, "b", await sharp({ create: { width: 200, height: 200, channels: 3, background: "#336699" } }).png().toBuffer(), "image/png");
    addImage(media, "c", new Uint8Array([1]), "image/gif");
    addImage(media, "d", new TextEncoder().encode("<svg/>"), "image/svg+xml");
    addImage(media, "e", new Uint8Array([1]), "application/pdf");
    addImage(media, "f", await jpeg(200, 200));
    media.remove("f");
    expect(expectOk(await images.sync()).total).toBe(2);
    await whenIdle(images);
    expect(expectOk(await images.status()).job).toMatchObject({ state: "done", total: 2, done: 2, failed: 0 });
    await images.close();
  });
});

describe("teardown", () => {
  it("wires images.close(): the job row is paused after teardown() runs mid-sync", async () => {
    const { images, db, media, steps } = await make({ chunk: 1 });
    addImage(media, "a", await jpeg(200, 200));

    expectOk(await steps.sync(fakeCtx()));
    await module.teardown!(images);

    const job = expectOk(await db.findOne<Job>(JOBS, {}));
    expect(job).toMatchObject({ state: "paused" });
  });
});

describe("serve step", () => {
  it("marks a fallback response with x-kestrel-variant: original", async () => {
    const { images, media, steps } = await make();
    addImage(media, "a", await jpeg(400, 300));
    expectOk(await images.plan(["a"]));
    const ctx = expectOk(await steps.serve(fakeCtx({ params: { id: "a", file: "thumb.webp" } })));
    const result = boundaryCast<{ binary: true; headers?: Record<string, string> }>(ctx.result, "host");
    expect(result.binary).toBe(true);
    expect(result.headers).toEqual({ "x-kestrel-variant": "original" });
  });

  it("answers VALIDATION without id or file", async () => {
    const { steps } = await make();
    expectErr(await steps.serve(fakeCtx({ params: { id: "a" } })), "VALIDATION");
  });

  it("answers NOT_FOUND for a name that is neither planned nor retired", async () => {
    const { media, steps } = await make();
    addImage(media, "a", await jpeg(400, 300));
    expectErr(await steps.serve(fakeCtx({ params: { id: "a", file: "nope.webp" } })), "NOT_FOUND");
  });

  it("serves the original, not 404, once a variant gives up", async () => {
    const { images, db, media, steps } = await make({ maxAttempts: 1 });
    addImage(media, "a", await jpeg(400, 300));
    expectOk(await images.plan(["a"]));
    expectOk(await db.updateMany(VARIANTS, { mediaId: "a" }, { state: "failed", error: "gave up" }));
    const ctx = expectOk(await steps.serve(fakeCtx({ params: { id: "a", file: "thumb.webp" } })));
    expect(boundaryCast<{ binary: true; headers?: Record<string, string> }>(ctx.result, "host").headers).toEqual({ "x-kestrel-variant": "original" });
  });
});

describe("attach step", () => {
  it("adds available, variants[] and variantCounts to a single media item; a planned row is never listed", async () => {
    const { images, media, steps } = await make();
    addImage(media, "a", await jpeg(400, 300));
    expectOk(await images.generate("a"));
    const ctx = expectOk(await steps.attach(fakeCtx({ result: { id: "a", filename: "a.jpg", contentType: "image/jpeg" } })));
    const result = boundaryCast<{ available: boolean; variants: Array<{ size: string; path: string; state: string }>; variantCounts: { done: number; pending: number; error: number; failed: number } }>(ctx.result, "host");
    expect(result.available).toBe(true);
    expect(result.variants).toHaveLength(5);
    expect(result.variants.every((v) => v.state !== "planned")).toBe(true);
    expect(result.variants.find((v) => v.size === "thumb")).toMatchObject({ path: "/media/a/variants/thumb.webp" });
    expect(result.variantCounts).toEqual({ done: 5, pending: 0, error: 0, failed: 0 });
  });

  it("an eligible item with no rows yet is unavailable, with no variants listed", async () => {
    const { media, steps } = await make();
    addImage(media, "a", await jpeg(400, 300));
    const ctx = expectOk(await steps.attach(fakeCtx({ result: { id: "a", filename: "a.jpg", contentType: "image/jpeg" } })));
    const result = boundaryCast<{ available: boolean; variants: unknown[]; variantCounts: { pending: number } }>(ctx.result, "host");
    expect(result.available).toBe(false);
    expect(result.variants).toHaveLength(0);
    expect(result.variantCounts.pending).toBe(5);
  });

  it("adds available, variants[] and variantCounts to every item in a list", async () => {
    const { images, media, steps } = await make();
    addImage(media, "a", await jpeg(400, 300));
    addImage(media, "b", await jpeg(400, 300));
    expectOk(await images.generate("a"));
    const ctx = expectOk(await steps.attach(fakeCtx({ result: { items: [{ id: "a", contentType: "image/jpeg" }, { id: "b", contentType: "image/jpeg" }], total: 2 } })));
    const result = boundaryCast<{ items: Array<{ id: string; available: boolean; variants: unknown[]; variantCounts: { done: number; pending: number; error: number; failed: number } }>; total: number }>(ctx.result, "host");
    expect(result.total).toBe(2);
    expect(result.items[0]?.available).toBe(true);
    expect(result.items[0]?.variants).toHaveLength(5);
    expect(result.items[1]?.available).toBe(false);
    expect(result.items[1]?.variants).toHaveLength(0);
  });

  it("a non-eligible item is always available, with no variants", async () => {
    const { media, steps } = await make();
    addImage(media, "a", new Uint8Array([1]), "application/pdf");
    const ctx = expectOk(await steps.attach(fakeCtx({ result: { id: "a", filename: "a.pdf", contentType: "application/pdf" } })));
    const result = boundaryCast<{ available: boolean; variants: unknown[]; variantCounts: { done: number; pending: number; error: number; failed: number } }>(ctx.result, "host");
    expect(result.available).toBe(true);
    expect(result.variants).toHaveLength(0);
    expect(result.variantCounts).toEqual({ done: 0, pending: 0, error: 0, failed: 0 });
  });

  it("throws when the pipeline put no media item in result", async () => {
    const { steps } = await make();
    await expect(steps.attach(fakeCtx({ result: { nothing: true } }))).rejects.toThrow(/no media item/);
  });
});

describe("removeMany step", () => {
  it("throws when the pipeline put no ids in result", async () => {
    const { steps } = await make();
    await expect(steps.removeMany(fakeCtx({ result: {} }))).rejects.toThrow(/no ids in result/);
  });
});

describe("syncPublic step", () => {
  it("merges _publicVariants into the result", async () => {
    const { steps } = await make({ publicCopy: { prefix: "site/" } });
    const ctx = expectOk(await steps.syncPublic(fakeCtx()));
    expect(boundaryCast<{ _publicVariants: { written: number } }>(ctx.result, "host")._publicVariants).toEqual({ written: 0, removed: 0, planned: 0, missing: 0 });
  });
});

describe("export step", () => {
  it("merges variant counts into the media export result instead of replacing it", async () => {
    const { media, steps } = await make();
    addImage(media, "a", await jpeg(400, 300));
    const dir = await mkdtemp(join(tmpdir(), "images-module-export-"));
    try {
      const ctx = expectOk(await steps.export(dir)(fakeCtx({ result: { written: 1, skipped: 0, missing: 0, conflicts: 0 } })));
      expect(ctx.result).toEqual({ written: 1, skipped: 0, missing: 0, conflicts: 0, variants: { written: 0, skipped: 0 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("images/default boot rules via the module's attach hook", () => {
  it("the module's attach hook delegates its boot checks to images.attach", async () => {
    const { images } = await make({ publicCopy: { prefix: "site/" } });
    expect(() => module.attach!(images, introspectionOf(manifestWithPipelines([])))).toThrow(/no pipeline runs images\.serve/);
    expect(() => module.attach!(images, introspectionOf(manifestWithPipelines([{ pipeline: "serveImageVariant", module: "images/default", step: "images.serve" }])))).not.toThrow();
  });
});

describe("images.register input schema", () => {
  it("accepts a code-declared size without source and updatedAt", async () => {
    const { images } = await make();
    const description = module.describe!(images).register;
    const input = description.input ?? {};
    expect(validateSchema(input, { sizes: [{ name: "card", width: 640 }] })).toEqual([]);
    expect(validateSchema(input, { sizes: [{ name: "card" }] })).not.toEqual([]);
  });
});

describe("images/default serve step's anonymous flag follows publicCopy", () => {
  it("carries anonymous: required only when publicCopy is set", async () => {
    const { images: withoutCopy } = await make();
    expect(module.describe!(withoutCopy).serve.anonymous).toBeUndefined();
    const { images: withCopy } = await make({ publicCopy: { prefix: "site/" } });
    expect(module.describe!(withCopy).serve.anonymous).toBe("required");
  });
});

async function makeInstance(config: Partial<Config> = {}) {
  const blobs = fakeBlobstore();
  const db = createFakePersistence();
  const media = createFakeMedia();
  const parsed = configSchema.parse({ ...baseConfig, ...config });
  const images = boundaryCast<Images>(
    await module.setup(parsed, {
      get<T>(contract: { name: string }): T {
        if (contract === BLOBSTORE) return boundaryCast<T>(blobs, "host");
        if (contract === PERSISTENCE) return boundaryCast<T>(db, "host");
        if (contract === MEDIA) return boundaryCast<T>(media, "host");
        throw new Error(`unexpected contract ${contract.name}`);
      },
      find: () => undefined,
      logger: silentLogger,
      root: process.cwd(),
      eventTriggers: [],
    }),
    "host",
  );
  return { images, blobs, db, media };
}

function pipeline(...steps: string[]) {
  return definePipeline({ name: "test", steps });
}

const seedSteps = {
  "seed.single": async (ctx: Context) => ok({ ...ctx, result: { id: "a", filename: "a.jpg", contentType: "image/jpeg" } }),
  "seed.ids": async (ctx: Context) => ok({ ...ctx, result: { ids: ["a", "b"] } }),
};

describe("images/default steps via runPipeline", () => {
  it("register: rejects an unknown size field, additionalProperties: false on nested items", async () => {
    const { images } = await makeInstance();
    const res = await runPipeline(pipeline("images.register"), { body: { sizes: [{ name: "card", width: 640, nope: true }] } }, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
    expect(res.details?.problems).toEqual([{ path: "$.sizes[0].nope", message: "is not allowed by additionalProperties: false" }]);

    const ok1 = await runPipeline(pipeline("images.register"), { body: { sizes: [{ name: "card", width: 640 }] } }, { modules: [{ module, instance: images }] });
    expect(ok1.status).toBe(200);
  });

  it("listSizes: lists the effective sizes", async () => {
    const { images } = await makeInstance();
    const res = await runPipeline(pipeline("images.listSizes"), {}, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.result)).toBe(true);
  });

  it("plan: places every effective size", async () => {
    const { images, media } = await makeInstance({ publicCopy: { prefix: "site/" } });
    addImage(media, "a", await jpeg(400, 300));
    const res = await runPipeline(pipeline("images.plan"), { body: { id: "a" } }, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
    const rows = expectOk(await images.variantsOf(["a"])).get("a") ?? [];
    expect(rows.every((r) => r.state === "pending")).toBe(true);
  });

  it("generate: accepts a plain body and the fuller media.uploaded event envelope (additionalProperties: true)", async () => {
    const { images, media } = await makeInstance();
    addImage(media, "a", await jpeg(400, 300));
    const plain = await runPipeline(pipeline("images.generate"), { body: { id: "a" } }, { modules: [{ module, instance: images }] });
    expect(plain.status).toBe(200);
    expect(boundaryCast<{ id: string }>(plain.result, "host").id).toBe("a");

    const envelope = await runPipeline(pipeline("images.generate"), { body: { event: "media.uploaded", at: 1, identity: null, params: {}, id: "a" } }, { modules: [{ module, instance: images }] });
    expect(envelope.status).toBe(200);
  });

  it("sync: starts a job", async () => {
    const { images, media } = await makeInstance();
    addImage(media, "a", await jpeg(200, 200));
    const res = await runPipeline(pipeline("images.sync"), {}, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
    expect(boundaryCast<{ state: string }>(res.result, "host").state).toMatch(/running|done/);
    await module.teardown!(images);
  });

  it("resume: no-ops without a paused job or unfinished item", async () => {
    const { images } = await makeInstance();
    const res = await runPipeline(pipeline("images.resume"), {}, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
    expect(res.result).toBeNull();
  });

  it("prune: rejects a still-declared size", async () => {
    const { images } = await makeInstance();
    const res = await runPipeline(pipeline("images.prune"), { body: { sizes: ["thumb"] } }, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
  });

  it("prune: retires an orphaned size's variants and reports the counts", async () => {
    const { images, media } = await makeInstance();
    expectOk(await images.register([{ name: "card", width: 480 }]));
    addImage(media, "a", await jpeg(600, 400));
    expectOk(await images.generate("a"));
    expectOk(await images.register([{ name: "other", width: 100 }]));
    const res = await runPipeline(pipeline("images.prune"), { body: { sizes: ["card"] } }, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ sizes: 1, variants: 1 });
  });

  it("retryFailed: reports variant, media and job counts through the runner", async () => {
    const { images } = await makeInstance();
    const res = await runPipeline(pipeline("images.retryFailed"), {}, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
    expect(res.result).toMatchObject({ variants: 0, media: 0, job: null });
  });

  it("readStatus: reports sizes, job and orphans", async () => {
    const { images } = await makeInstance();
    const res = await runPipeline(pipeline("images.readStatus"), {}, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
    expect(res.result).toMatchObject({ job: null });
  });

  it("remove: deletes a medium's variants", async () => {
    const { images, db, blobs, media } = await makeInstance();
    addImage(media, "a", await jpeg(200, 200));
    expectOk(await images.generate("a"));
    const before = expectOk(await db.findMany<Variant>(VARIANTS, { mediaId: "a" }));
    expect(before.items.length).toBeGreaterThan(0);
    const keys = before.items.map((v) => v.key);
    const res = await runPipeline(pipeline("images.remove"), { params: { id: "a" } }, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
    const after = expectOk(await db.findMany<Variant>(VARIANTS, { mediaId: "a" }));
    expect(after.items).toHaveLength(0);
    for (const key of keys) expect(blobs.blobs.has(key)).toBe(false);
  });

  it("removeMany: deletes variants for every id in result.ids", async () => {
    const { images, db, blobs, media } = await makeInstance();
    addImage(media, "a", await jpeg(200, 200));
    addImage(media, "b", await jpeg(200, 200));
    expectOk(await images.generate("a"));
    expectOk(await images.generate("b"));
    const before = expectOk(await db.findMany<Variant>(VARIANTS, { mediaId: { in: ["a", "b"] } }));
    expect(before.items.length).toBeGreaterThan(0);
    const keys = before.items.map((v) => v.key);
    const res = await runPipeline(pipeline("seed.ids", "images.removeMany"), {}, { modules: [{ module, instance: images }], steps: seedSteps });
    expect(res.status).toBe(200);
    const after = expectOk(await db.findMany<Variant>(VARIANTS, { mediaId: { in: ["a", "b"] } }));
    expect(after.items).toHaveLength(0);
    for (const key of keys) expect(blobs.blobs.has(key)).toBe(false);
  });

  it("attach: adds available, variants[] and variantCounts to result", async () => {
    const { images, media } = await makeInstance();
    addImage(media, "a", await jpeg(400, 300));
    expectOk(await images.generate("a"));
    const res = await runPipeline(pipeline("seed.single", "images.attach"), {}, { modules: [{ module, instance: images }], steps: seedSteps });
    expect(res.status).toBe(200);
    const result = boundaryCast<{ available: boolean; variants: unknown[]; variantCounts: { done: number; pending: number; error: number; failed: number } }>(res.result, "host");
    expect(result.available).toBe(true);
    expect(result.variants).toHaveLength(5);
    expect(result.variantCounts).toEqual({ done: 5, pending: 0, error: 0, failed: 0 });
  });

  it("serve: serves a done variant", async () => {
    const { images, media } = await makeInstance();
    addImage(media, "a", await jpeg(400, 300));
    expectOk(await images.generate("a"));
    const res = await runPipeline(pipeline("images.serve"), { params: { id: "a", file: "thumb.webp" } }, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
    expect(res.result).toMatchObject({ binary: true });
  });

  it("serve: does not return another media item's variant for the same size name", async () => {
    const { images, media } = await makeInstance();
    addImage(media, "a", await jpeg(400, 300));
    addImage(media, "b", await jpeg(400, 300));
    expectOk(await images.plan(["a"]));
    expectOk(await images.generate("b"));

    const own = await runPipeline(pipeline("images.serve"), { params: { id: "a", file: "thumb.webp" } }, { modules: [{ module, instance: images }] });
    expect(own.result).toMatchObject({ binary: true, headers: { "x-kestrel-variant": "original" } });

    const other = await runPipeline(pipeline("images.serve"), { params: { id: "b", file: "thumb.webp" } }, { modules: [{ module, instance: images }] });
    expect(other.result).toMatchObject({ binary: true });
    expect(other.result).not.toHaveProperty("headers");
    provesObjectBinding("images/default", "serve");
  });

  it("syncPublic: merges _publicVariants without publicCopy configured", async () => {
    const { images } = await makeInstance();
    const res = await runPipeline(pipeline("images.syncPublic"), {}, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
    expect(res.result).toMatchObject({ _publicVariants: { written: 0, removed: 0, planned: 0, missing: 0 } });
  });

  it("export: copies every done variant to the target directory", async () => {
    const { images, media } = await makeInstance();
    addImage(media, "a", await jpeg(400, 300));
    expectOk(await images.generate("a"));
    const dir = await mkdtemp(join(tmpdir(), "images-runpipeline-export-"));
    try {
      const res = await runPipeline(pipeline(`images.export:${dir}`), {}, { modules: [{ module, instance: images }] });
      expect(res.status).toBe(200);
      expect(boundaryCast<{ variants: { written: number } }>(res.result, "host").variants.written).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
