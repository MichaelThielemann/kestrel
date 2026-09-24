import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Blobstore, PutOptions } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { EventHandler, Events } from "@michaelthielemann/kestrel-contracts/events";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Introspection, Manifest } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok } from "@michaelthielemann/kestrel/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_RENDER_TIMEOUT_MS, RETIRED, VARIANTS, createImages, whenIdle } from "./impl.ts";
import type { Config, Retired } from "./impl.ts";
import type { Renderer } from "./generate.ts";

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

function fakeEvents(): Events & { emitted: Array<{ name: string; data: Record<string, unknown> }> } {
  const handlers = new Map<string, Set<EventHandler>>();
  const emitted: Array<{ name: string; data: Record<string, unknown> }> = [];
  return {
    emitted,
    async emit(name, data) {
      emitted.push({ name, data });
      const set = handlers.get(name);
      if (!set) return;
      for (const handler of [...set]) await handler(name, data);
    },
    on(name, handler) {
      const set = handlers.get(name) ?? new Set();
      set.add(handler);
      handlers.set(name, set);
      return () => set.delete(handler);
    },
  };
}

const noLogger: Logger = { step() {}, info() {}, error() {} };

const MEDIA = "media_items";

async function jpeg(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } }).jpeg().toBuffer();
}

const baseConfig: Config = { prefix: "media-variants/", publicPath: "/media", media: { collection: MEDIA }, chunk: 20, staleAfterMs: 60000, maxAttempts: DEFAULT_MAX_ATTEMPTS, renderTimeoutMs: DEFAULT_RENDER_TIMEOUT_MS };

async function make(config: Partial<Config> = {}, now: () => number = () => 1000, render?: Renderer, events?: Events) {
  const blobs = fakeBlobstore();
  const db = createFakePersistence();
  await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string", status: "string", width: "number", height: "number", createdAt: "number" });
  const images = await createImages({ ...baseConfig, ...config }, { blobs, db, logger: noLogger, ...(render ? { render } : {}), ...(events ? { events } : {}) }, now);
  return { images, blobs, db };
}

