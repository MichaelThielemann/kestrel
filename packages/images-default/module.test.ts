import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext, type Context, type Step, type StepFactory } from "@michaelthielemann/kestrel/context";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger, type Logger } from "@michaelthielemann/kestrel/logger";
import { validateSchema } from "@michaelthielemann/kestrel/schema";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import module, { configSchema } from "./module.ts";
import { DEFAULT_MAX_ATTEMPTS, JOBS, createImages, type Config, type Images, type Job } from "./impl.ts";

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
  generate: Step;
  sync: Step;
  resume: Step;
  prune: Step;
  readStatus: Step;
  remove: Step;
  removeMany: Step;
  attach: Step;
  serve: Step;
  export: StepFactory;
}

function fakeCtx(overrides: Partial<Context> = {}): Context {
  return { ...createContext({ trigger: { kind: "http", name: "t" } }), ...overrides };
}

const noLogger: Logger = { step() {}, info() {}, error() {} };
const MEDIA = "media_items";
const baseConfig: Config = { prefix: "media-variants/", publicPath: "/media", media: { collection: MEDIA }, chunk: 20, staleAfterMs: 60000, maxAttempts: DEFAULT_MAX_ATTEMPTS };

async function jpeg(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } }).jpeg().toBuffer();
}

async function make(config: Partial<Config> = {}) {
  const blobs = fakeBlobstore();
  const db = createFakePersistence();
  await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string" });
  const images = await createImages({ ...baseConfig, ...config }, { blobs, db, logger: noLogger });
  const steps: ImageSteps = module.steps!(images);
  return { images, blobs, db, steps };
}

async function addImage(db: ReturnType<typeof createFakePersistence>, blobs: ReturnType<typeof fakeBlobstore>, id: string, data: Uint8Array): Promise<void> {
  const key = `orig/${id}.jpg`;
  await db.createOne(MEDIA, { id, key, contentType: "image/jpeg", folder: "", filename: `${id}.jpg` });
  await blobs.put(key, data, { contentType: "image/jpeg" });
}

