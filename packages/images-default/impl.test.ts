import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Blobstore, PutOptions } from "@michaelthielemann/kestrel-contracts/blobstore";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok } from "@michaelthielemann/kestrel/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { DEFAULT_MAX_ATTEMPTS, JOBS, SIZES, VARIANTS, createImages, whenIdle } from "./impl.ts";
import type { Config, Job, Variant } from "./impl.ts";

function fakeBlobstore(): Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> } {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    blobs,
    async put(key, data, options) {
      blobs.set(key, { data, contentType: options?.contentType ?? "application/octet-stream" });
      return ok();
    },
    async get(key) {
      return ok(blobs.get(key)?.data ?? null);
    },
    async remove(key) {
      blobs.delete(key);
      return ok();
    },
    async move(from, to) {
      const b = blobs.get(from);
      if (!b) return err(failure("NOT_FOUND", `${from} not found`));
      blobs.set(to, b);
      blobs.delete(from);
      return ok();
    },
    async list(prefix) {
      return ok([...blobs].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.data.byteLength })));
    },
  };
}

const noLogger: Logger = { step() {}, info() {}, error() {} };

const MEDIA = "media_items";

async function jpeg(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } }).jpeg().toBuffer();
}

const baseConfig: Config = { prefix: "media-variants/", publicPath: "/media", media: { collection: MEDIA }, chunk: 20, staleAfterMs: 60000, maxAttempts: DEFAULT_MAX_ATTEMPTS };

async function make(config: Partial<Config> = {}, now: () => number = () => 1000) {
  const blobs = fakeBlobstore();
  const db = createFakePersistence();
  await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string" });
  const images = await createImages({ ...baseConfig, ...config }, { blobs, db, logger: noLogger }, now);
  return { images, blobs, db };
}