async function seedMedia(db: ReturnType<typeof createFakePersistence>, patch: Record<string, unknown> = {}): Promise<{ id: string; key: string }> {
  const id = boundaryCast<string | undefined>(patch.id, "host");
  const key = `media/${id ?? "x"}/photo.jpg`;
  const created = expectOk(await db.createOne(MEDIA, { key, contentType: "image/jpeg", folder: "", filename: "photo.jpg", status: "ready", width: null, height: null, createdAt: 1000, ...patch }));
  return { id: created.id, key: boundaryCast<string>(created.key, "host") };
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

const fixedRenderer: Renderer = async (_data, _size, planned) => ({ data: new Uint8Array([9, 9]), width: planned.width, height: planned.height, format: planned.format, ext: planned.format === "webp" ? "webp" : planned.format, contentType: `image/${planned.format}` });

describe("images/default planning (images.plan)", () => {
  it("decides format, extension and dimensions per size and creates them as planned", async () => {
    const { images, db, blobs } = await make();
    const data = await jpeg(2000, 1000);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, data, { contentType: "image/jpeg" }));
    expectOk(await images.plan([id]));
    const rows = expectOk(await images.variantsOf([id])).get(id) ?? [];
    const thumb = rows.find((r) => r.size === "thumb");
    expect(thumb).toBeDefined();
    expect(thumb!.width).toBe(320);
    expect(thumb!.height).toBe(160);
    expect(thumb!.format).toBe("webp");
    expect(thumb!.key).toBe(`media-variants/${id}/thumb.webp`);
    expect(["pending"]).toContain(thumb!.state);
  });

  it("without publicCopy, rows go straight to pending with no blob put", async () => {
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string", status: "string", width: "number", height: "number", createdAt: "number" });
    let puts = 0;
    const countingBlobs: Blobstore = { ...blobs, put: (...a: Parameters<Blobstore["put"]>) => { puts += 1; return blobs.put(...a); } };
    const images = await createImages(baseConfig, { blobs: countingBlobs, db, logger: noLogger }, () => 1000);
    const data = await jpeg(2000, 1000);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, data, { contentType: "image/jpeg" }));
    expectOk(await images.plan([id]));
    expect(puts).toBe(0);
    const rows = expectOk(await images.variantsOf([id])).get(id) ?? [];
    expect(rows.every((r) => r.state === "pending")).toBe(true);
  });

  it("with publicCopy, writes a placeholder copy of the original for every size, then turns pending", async () => {
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" } });
    const data = await jpeg(1200, 800);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, data, { contentType: "image/jpeg" }));
    expectOk(await images.plan([id]));
    const rows = expectOk(await images.variantsOf([id])).get(id) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.state).toBe("pending");
      const copy = blobs.blobs.get(`site/media/${id}/variants/${row.size}.${row.format === "webp" ? "webp" : row.format}`);
      expect(copy?.data).toEqual(data);
    }
  });

  it("never runs more than four placement writes at a time", async () => {
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string", status: "string", width: "number", height: "number", createdAt: "number" });
    let inFlight = 0;
    let maxInFlight = 0;
    const gatedBlobs: Blobstore = {
      ...blobs,
      async put(key: string, data: Uint8Array, options?: PutOptions) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return blobs.put(key, data, options);
      },
    };
    const images = await createImages({ ...baseConfig, publicCopy: { prefix: "site/" }, sizes: [1, 2, 3, 4, 5, 6].map((n) => ({ name: `s${n}`, width: 100 + n, fit: "inside" as const, format: "webp" as const, quality: 82 })) }, { blobs: gatedBlobs, db, logger: noLogger }, () => 1000);
    const data = await jpeg(1200, 800);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, data, { contentType: "image/jpeg" }));
    expectOk(await images.plan([id]));
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("plans dimensions and a failed placeholder for an image sharp cannot decode, so it still becomes available", async () => {
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" } });
    const { id, key } = await seedMedia(db, { id: "m1", width: 100, height: 50 });
    expectOk(await blobs.put(key, new Uint8Array([1, 2, 3]), { contentType: "image/jpeg" }));
    expectOk(await images.plan([id]));
    const rows = expectOk(await images.variantsOf([id])).get(id) ?? [];
    expect(rows.every((r) => r.state === "failed")).toBe(true);
    expect(rows.every((r) => r.width === 100 && r.height === 50)).toBe(true);
    for (const row of rows) expect(blobs.blobs.has(`site/media/${id}/variants/${row.size}.${row.format}`)).toBe(true);
  });

  it("raises media.updated for the ids it made available", async () => {
    const events = fakeEvents();
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" } }, undefined, undefined, events);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(400, 300), { contentType: "image/jpeg" }));
    expectOk(await images.plan([id]));
    expect(events.emitted).toHaveLength(1);
    expect(events.emitted[0]?.name).toBe("media.updated");
    expect(events.emitted[0]?.data).toMatchObject({ id: null, ids: [id], identity: null });
  });

  it("raises media.updated for the items it placed before one it could not place", async () => {
    const events = fakeEvents();
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" } }, undefined, undefined, events);
    for (const id of ["a", "b"]) {
      const { key } = await seedMedia(db, { id });
      expectOk(await blobs.put(key, await jpeg(400, 300), { contentType: "image/jpeg" }));
    }
    const put = blobs.put.bind(blobs);
    blobs.put = async (key, data, options) => (key.startsWith("site/media/b/") ? err(failure("TRANSIENT", "down")) : put(key, data, options));
    expect((await images.plan(["a", "b"])).ok).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events.emitted.map((e) => boundaryCast<{ ids: string[] }>(e.data, "host").ids)).toEqual([["a"]]);
  });

  it("a sync job stopped by a TRANSIENT failure still raises media.updated for the items it placed before it", async () => {
    const events = fakeEvents();
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" }, sizes: [{ name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 }] }, undefined, fixedRenderer, events);
    for (const id of ["a", "b"]) {
      const { key } = await seedMedia(db, { id });
      expectOk(await blobs.put(key, await jpeg(400, 300), { contentType: "image/jpeg" }));
    }
    const put = blobs.put.bind(blobs);
    blobs.put = async (key, data, options) => (key.startsWith("site/media/b/") ? err(failure("TRANSIENT", "down")) : put(key, data, options));
    expectOk(await images.sync());
    await whenIdle(images);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events.emitted.map((e) => boundaryCast<{ ids: string[] }>(e.data, "host").ids)).toEqual([["a"]]);
  });

  it("does nothing, and emits nothing, a second time once already placed", async () => {
    const events = fakeEvents();
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" } }, undefined, undefined, events);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(400, 300), { contentType: "image/jpeg" }));
    expectOk(await images.plan([id]));
    events.emitted.length = 0;
    expectOk(await images.plan([id]));
    expect(events.emitted).toHaveLength(0);
  });
});