describe("images/default configSchema", () => {
  it("applies defaults", () => {
    const parsed = configSchema.parse({});
    expect(parsed).toMatchObject({ prefix: "media-variants/", publicPath: "/media", media: { collection: "media_items" }, chunk: 20, staleAfterMs: 60000, maxAttempts: 5 });
  });

  it("rejects unknown keys", () => {
    expect(configSchema.safeParse({ nope: true }).success).toBe(false);
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

describe("sync step", () => {
  it("answers CONFLICT for a fresh running job", async () => {
    const { images, db, blobs, steps } = await make({ chunk: 1 });
    await addImage(db, blobs, "a", await jpeg(200, 200));
    expectOk(await images.sync());
    const error = expectErr(await steps.sync(fakeCtx()), "CONFLICT");
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/images: sync job .* is running/);
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
    const { db, blobs, steps } = await make();
    await addImage(db, blobs, "a", await jpeg(400, 300));
    const ctx = expectOk(await steps.generate(fakeCtx({ payload: { event: "media.uploaded", at: 1, identity: null, params: {}, id: "a" } })));
    expect((ctx.result as { id: string; variants: unknown[] }).id).toBe("a");
    expect((ctx.result as { id: string; variants: unknown[] }).variants).toHaveLength(5);
  });

  it("reads the media id from payload.id", async () => {
    const { db, blobs, steps } = await make();
    await addImage(db, blobs, "a", await jpeg(400, 300));
    const ctx = expectOk(await steps.generate(fakeCtx({ payload: { id: "a" } })));
    expect((ctx.result as { id: string }).id).toBe("a");
  });

  it("answers VALIDATION without a media id", async () => {
    const { steps } = await make();
    expectErr(await steps.generate(fakeCtx()), "VALIDATION");
  });

  it("answers NOT_FOUND for an unknown id", async () => {
    const { steps } = await make();
    const error = expectErr(await steps.generate(fakeCtx({ params: { id: "nope" } })), "NOT_FOUND");
    expect(error.status).toBe(404);
    expect(error.message).toContain("images: media/nope not found");
  });

  it("generates for each id in payload.ids (bulk media.uploaded envelope), skipping unknown ids", async () => {
    const { db, blobs, steps } = await make();
    await addImage(db, blobs, "a", await jpeg(400, 300));
    await addImage(db, blobs, "b", await jpeg(200, 200));
    const ctx = expectOk(await steps.generate(fakeCtx({ payload: { event: "media.uploaded", at: 1, identity: null, params: {}, id: null, ids: ["a", "b", "nope"] } })));
    const result = ctx.result as { items: Array<{ id: string; variants: unknown[] }> };
    expect(result.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(result.items[0]?.variants).toHaveLength(5);
  });
});

describe("teardown", () => {
  it("wires images.close(): the job row is paused after teardown() runs mid-sync", async () => {
    const { images, db, blobs, steps } = await make({ chunk: 1 });
    await addImage(db, blobs, "a", await jpeg(200, 200));

    expectOk(await steps.sync(fakeCtx()));
    // the sync loop is scheduled via setImmediate and has not run its first chunk yet, so
    // teardown() below stops it before any variant is rendered.
    await module.teardown!(images);

    const job = expectOk(await db.findOne<Job>(JOBS, {}));
    expect(job).toMatchObject({ state: "paused" });
  });
});

describe("serve step", () => {
  it("sets x-kestrel-variant: pending when the variant isn't done yet", async () => {
    const { db, blobs, steps } = await make();
    await addImage(db, blobs, "a", await jpeg(400, 300));
    // no images.generate() call: the "thumb" variant row does not exist yet, so read() falls back
    const ctx = expectOk(await steps.serve(fakeCtx({ params: { id: "a", file: "thumb.webp" } })));
    const result = ctx.result as { binary: true; headers?: Record<string, string> };
    expect(result.binary).toBe(true);
    expect(result.headers).toEqual({ "x-kestrel-variant": "pending" });
  });

  it("answers VALIDATION without id or file", async () => {
    const { steps } = await make();
    expectErr(await steps.serve(fakeCtx({ params: { id: "a" } })), "VALIDATION");
  });

  it("answers NOT_FOUND for an unknown size", async () => {
    const { db, blobs, steps } = await make();
    await addImage(db, blobs, "a", await jpeg(400, 300));
    expectErr(await steps.serve(fakeCtx({ params: { id: "a", file: "nope.webp" } })), "NOT_FOUND");
  });

  it("answers NOT_FOUND with the reason once the variant gave up instead of serving the original", async () => {
    const { images, db, blobs, steps } = await make({ maxAttempts: 1 });
    await addImage(db, blobs, "a", await jpeg(400, 300));
    blobs.blobs.delete("orig/a.jpg");
    expectOk(await images.generate("a"));
    const error = expectErr(await steps.serve(fakeCtx({ params: { id: "a", file: "thumb.webp" } })), "NOT_FOUND");
    expect(error.message).toBe("images: variant thumb for media/a failed after 1 attempts: original blob missing");
  });
});

describe("attach step", () => {
  it("adds variants[] to a single media item", async () => {
    const { images, db, blobs, steps } = await make();
    await addImage(db, blobs, "a", await jpeg(400, 300));
    expectOk(await images.generate("a"));
    const ctx = expectOk(await steps.attach(fakeCtx({ result: { id: "a", filename: "a.jpg" } })));
    const result = ctx.result as { variants: Array<{ size: string; path: string }> };
    expect(result.variants).toHaveLength(5);
    expect(result.variants.find((v) => v.size === "thumb")).toMatchObject({ path: "/media/a/variants/thumb.webp" });
  });

  it("adds variants[] to every item in a list", async () => {
    const { images, db, blobs, steps } = await make();
    await addImage(db, blobs, "a", await jpeg(400, 300));
    await addImage(db, blobs, "b", await jpeg(400, 300));
    expectOk(await images.generate("a"));
    expectOk(await images.generate("b"));
    const ctx = expectOk(await steps.attach(fakeCtx({ result: { items: [{ id: "a" }, { id: "b" }], total: 2 } })));
    const result = ctx.result as { items: Array<{ id: string; variants: unknown[] }>; total: number };
    expect(result.total).toBe(2);
    expect(result.items[0]?.variants).toHaveLength(5);
    expect(result.items[1]?.variants).toHaveLength(5);
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

describe("export step", () => {
  it("merges variant counts into the media export result instead of replacing it", async () => {
    const { db, blobs, steps } = await make();
    await addImage(db, blobs, "a", await jpeg(400, 300));
    const dir = await mkdtemp(join(tmpdir(), "images-module-export-"));
    try {
      const ctx = expectOk(await steps.export(dir)(fakeCtx({ result: { written: 1, skipped: 0, missing: 0, conflicts: 0 } })));
      expect(ctx.result).toEqual({ written: 1, skipped: 0, missing: 0, conflicts: 0, variants: { written: 0, skipped: 0 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

async function makeInstance(config: Partial<Config> = {}) {
  const blobs = fakeBlobstore();
  const db = createFakePersistence();
  await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string" });
  const parsed = configSchema.parse({ ...baseConfig, ...config });
  const images = (await module.setup(parsed, {
    get<T>(contract: { name: string }): T {
      if (contract === BLOBSTORE) return blobs as T;
      if (contract === PERSISTENCE) return db as T;
      throw new Error(`unexpected contract ${contract.name}`);
    },
    find: () => undefined,
    logger: silentLogger,
    root: process.cwd(),
  })) as Images;
  return { images, blobs, db };
}

function pipeline(...steps: string[]) {
  return definePipeline({ name: "test", steps });
}

const seedSteps = {
  "seed.single": async (ctx: Context) => ok({ ...ctx, result: { id: "a", filename: "a.jpg" } }),
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

  it("generate: accepts a plain body and the fuller media.uploaded event envelope (additionalProperties: true)", async () => {
    const { images, db, blobs } = await makeInstance();
    await addImage(db, blobs, "a", await jpeg(400, 300));
    const plain = await runPipeline(pipeline("images.generate"), { body: { id: "a" } }, { modules: [{ module, instance: images }] });
    expect(plain.status).toBe(200);
    expect((plain.result as { id: string }).id).toBe("a");

    const envelope = await runPipeline(pipeline("images.generate"), { body: { event: "media.uploaded", at: 1, identity: null, params: {}, id: "a" } }, { modules: [{ module, instance: images }] });
    expect(envelope.status).toBe(200);
  });

  it("sync: starts a job", async () => {
    const { images, db, blobs } = await makeInstance();
    await addImage(db, blobs, "a", await jpeg(200, 200));
    const res = await runPipeline(pipeline("images.sync"), {}, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
    expect((res.result as { state: string }).state).toMatch(/running|done/);
    await module.teardown!(images);
  });

  it("resume: no-ops without a paused job", async () => {
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

  it("readStatus: reports sizes, job and orphans", async () => {
    const { images } = await makeInstance();
    const res = await runPipeline(pipeline("images.readStatus"), {}, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
    expect(res.result).toMatchObject({ job: null });
  });

  it("remove: deletes a medium's variants", async () => {
    const { images, db, blobs } = await makeInstance();
    await addImage(db, blobs, "a", await jpeg(200, 200));
    expectOk(await images.generate("a"));
    const res = await runPipeline(pipeline("images.remove"), { params: { id: "a" } }, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
  });

  it("removeMany: deletes variants for every id in result.ids", async () => {
    const { images, db, blobs } = await makeInstance();
    await addImage(db, blobs, "a", await jpeg(200, 200));
    await addImage(db, blobs, "b", await jpeg(200, 200));
    expectOk(await images.generate("a"));
    expectOk(await images.generate("b"));
    const res = await runPipeline(pipeline("seed.ids", "images.removeMany"), {}, { modules: [{ module, instance: images }], steps: seedSteps });
    expect(res.status).toBe(200);
  });

  it("attach: adds variants[] to result", async () => {
    const { images, db, blobs } = await makeInstance();
    await addImage(db, blobs, "a", await jpeg(400, 300));
    expectOk(await images.generate("a"));
    const res = await runPipeline(pipeline("seed.single", "images.attach"), {}, { modules: [{ module, instance: images }], steps: seedSteps });
    expect(res.status).toBe(200);
    expect((res.result as { variants: unknown[] }).variants).toHaveLength(5);
  });

  it("serve: serves a done variant", async () => {
    const { images, db, blobs } = await makeInstance();
    await addImage(db, blobs, "a", await jpeg(400, 300));
    expectOk(await images.generate("a"));
    const res = await runPipeline(pipeline("images.serve"), { params: { id: "a", file: "thumb.webp" } }, { modules: [{ module, instance: images }] });
    expect(res.status).toBe(200);
    expect(res.result).toMatchObject({ binary: true });
  });

  it("export: copies every done variant to the target directory", async () => {
    const { images, db, blobs } = await makeInstance();
    await addImage(db, blobs, "a", await jpeg(400, 300));
    expectOk(await images.generate("a"));
    const dir = await mkdtemp(join(tmpdir(), "images-runpipeline-export-"));
    try {
      const res = await runPipeline(pipeline(`images.export:${dir}`), {}, { modules: [{ module, instance: images }] });
      expect(res.status).toBe(200);
      expect((res.result as { variants: { written: number } }).variants.written).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