async function addImage(db: ReturnType<typeof createFakePersistence>, blobs: ReturnType<typeof fakeBlobstore>, id: string, data: Uint8Array, contentType = "image/jpeg"): Promise<void> {
  const key = `orig/${id}.jpg`;
  await db.createOne(MEDIA, { id, key, contentType, folder: "", filename: `${id}.jpg` });
  await blobs.put(key, data, { contentType });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("images/default boot", () => {
  it("seeds the default sizes", async () => {
    const { images } = await make();
    const sizes = await images.sizes();
    expect(sizes.map((s) => s.name).sort()).toEqual(["large", "medium", "small", "thumb", "xl"]);
    expect(sizes.every((s) => s.source === "default")).toBe(true);
  });

  it("seeds config sizes instead of defaults when configured", async () => {
    const { images } = await make({ sizes: [{ name: "hero", width: 1000, fit: "inside", format: "webp", quality: 82 }] });
    const sizes = await images.sizes();
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toMatchObject({ name: "hero", source: "config" });
  });
});

describe("register", () => {
  it("rejects an empty list", async () => {
    const { images } = await make();
    expect(expectErr(await images.register([]), "VALIDATION").message).toContain("must not be empty");
    expect(expectErr(await images.register("nope"), "VALIDATION").message).toContain("must not be empty");
  });

  it("rejects a name colliding with a config size", async () => {
    const { images } = await make({ sizes: [{ name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 }] });
    expect(expectErr(await images.register([{ name: "thumb", width: 999 }]), "CONFLICT").message).toContain("defined in config");
  });

  it("registers new sizes and reports them as used and registered", async () => {
    const { images } = await make();
    const rows = expectOk(await images.register([{ name: "card", width: 480 }]));
    const card = rows.find((r) => r.name === "card");
    expect(card).toMatchObject({ width: 480, source: "registered" });
    const status = expectOk(await images.status());
    expect(status.sizes.find((s) => s.name === "card")?.used).toBe(true);
  });

  it("drops a size that is not resent and reports its leftover variants as orphaned", async () => {
    const { images, db, blobs } = await make();
    expectOk(await images.register([{ name: "card", width: 480 }]));
    await addImage(db, blobs, "a", await jpeg(600, 400));
    expectOk(await images.generate("a"));
    expectOk(await images.register([{ name: "banner", width: 900 }]));

    const status = expectOk(await images.status());
    expect(status.sizes.find((s) => s.name === "card")).toBeUndefined();
    expect(status.orphaned.sizes).toEqual(["card"]);
    expect(status.orphaned.variants).toBe(1);
  });

  it("never writes a size row and drops rows written by earlier versions", async () => {
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string" });
    const images = await createImages(baseConfig, { blobs, db, logger: noLogger }, () => 1000);
    expectOk(await images.register([{ name: "card", width: 480 }]));
    expect(expectOk(await db.count(SIZES, {}))).toBe(0);

    await db.createOne(SIZES, { name: "card", width: 480, height: null, fit: "inside", format: "webp", quality: 82, source: "registered", updatedAt: 1 });
    const infos: string[] = [];
    const logger: Logger = { step() {}, info(message) { infos.push(message); }, error() {} };
    const restarted = await createImages(baseConfig, { blobs, db, logger }, () => 2000);
    expect(expectOk(await db.count(SIZES, {}))).toBe(0);
    expect(infos.some((message) => message.includes("dropped 1 persisted size rows"))).toBe(true);
    expect((await restarted.sizes()).some((size) => size.name === "card")).toBe(false);
  });
});

describe("exists", () => {
  it("reports whether a media id is known", async () => {
    const { images, db, blobs } = await make();
    await addImage(db, blobs, "a", await jpeg(200, 200));
    expect(expectOk(await images.exists("a"))).toBe(true);
    expect(expectOk(await images.exists("nope"))).toBe(false);
  });
});

describe("generate", () => {
  it("creates one done variant per effective size with correct dims and blob key", async () => {
    const { images, db, blobs } = await make();
    await addImage(db, blobs, "a", await jpeg(1200, 800));
    const variants = expectOk(await images.generate("a"));
    expect(variants).toHaveLength(5);
    const medium = variants.find((v) => v.size === "medium")!;
    expect(medium).toMatchObject({ state: "done", width: 1024, height: 683, format: "webp", key: "media-variants/a/medium.webp", attempts: 1 });
    expect(blobs.blobs.has(medium.key)).toBe(true);
  });

  it("is idempotent: a second call does not touch the blobstore", async () => {
    const { images, db, blobs } = await make();
    await addImage(db, blobs, "a", await jpeg(1200, 800));
    expectOk(await images.generate("a"));
    let puts = 0;
    const originalPut = blobs.put.bind(blobs);
    blobs.put = async (key: string, data: Uint8Array, options?: PutOptions) => {
      puts += 1;
      return originalPut(key, data, options);
    };
    const second = expectOk(await images.generate("a"));
    expect(puts).toBe(0);
    expect(second.every((v) => v.attempts === 1)).toBe(true);
  });

  it("regenerates only the size whose definition changed", async () => {
    const { images, db, blobs } = await make();
    await addImage(db, blobs, "a", await jpeg(1200, 800));
    expectOk(await images.generate("a"));
    expectOk(await images.register([{ name: "thumb", width: 111 }]));

    const putKeys: string[] = [];
    const originalPut = blobs.put.bind(blobs);
    blobs.put = async (key: string, data: Uint8Array, options?: PutOptions) => {
      putKeys.push(key);
      return originalPut(key, data, options);
    };
    const variants = expectOk(await images.generate("a"));
    expect(putKeys).toEqual(["media-variants/a/thumb.webp"]);
    expect(variants.find((v) => v.size === "thumb")).toMatchObject({ width: 111, attempts: 2 });
    expect(variants.find((v) => v.size === "medium")).toMatchObject({ attempts: 1 });
  });

  it("marks every size error with attempts 1 on a corrupt original", async () => {
    const { images, db, blobs } = await make();
    await addImage(db, blobs, "a", new Uint8Array([1, 2, 3, 4, 5]));
    const variants = expectOk(await images.generate("a"));
    expect(variants).toHaveLength(5);
    expect(variants.every((v) => v.state === "error" && v.attempts === 1)).toBe(true);
  });

  it("creates no rows for a non-eligible original", async () => {
    const { images, db } = await make();
    await db.createOne(MEDIA, { id: "a", key: "orig/a.svg", contentType: "image/svg+xml", folder: "", filename: "a.svg" });
    const variants = expectOk(await images.generate("a"));
    expect(variants).toEqual([]);
    expect(expectOk(await db.count(VARIANTS, {}))).toBe(0);
  });

  it("marks every size error when the original blob is missing", async () => {
    const { images, db } = await make();
    await db.createOne(MEDIA, { id: "a", key: "orig/missing.jpg", contentType: "image/jpeg", folder: "", filename: "a.jpg" });
    const variants = expectOk(await images.generate("a"));
    expect(variants).toHaveLength(5);
    expect(variants.every((v) => v.state === "error" && v.error === "original blob missing")).toBe(true);
  });
});

describe("sync", () => {
  it("processes media in chunks and finishes done with cursor at the last id", async () => {
    const { images, db, blobs } = await make({ chunk: 2 });
    for (const id of ["a", "b", "c"]) await addImage(db, blobs, id, await jpeg(400, 300));
    expectOk(await images.sync());
    await whenIdle(images);
    const status = expectOk(await images.status());
    expect(status.job).toMatchObject({ state: "done", cursor: "c", done: 3, failed: 0 });
    expect(expectOk(await db.count(VARIANTS, { state: "done" }))).toBe(15);
  });

  it("close() mid-run pauses the job; a fresh instance's sync() resumes it without re-rendering finished variants", async () => {
    const { images, db, blobs } = await make({ chunk: 1 });
    for (const id of ["a", "b", "c"]) await addImage(db, blobs, id, await jpeg(300, 200));

    let gateOpen = false;
    let firstVariantPutSeen = false;
    const gate = deferred();
    const originalPut = blobs.put.bind(blobs);
    blobs.put = async (key: string, data: Uint8Array, options?: PutOptions) => {
      if (!gateOpen && key.startsWith("media-variants/")) {
        firstVariantPutSeen = true;
        await gate.promise;
      }
      return originalPut(key, data, options);
    };

    expectOk(await images.sync());
    await waitFor(() => firstVariantPutSeen);

    const closing = images.close();
    gateOpen = true;
    gate.resolve();
    await closing;

    const paused = expectOk(await images.status());
    expect(paused.job).toMatchObject({ state: "paused", cursor: "a", done: 1 });

    // close() is terminal for this instance (sync()/resume() answer CONFLICT) — a resume happens through
    // a fresh instance over the same persistence and blobstore, as on a process restart.
    let putsAfterResume = 0;
    blobs.put = async (key: string, data: Uint8Array, options?: PutOptions) => {
      putsAfterResume += 1;
      return originalPut(key, data, options);
    };
    const resumed = await createImages({ ...baseConfig, chunk: 1 }, { blobs, db, logger: noLogger });
    await resumed.sync();
    await whenIdle(resumed);

    const done = expectOk(await resumed.status());
    expect(done.job).toMatchObject({ state: "done", cursor: "c", done: 3 });
    expect(putsAfterResume).toBe(10); // 5 sizes each for "b" and "c" only, "a" was already done
  });

  it("answers CONFLICT for a fresh running job and resumes a stale one", async () => {
    let clock = 1000;
    const { images, db, blobs } = await make({ chunk: 1, staleAfterMs: 500 }, () => clock);
    await addImage(db, blobs, "a", await jpeg(200, 200));

    const gate = deferred();
    const originalPut = blobs.put.bind(blobs);
    blobs.put = async (key: string, data: Uint8Array, options?: PutOptions) => {
      if (key.startsWith("media-variants/")) await gate.promise;
      return originalPut(key, data, options);
    };

    const job = expectOk(await images.sync());
    expectErr(await images.sync(), "CONFLICT");

    clock = 1000 + 501;
    const resumed = expectOk(await images.sync());
    expect(resumed.id).toBe(job.id);
    expect(resumed.state).toBe("running");

    blobs.put = originalPut;
    gate.resolve();
    await whenIdle(images);
    const status = expectOk(await images.status());
    expect(status.job?.state).toBe("done");
  });

  it("resume() is a no-op without a resumable job and resumes a paused one for cron", async () => {
    const { images, db, blobs } = await make({ chunk: 1 });
    expect(expectOk(await images.resume())).toBeNull();

    await addImage(db, blobs, "a", await jpeg(200, 200));
    expectOk(await images.sync());
    await whenIdle(images);
    expect(expectOk(await images.resume())).toBeNull(); // job is "done"
  });
});

describe("sync job failures", () => {
  it("records a persistence failure inside the loop on the job row and logs it", async () => {
    const errors: string[] = [];
    const logger: Logger = { step() {}, info() {}, error(message) { errors.push(message); } };
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string" });
    const images = await createImages({ ...baseConfig, chunk: 1 }, { blobs, db, logger }, () => 1000);
    await addImage(db, blobs, "a", await jpeg(200, 200));

    expectOk(await images.sync());
    // the loop reads the job row first, so the injected failure lands inside loopOnce()
    db.failNext("TRANSIENT");
    await whenIdle(images);

    const job = expectOk(await db.findOne<Job>(JOBS, {}));
    expect(job).toMatchObject({ state: "error" });
    expect(job?.error).toContain("injected TRANSIENT");
    expect(errors).toContain("images: sync job failed");
  });
});

describe("prune", () => {
  it("deletes only orphaned sizes and their blobs, refusing a declared name", async () => {
    const { images, db, blobs } = await make();
    expectOk(await images.register([{ name: "card", width: 480 }]));
    await addImage(db, blobs, "a", await jpeg(600, 400));
    expectOk(await images.generate("a"));
    expectOk(await images.register([{ name: "other", width: 100 }])); // "card" becomes orphaned

    expect(expectErr(await images.prune(["thumb"]), "VALIDATION").message).toContain("not an orphan");
    expect(expectErr(await images.prune(["gone"]), "VALIDATION").message).toContain("has no variants");

    const result = expectOk(await images.prune(["card"]));
    expect(result).toEqual({ sizes: 1, variants: 1 });
    expect(expectOk(await db.count(VARIANTS, { size: "card" }))).toBe(0);
    expect(expectOk(await images.status()).orphaned).toEqual({ sizes: [], variants: 0 });
  });
});

describe("status", () => {
  it("reports per-size variant counts and used flags", async () => {
    const { images, db, blobs } = await make();
    await addImage(db, blobs, "a", await jpeg(600, 400));
    expectOk(await images.generate("a"));
    const status = expectOk(await images.status());
    const thumb = status.sizes.find((s) => s.name === "thumb")!;
    expect(thumb.used).toBe(false); // defaults are never "registered"
    expect(thumb.variants).toEqual({ done: 1, pending: 0, error: 0, failed: 0 });
  });
});

describe("remove", () => {
  it("deletes an item's variant blobs and rows", async () => {
    const { images, db, blobs } = await make();
    await addImage(db, blobs, "a", await jpeg(600, 400));
    expectOk(await images.generate("a"));
    const removed = expectOk(await images.remove("a"));
    expect(removed).toBe(5);
    expect(expectOk(await db.count(VARIANTS, { mediaId: "a" }))).toBe(0);
    expect([...blobs.blobs.keys()].some((k) => k.startsWith("media-variants/a/"))).toBe(false);
  });
});

describe("read", () => {
  it("returns a done variant, falls back to the original for a pending/error size, and is null for an unknown size", async () => {
    const { images, db, blobs } = await make();
    await addImage(db, blobs, "a", await jpeg(600, 400));
    expectOk(await images.generate("a"));

    const thumb = expectOk(await images.read("a", "thumb.webp"));
    expect(thumb).toMatchObject({ fallback: false, contentType: "image/webp" });

    expect(expectOk(await images.read("a", "nope.webp"))).toBeNull();

    await db.deleteMany(VARIANTS, { mediaId: "a", size: "small" });
    const fallback = expectOk(await images.read("a", "small.webp"));
    expect(fallback).toMatchObject({ fallback: true, contentType: "image/jpeg" });
  });
});

describe("exportTo", () => {
  it("writes <dir>/<folder>/<filename>.<size>.webp for every done variant", async () => {
    const { images, db, blobs } = await make();
    await db.createOne(MEDIA, { id: "a", key: "orig/a.jpg", contentType: "image/jpeg", folder: "press", filename: "hero.jpg" });
    await blobs.put("orig/a.jpg", await jpeg(600, 400), { contentType: "image/jpeg" });
    expectOk(await images.generate("a"));

    const dir = await mkdtemp(join(tmpdir(), "images-export-"));
    try {
      const first = expectOk(await images.exportTo(dir));
      expect(first).toEqual({ written: 5, skipped: 0 });
      const target = join(dir, "press", "hero.jpg.thumb.webp");
      expect((await stat(target)).size).toBeGreaterThan(0);

      const second = expectOk(await images.exportTo(dir));
      expect(second).toEqual({ written: 0, skipped: 5 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("close()", () => {
  it("is a no-op without an active job", async () => {
    const { images } = await make();
    await expect(images.close()).resolves.toBeUndefined();
  });

  it("answers CONFLICT from sync() and resume() once close() has started, before it finishes", async () => {
    const { images, db, blobs } = await make();
    await addImage(db, blobs, "a", await jpeg(200, 200));
    expectOk(await images.sync());
    await whenIdle(images);

    const closing = images.close();
    expect(expectErr(await images.sync(), "CONFLICT").message).toContain("shutting down");
    expect(expectErr(await images.resume(), "CONFLICT").message).toContain("shutting down");
    await closing;
  });
});

describe("generate concurrency", () => {
  it("serializes concurrent generate() calls for the same mediaId, producing exactly one row per size", async () => {
    const { images, db, blobs } = await make();
    await addImage(db, blobs, "a", await jpeg(1200, 800));
    const [r1, r2] = await Promise.all([images.generate("a"), images.generate("a")]);
    expect(r1).toBe(r2);
    expect(expectOk(await db.count(VARIANTS, { mediaId: "a" }))).toBe(5);
  });
});

describe("exportTo escape guard", () => {
  it("refuses to write a variant outside the export directory", async () => {
    const { images, db, blobs } = await make();
    await db.createOne(MEDIA, { id: "a", key: "orig/a.jpg", contentType: "image/jpeg", folder: "../..", filename: "hero.jpg" });
    await blobs.put("orig/a.jpg", await jpeg(200, 200), { contentType: "image/jpeg" });
    expectOk(await images.generate("a"));

    const dir = await mkdtemp(join(tmpdir(), "images-export-escape-"));
    try {
      await expect(images.exportTo(dir)).rejects.toThrow(/escapes/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("variantsOf batching", () => {
  it("chunks more than 200 mediaIds and paginates through more than 500 result rows", async () => {
    const { images, db } = await make();
    const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
    for (const id of ids) {
      for (const size of ["a", "b", "c"]) {
        await db.createOne(VARIANTS, { mediaId: id, size, spec: "s", width: 1, height: 1, format: "webp", key: `k/${id}/${size}`, bytes: 1, state: "done", error: null, attempts: 1, updatedAt: 1 });
      }
    }
    const map = expectOk(await images.variantsOf(ids));
    expect(map.size).toBe(250);
    expect(map.get("m0")).toHaveLength(3);
    expect(map.get("m249")).toHaveLength(3);
    const total = [...map.values()].reduce((sum, v) => sum + v.length, 0);
    expect(total).toBe(750);
  });
});

describe("remove pagination", () => {
  it("removes more than 500 variant rows for one id", async () => {
    const { images, db, blobs } = await make();
    for (let i = 0; i < 620; i += 1) {
      const key = `media-variants/a/size${i}.webp`;
      await blobs.put(key, new Uint8Array([1]), { contentType: "image/webp" });
      await db.createOne(VARIANTS, { mediaId: "a", size: `size${i}`, spec: "s", width: 1, height: 1, format: "webp", key, bytes: 1, state: "done", error: null, attempts: 1, updatedAt: 1 });
    }
    const removed = expectOk(await images.remove("a"));
    expect(removed).toBe(620);
    expect(expectOk(await db.count(VARIANTS, { mediaId: "a" }))).toBe(0);
  });
});

describe("prune dedupe and pagination", () => {
  it("dedupes repeated names and paginates through more than 500 variant rows", async () => {
    const { images, db, blobs } = await make();
    for (let i = 0; i < 620; i += 1) {
      const key = `media-variants/m${i}/card.webp`;
      await blobs.put(key, new Uint8Array([1]), { contentType: "image/webp" });
      await db.createOne(VARIANTS, { mediaId: `m${i}`, size: "card", spec: "s", width: 1, height: 1, format: "webp", key, bytes: 1, state: "done", error: null, attempts: 1, updatedAt: 1 });
    }
    const result = expectOk(await images.prune(["card", "card"]));
    expect(result).toEqual({ sizes: 1, variants: 620 });
    expect(expectOk(await db.count(VARIANTS, { size: "card" }))).toBe(0);
  });
});

describe("status registrySeen", () => {
  it("does not report orphaned sizes before this process has ever called register()", async () => {
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string" });
    const images1 = await createImages(baseConfig, { blobs, db, logger: noLogger }, () => 1000);
    await images1.register([{ name: "card", width: 480 }]);
    await addImage(db, blobs, "a", await jpeg(600, 400));
    expectOk(await images1.generate("a"));

    const images2 = await createImages(baseConfig, { blobs, db, logger: noLogger }, () => 2000);
    const before = expectOk(await images2.status());
    expect(before.registrySeen).toBe(false);
    expect(before.orphaned).toEqual({ sizes: [], variants: 0 });
    expect(before.sizes.find((s) => s.name === "card")).toBeUndefined();

    expectOk(await images2.register([{ name: "other", width: 100 }])); // "card" is not declared any more
    const after = expectOk(await images2.status());
    expect(after.registrySeen).toBe(true);
    expect(after.orphaned.sizes).toEqual(["card"]);
  });
});

describe("pending variant rows", () => {
  it("leaves an error row behind when the render fails", async () => {
    const { images, db, blobs } = await make();
    await db.createOne(MEDIA, { id: "a", key: "orig/a.jpg", contentType: "image/jpeg", folder: "", filename: "a.jpg" });
    await blobs.put("orig/a.jpg", new Uint8Array([1, 2, 3]), { contentType: "image/jpeg" });
    expectOk(await images.generate("a"));
    const rows = expectOk(await db.findMany<Variant>(VARIANTS, { mediaId: "a" }, { limit: 50 })).items;
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.state === "error")).toBe(true);
  });

  it("writes the row as pending before the render finishes", async () => {
    const { images, db, blobs } = await make();
    await addImage(db, blobs, "a", await jpeg(1200, 900));
    const running = images.generate("a");
    await waitFor(async () => expectOk(await db.findOne<Variant>(VARIANTS, { mediaId: "a" })) !== null);
    const first = expectOk(await db.findOne<Variant>(VARIANTS, { mediaId: "a" }));
    expect(first?.state).toBe("pending");
    await running;
  });

  it("read() falls back to the original while a row is still pending", async () => {
    const { images, db, blobs } = await make();
    await addImage(db, blobs, "a", await jpeg(400, 300));
    await db.createOne(VARIANTS, { mediaId: "a", size: "thumb", spec: "x", width: 0, height: 0, format: "", key: "", bytes: 0, state: "pending", error: null, attempts: 1, updatedAt: 1000 });
    const found = expectOk(await images.read("a", "thumb.webp"));
    expect(found).toMatchObject({ fallback: true, variant: "pending" });
  });
});

describe("bounded attempts", () => {
  const corrupt = async (config: Partial<Config> = { maxAttempts: 2 }) => {
    const made = await make(config);
    await made.db.createOne(MEDIA, { id: "a", key: "orig/a.jpg", contentType: "image/jpeg", folder: "", filename: "a.jpg" });
    await made.blobs.put("orig/a.jpg", new Uint8Array([1, 2, 3]), { contentType: "image/jpeg" });
    return made;
  };

  it("gives up after maxAttempts and stops retrying the variant", async () => {
    const { images, db } = await corrupt();
    expect(expectOk(await images.generate("a")).every((v) => v.state === "error" && v.attempts === 1)).toBe(true);
    expect(expectOk(await images.generate("a")).every((v) => v.state === "failed" && v.attempts === 2)).toBe(true);
    expect(expectOk(await images.generate("a")).every((v) => v.state === "failed" && v.attempts === 2)).toBe(true);
    expect(expectOk(await db.count(VARIANTS, { state: "failed" }))).toBe(5);
  });

  it("defaults the budget to five attempts", async () => {
    const { images } = await corrupt({});
    for (let attempt = 1; attempt < 5; attempt += 1) expect(expectOk(await images.generate("a")).every((v) => v.state === "error")).toBe(true);
    expect(expectOk(await images.generate("a")).every((v) => v.state === "failed")).toBe(true);
  });

  it("leaves a failed variant out of the sync loop", async () => {
    const { images, db } = await corrupt();
    expectOk(await images.generate("a"));
    expectOk(await images.generate("a"));
    expectOk(await images.sync());
    await whenIdle(images);
    expect(expectOk(await db.count(VARIANTS, { attempts: { gt: 2 } }))).toBe(0);
    expect(expectOk(await images.status()).job).toMatchObject({ state: "done", done: 0, failed: 1 });
  });

  it("404s instead of serving the original once a variant has failed, and names the failure", async () => {
    const { images } = await corrupt();
    expectOk(await images.generate("a"));
    expect(expectOk(await images.read("a", "thumb.webp"))).toMatchObject({ fallback: true, variant: "pending" });
    expect(expectOk(await images.failure("a", "thumb.webp"))).toBeNull();

    expectOk(await images.generate("a"));
    expect(expectOk(await images.read("a", "thumb.webp"))).toBeNull();
    expect(expectOk(await images.failure("a", "thumb.webp"))).toMatchObject({ size: "thumb", attempts: 2 });
  });

  it("counts failed variants separately in status()", async () => {
    const { images } = await corrupt();
    expectOk(await images.generate("a"));
    expectOk(await images.generate("a"));
    const thumb = expectOk(await images.status()).sizes.find((s) => s.name === "thumb")!;
    expect(thumb.variants).toEqual({ done: 0, pending: 0, error: 0, failed: 1 });
  });

  it("retries with a fresh budget when the size definition changes", async () => {
    const { images } = await corrupt();
    expectOk(await images.generate("a"));
    expectOk(await images.generate("a"));
    expectOk(await images.register([{ name: "thumb", width: 111 }]));
    const retried = expectOk(await images.generate("a")).find((v) => v.size === "thumb");
    expect(retried).toMatchObject({ state: "error", attempts: 1 });
  });
});

describe("job progress", () => {
  it("advances done/updatedAt after each image, not once per chunk", async () => {
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string" });
    let clock = 1000;
    const images = await createImages({ ...baseConfig, chunk: 5 }, { blobs, db, logger: noLogger }, () => (clock += 1000));
    await addImage(db, blobs, "a", await jpeg(200, 200));
    await addImage(db, blobs, "b", await jpeg(200, 200));

    const progress: Array<{ done: number; updatedAt: number }> = [];
    const updateOne = db.updateOne.bind(db);
    db.updateOne = ((collection, id, patch) => {
      const job = patch as Partial<Job>;
      if (collection === JOBS && job.done !== undefined) progress.push({ done: job.done, updatedAt: job.updatedAt! });
      return updateOne(collection, id, patch);
    }) satisfies typeof db.updateOne;

    const job = expectOk(await images.sync());
    await whenIdle(images);
    expect(progress.map((p) => p.done)).toEqual([1, 2, 2]);
    expect(progress[0]!.updatedAt).toBeGreaterThan(job.updatedAt);
  });
});

describe("concurrent sync()", () => {
  it("returns the same job for two simultaneous calls and creates one job row", async () => {
    const { images, db, blobs } = await make({ chunk: 1 });
    await addImage(db, blobs, "a", await jpeg(200, 200));
    const [first, second] = await Promise.all([images.sync(), images.sync()]);
    expect(expectOk(first).id).toBe(expectOk(second).id);
    expect(expectOk(await db.count(JOBS, {}))).toBe(1);
    await whenIdle(images);
  });
});

describe("variant key changes", () => {
  it("deletes the previous blob when a size switches format", async () => {
    const { images, db, blobs } = await make({ sizes: [{ name: "thumb", width: 100, fit: "inside", format: "webp", quality: 80 }] });
    await addImage(db, blobs, "a", await jpeg(400, 300));
    expectOk(await images.generate("a"));
    expect([...blobs.blobs.keys()]).toContain("media-variants/a/thumb.webp");

    const other = await createImages({ ...baseConfig, sizes: [{ name: "thumb", width: 100, fit: "inside", format: "original", quality: 80 }] }, { blobs, db, logger: noLogger }, () => 2000);
    await other.generate("a");
    expect([...blobs.blobs.keys()]).not.toContain("media-variants/a/thumb.webp");
    expect([...blobs.blobs.keys()]).toContain("media-variants/a/thumb.jpg");
  });
});