describe("images/default content rule (images.read)", () => {
  it("serves the original's bytes and type for a planned, pending, error or failed row", async () => {
    const { images, db, blobs } = await make();
    const original = await jpeg(400, 300);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, original, { contentType: "image/jpeg" }));
    expectOk(await images.plan([id]));
    const rows = expectOk(await images.variantsOf([id])).get(id) ?? [];
    const thumb = rows.find((r) => r.size === "thumb")!;
    const served = expectOk(await images.read(id, `thumb.${thumb.format}`));
    expect(served?.variant).toBe("original");
    expect(served?.fallback).toBe(true);
    expect(served?.contentType).toBe("image/jpeg");
    expect(Array.from(served?.data ?? [])).toEqual(Array.from(original));
  });

  it("serves the variant's own bytes once done", async () => {
    const { images, db, blobs } = await make({}, undefined, fixedRenderer);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(400, 300), { contentType: "image/jpeg" }));
    expectOk(await images.generate(id));
    const rows = expectOk(await images.variantsOf([id])).get(id) ?? [];
    const thumb = rows.find((r) => r.size === "thumb")!;
    expect(thumb.state).toBe("done");
    const served = expectOk(await images.read(id, `thumb.${thumb.format}`));
    expect(served?.variant).toBe("done");
    expect(served?.fallback).toBe(false);
  });

  it("404s (null) for a name that is neither current nor retired, or an unready item", async () => {
    const { images, db, blobs } = await make();
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(400, 300), { contentType: "image/jpeg" }));
    expectOk(await images.plan([id]));
    expect(expectOk(await images.read(id, "thumb.jpg"))).toBeNull();
    expect(expectOk(await images.read("missing", "thumb.webp"))).toBeNull();
    expectOk(await db.updateOne(MEDIA, id, { status: "uploading" }));
    expect(expectOk(await images.read(id, "thumb.webp"))).toBeNull();
  });

  it("serves the original for a retired file, forever, even after the current row moved on", async () => {
    const { images, db, blobs } = await make({ sizes: [{ name: "hero", width: 800, fit: "inside", format: "original", quality: 82 }] });
    const original = await jpeg(1000, 600);
    const { id, key } = await seedMedia(db, { id: "m1", contentType: "image/jpeg" });
    expectOk(await blobs.put(key, original, { contentType: "image/jpeg" }));
    expectOk(await images.plan([id]));
    const oldFile = (expectOk(await images.variantsOf([id])).get(id) ?? [])[0]!;
    expect(oldFile.format).toBe("jpeg");

    const reformed = await createImages({ ...baseConfig, sizes: [{ name: "hero", width: 800, fit: "inside", format: "webp", quality: 82 }] }, { blobs, db, logger: noLogger }, () => 1000);
    expectOk(await reformed.plan([id]));
    const retiredRows = expectOk(await db.findMany<Retired>(RETIRED, { mediaId: id })).items;
    expect(retiredRows.map((r) => r.file)).toContain("hero.jpg");
    const servedOld = expectOk(await reformed.read(id, "hero.jpg"));
    expect(servedOld?.variant).toBe("original");
  });
});

describe("images/default rendering", () => {
  it("renders to exactly the planned dimensions and writes the private blob (and copy, if publicCopy is set)", async () => {
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" } });
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(2000, 1000), { contentType: "image/jpeg" }));
    expectOk(await images.generate(id));
    const rows = expectOk(await images.variantsOf([id])).get(id) ?? [];
    const thumb = rows.find((r) => r.size === "thumb")!;
    expect(thumb.state).toBe("done");
    expect(thumb.width).toBe(320);
    expect(blobs.blobs.has(thumb.key)).toBe(true);
    expect(blobs.blobs.has(`site/media/${id}/variants/thumb.webp`)).toBe(true);
  });

  it("direct mode: a failed render writes no placeholder and leaves the row planned, then the background loop places it", async () => {
    let fail = true;
    const flaky: Renderer = async (data, size, planned) => {
      if (fail) throw new Error("render failed");
      return { data: new Uint8Array([1]), width: planned.width, height: planned.height, format: planned.format, ext: "webp", contentType: "image/webp" };
    };
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" }, sizes: [{ name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 }] }, undefined, flaky);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(2000, 1000), { contentType: "image/jpeg" }));
    let puts = 0;
    const before = blobs.put.bind(blobs);
    blobs.put = (...a: Parameters<Blobstore["put"]>) => { puts += 1; return before(...a); };
    await images.generate(id);
    expect(puts).toBe(0);
    const rows = expectOk(await images.variantsOf([id])).get(id) ?? [];
    expect(rows[0]?.state).toBe("planned");
    fail = false;
    await whenIdle(images);
    const after = expectOk(await images.variantsOf([id])).get(id) ?? [];
    expect(after[0]?.state).toBe("pending");
    expect(blobs.blobs.has(`site/media/${id}/variants/thumb.webp`)).toBe(true);
  });

  it("a render failure on an already-placed row counts an attempt and keeps the path's existing content", async () => {
    const fail = true;
    const flaky: Renderer = async (_data, _size, planned) => {
      if (fail) throw new Error("render failed");
      return { data: new Uint8Array([1]), width: planned.width, height: planned.height, format: "webp", ext: "webp", contentType: "image/webp" };
    };
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" }, sizes: [{ name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 }], maxAttempts: 2 }, undefined, flaky);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(2000, 1000), { contentType: "image/jpeg" }));
    expectOk(await images.plan([id]));
    await images.generate(id);
    let rows = expectOk(await images.variantsOf([id])).get(id) ?? [];
    expect(rows[0]?.state).toBe("error");
    await images.generate(id);
    rows = expectOk(await images.variantsOf([id])).get(id) ?? [];
    expect(rows[0]?.state).toBe("failed");
    expect(blobs.blobs.has(`site/media/${id}/variants/thumb.webp`)).toBe(true);
  });

  it("removes what it wrote when the media item is gone by the time it re-reads", async () => {
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string", status: "string", width: "number", height: "number", createdAt: "number" });
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(2000, 1000), { contentType: "image/jpeg" }));
    let reads = 0;
    const wrapped = { ...db, async findOne<T extends { id: string }>(collection: string, filter: Record<string, unknown>) {
      if (collection === MEDIA) {
        reads += 1;
        if (reads > 1) return ok(null);
      }
      return db.findOne<T>(collection, filter);
    } };
    const images = await createImages({ ...baseConfig, publicCopy: { prefix: "site/" } }, { blobs, db: wrapped, logger: noLogger, render: fixedRenderer }, () => 1000);
    await images.generate(id);
    expect(expectOk(await images.variantsOf([id])).get(id) ?? []).toEqual([]);
  });
});

describe("images/default media.updated outside an upload", () => {
  const THUMB = { name: "thumb", width: 320, fit: "inside" as const, format: "webp" as const, quality: 82 };
  const HERO = { name: "hero", width: 800, fit: "inside" as const, format: "original" as const, quality: 82 };

  async function threeRendered(events?: Events, logger: Logger = noLogger) {
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string", status: "string", width: "number", height: "number", createdAt: "number" });
    const open = (sizes: Array<typeof THUMB | typeof HERO>, chunk = 20) => createImages({ ...baseConfig, publicCopy: { prefix: "site/" }, sizes, chunk }, { blobs, db, logger, render: fixedRenderer, ...(events ? { events } : {}) }, () => 1000);
    const images = await open([THUMB, HERO]);
    const ids: string[] = [];
    for (const id of ["a", "b", "c"]) {
      const { key } = await seedMedia(db, { id });
      expectOk(await blobs.put(key, await jpeg(400, 300), { contentType: "image/jpeg" }));
      expectOk(await images.generate(id));
      ids.push(id);
    }
    return { blobs, db, ids, open };
  }

  it("a prune of a size three items use raises one event with those three ids", async () => {
    const events = fakeEvents();
    const { ids, open } = await threeRendered(events);
    events.emitted.length = 0;
    const narrowed = await open([THUMB]);
    expectOk(await narrowed.prune(["hero"]));
    expect(events.emitted).toHaveLength(1);
    expect(events.emitted[0]).toMatchObject({ name: "media.updated", data: { id: null, identity: null, params: {} } });
    expect(boundaryCast<{ ids: string[] }>(events.emitted[0]!.data, "host").ids.sort()).toEqual(ids);
  });

  it("a format change applied by the sync job raises one event per chunk with the ids it changed", async () => {
    const events = fakeEvents();
    const { open } = await threeRendered(events);
    events.emitted.length = 0;
    const reformed = await open([THUMB, { ...HERO, format: "webp" }], 2);
    reformed.attach(introspectionOf(manifestWithPipelines([{ pipeline: "serveImageVariant", module: "images/default", step: "images.serve" }])));
    await whenIdle(reformed);
    const updates = events.emitted.filter((e) => e.name === "media.updated").map((e) => boundaryCast<{ ids: string[] }>(e.data, "host").ids);
    expect(updates).toEqual([["a", "b"], ["c"]]);
  });

  it("without an events provider nothing is raised and the prune still succeeds", async () => {
    const { db, open } = await threeRendered();
    const narrowed = await open([THUMB]);
    expect(expectOk(await narrowed.prune(["hero"]))).toEqual({ sizes: 1, variants: 3 });
    expect(expectOk(await db.count(RETIRED, {}))).toBe(3);
  });

  it("a rejected emit is logged with the ids and the prune stands", async () => {
    const logged: Array<{ message: string; ids: unknown }> = [];
    const logger: Logger = { step() {}, info() {}, error: (message, fields) => logged.push({ message, ids: (fields as { ids?: unknown } | undefined)?.ids }) };
    const rejecting: Events = { emit: () => Promise.reject(new Error("subscriber down")), on: () => () => {} };
    const { db, blobs, open } = await threeRendered(rejecting, logger);
    const narrowed = await open([THUMB]);
    expectOk(await narrowed.prune(["hero"]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(logged.some((entry) => entry.message.includes("media.updated") && Array.isArray(entry.ids) && entry.ids.length === 3)).toBe(true);
    expect(expectOk(await db.count(VARIANTS, { size: "hero" }))).toBe(0);
    expect(expectOk(await db.count(RETIRED, {}))).toBe(3);
    expect(blobs.blobs.has("site/media/a/variants/hero.jpg")).toBe(true);
  });
});

describe("images/default prune and remove", () => {
  it("prune retires the size, keeps the path answering with the original, and removes the private blob and row", async () => {
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" } }, undefined, fixedRenderer);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(2000, 1000), { contentType: "image/jpeg" }));
    expectOk(await images.generate(id));
    const before = (expectOk(await images.variantsOf([id])).get(id) ?? []).find((r) => r.size === "thumb")!;
    expect(before.state).toBe("done");

    const remainingSizes = (await images.sizes()).filter((s) => s.name !== "thumb");
    const narrowed = await createImages({ ...baseConfig, publicCopy: { prefix: "site/" }, sizes: remainingSizes }, { blobs, db, logger: noLogger, render: fixedRenderer }, () => 1000);
    expectOk(await narrowed.prune(["thumb"]));
    expect((expectOk(await narrowed.variantsOf([id])).get(id) ?? []).some((r) => r.size === "thumb")).toBe(false);
    expect(blobs.blobs.has(before.key)).toBe(false);
    const served = expectOk(await narrowed.read(id, `thumb.${before.format}`));
    expect(served?.variant).toBe("original");
  });

  it("remove deletes variant rows, retired rows, their copies and blobs, then sweeps", async () => {
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" }, sizes: [{ name: "a", width: 100, fit: "inside", format: "original", quality: 82 }, { name: "b", width: 200, fit: "inside", format: "webp", quality: 82 }] }, undefined, fixedRenderer);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(2000, 1000), { contentType: "image/jpeg" }));
    expectOk(await images.generate(id));
    const narrowed = await createImages({ ...baseConfig, publicCopy: { prefix: "site/" }, sizes: [{ name: "b", width: 200, fit: "inside", format: "webp", quality: 82 }] }, { blobs, db, logger: noLogger, render: fixedRenderer }, () => 1000);
    expectOk(await narrowed.prune(["a"]));
    expectOk(await blobs.put(`site/media/${id}/variants/stray.png`, new Uint8Array([1]), { contentType: "image/png" }));
    expectOk(await narrowed.remove(id));
    expect(expectOk(await db.count(VARIANTS, { mediaId: id }))).toBe(0);
    expect(expectOk(await db.count(RETIRED, { mediaId: id }))).toBe(0);
    expect(expectOk(await blobs.list(`site/media/${id}/variants/`))).toEqual([]);
    expect(expectOk(await blobs.list(`media-variants/${id}/`))).toEqual([]);
  });
});

describe("images/default syncPublic", () => {
  it("writes a missing copy, removes a foreign file and a copy of a deleted item", async () => {
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" } }, undefined, fixedRenderer);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(2000, 1000), { contentType: "image/jpeg" }));
    expectOk(await images.generate(id));
    const row = (expectOk(await images.variantsOf([id])).get(id) ?? [])[0]!;
    const copyKey = `site/media/${id}/variants/${row.size}.${row.format}`;
    blobs.blobs.delete(copyKey);
    expectOk(await blobs.put(`site/media/${id}/variants/stray.png`, new Uint8Array([1]), { contentType: "image/png" }));
    expectOk(await blobs.put(`site/media/ghost/variants/gone.webp`, new Uint8Array([1]), { contentType: "image/webp" }));

    const synced = expectOk(await images.syncPublic());
    expect(synced.written).toBe(1);
    expect(synced.removed).toBe(2);
    expect(blobs.blobs.has(copyKey)).toBe(true);
  });

  it("plans a missing size and reports it, starting a sync job", async () => {
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" } });
    const { key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(2000, 1000), { contentType: "image/jpeg" }));
    const synced = expectOk(await images.syncPublic());
    expect(synced.planned).toBeGreaterThan(0);
    await whenIdle(images);
  });

  it("without publicCopy, is a no-op", async () => {
    const { images } = await make();
    expect(expectOk(await images.syncPublic())).toEqual({ written: 0, removed: 0, planned: 0, missing: 0 });
  });
});

describe("images/default boot rules", () => {
  it("throws when the copy tree and the store prefix overlap", async () => {
    await expect(createImages({ ...baseConfig, prefix: "media/", publicPath: "/media", publicCopy: { prefix: "" } }, { blobs: fakeBlobstore(), db: createFakePersistence(), logger: noLogger })).rejects.toThrow(/publicCopy tree "media\/" and prefix "media\/" overlap/);
  });

  it("attach throws when publicCopy is set but no pipeline runs images.serve", async () => {
    const { images } = await make({ publicCopy: { prefix: "site/" } });
    expect(() => images.attach(introspectionOf(manifestWithPipelines([{ pipeline: "getMedia", module: "media/default", step: "media.get" }])))).toThrow(/no pipeline runs images\.serve/);
    expect(() => images.attach(introspectionOf(manifestWithPipelines([{ pipeline: "serveImageVariant", module: "images/default", step: "images.serve" }])))).not.toThrow();
  });

  it("attach throws when a pipeline runs images.syncPublic without publicCopy", async () => {
    const { images } = await make();
    expect(() => images.attach(introspectionOf(manifestWithPipelines([{ pipeline: "repairPublicMedia", module: "images/default", step: "images.syncPublic" }])))).toThrow(/pipeline "repairPublicMedia" runs images\.syncPublic, but publicCopy is not set/);
  });
});

describe("images/default size set changes", () => {
  it("registering a spec change for a block-registered (non-config) size with existing items starts a background sync that re-plans them", async () => {
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" } }, undefined, fixedRenderer);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(2000, 1000), { contentType: "image/jpeg" }));
    expectOk(await images.generate(id));
    expectOk(await images.register([{ name: "thumb", width: 400, fit: "inside", format: "webp", quality: 82 }]));
    await whenIdle(images);
    const rows = expectOk(await images.variantsOf([id])).get(id) ?? [];
    expect(rows.find((r) => r.size === "thumb")?.width).toBe(400);
  });

  it("an unchanged register does not start a sync", async () => {
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" } }, undefined, fixedRenderer);
    const { id, key } = await seedMedia(db, { id: "m1" });
    expectOk(await blobs.put(key, await jpeg(2000, 1000), { contentType: "image/jpeg" }));
    expectOk(await images.generate(id));
    expectOk(await images.register([{ name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 }]));
    await whenIdle(images);
    const rows = expectOk(await images.variantsOf([id])).get(id) ?? [];
    expect(rows.find((r) => r.size === "thumb")?.width).toBe(320);
    expect(rows.find((r) => r.size === "thumb")?.state).toBe("done");
  });
});

describe("images/default size-set check at attach", () => {
  it("logs a store that throws during the check instead of leaving a rejected promise, and close waits for the check", async () => {
    const errors: string[] = [];
    const logger: Logger = { step() {}, info() {}, error: (message) => errors.push(message) };
    const blobs = fakeBlobstore();
    const db = createFakePersistence();
    await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string", status: "string", width: "number", height: "number", createdAt: "number" });
    const images = await createImages({ ...baseConfig, publicCopy: { prefix: "site/" } }, { blobs, db, logger }, () => 1000);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    db.count = async () => {
      await held;
      throw new Error("database is not open");
    };
    images.attach(introspectionOf(manifestWithPipelines([{ pipeline: "serveImageVariant", module: "images/default", step: "images.serve" }])));
    let closed = false;
    const closing = images.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(errors).toContain("images: could not check for a size-set shortfall");
  });
});

describe("images/default resume repair pass", () => {
  it("places and renders items created recently with no rows at all", async () => {
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" } }, undefined, fixedRenderer);
    const now = Date.now();
    const { id: a, key: keyA } = await seedMedia(db, { id: "a", createdAt: now });
    expectOk(await blobs.put(keyA, await jpeg(400, 300), { contentType: "image/jpeg" }));

    await images.resume();
    const rowsA = expectOk(await images.variantsOf([a])).get(a) ?? [];
    expect(rowsA.some((r) => r.state === "done")).toBe(true);
  });

  it("places and renders a row a crash left stuck at planned", async () => {
    const { images, db, blobs } = await make({ publicCopy: { prefix: "site/" } }, undefined, fixedRenderer);
    const { id: b, key: keyB } = await seedMedia(db, { id: "b", createdAt: 1 });
    expectOk(await blobs.put(keyB, await jpeg(400, 300), { contentType: "image/jpeg" }));
    expectOk(await images.plan([b]));
    const rows = expectOk(await images.variantsOf([b])).get(b) ?? [];
    for (const row of rows) expectOk(await db.updateOne(VARIANTS, row.id, { state: "planned" }));

    await images.resume();
    const rowsB = expectOk(await images.variantsOf([b])).get(b) ?? [];
    expect(rowsB.some((r) => r.state === "done")).toBe(true);
  });
});

