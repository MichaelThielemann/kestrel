import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok } from "@michaelthielemann/kestrel/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_RENDER_TIMEOUT_MS, JOBS, RETIRED, VARIANTS, createImages, whenIdle } from "./impl.ts";
import type { Config, Images, Job, Retired, Variant } from "./impl.ts";
import type { Renderer } from "./generate.ts";
import type { Size } from "./sizes.ts";

type MemoryBlobstore = Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> };

function memoryBlobstore(): MemoryBlobstore {
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

const noLogger: Logger = { step() {}, info() {}, error() {} };
const MEDIA = "media_items";
const THUMB: Size = { name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 };
const HERO: Size = { name: "hero", width: 800, fit: "inside", format: "original", quality: 82 };
const baseConfig: Config = { prefix: "media-variants/", publicPath: "/media", publicCopy: { prefix: "site/" }, media: { collection: MEDIA }, chunk: 20, staleAfterMs: 60000, maxAttempts: DEFAULT_MAX_ATTEMPTS, renderTimeoutMs: DEFAULT_RENDER_TIMEOUT_MS, sizes: [THUMB] };
const fixedRenderer: Renderer = async (_data, size, planned) => ({ data: new Uint8Array([9, 9, size.name.length]), width: planned.width, height: planned.height, format: planned.format, ext: planned.format, contentType: `image/${planned.format}` });

async function jpeg(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } }).jpeg().toBuffer();
}

interface World {
  blobs: MemoryBlobstore;
  db: FakePersistence;
  images: Images;
  open(overrides?: Partial<Config>, render?: Renderer): Promise<Images>;
}

async function world(config: Partial<Config> = {}, render: Renderer = fixedRenderer): Promise<World> {
  const blobs = memoryBlobstore();
  const db = createFakePersistence();
  expectOk(await db.ensureCollection(MEDIA, { key: "string", contentType: "string", folder: "string", filename: "string", status: "string", size: "number", width: "number", height: "number", createdAt: "number" }));
  const open = (overrides: Partial<Config> = {}, r: Renderer = render): Promise<Images> => createImages({ ...baseConfig, ...config, ...overrides }, { blobs, db, logger: noLogger, render: r }, () => 1000);
  return { blobs, db, images: await open(), open };
}

async function seed(w: World, id: string, data: Uint8Array, patch: Record<string, unknown> = {}): Promise<string> {
  const key = `media/${id}/photo.jpg`;
  expectOk(await w.db.createOne(MEDIA, { id, key, contentType: "image/jpeg", folder: "", filename: "photo.jpg", status: "ready", size: data.byteLength, width: null, height: null, createdAt: 1000, ...patch }));
  expectOk(await w.blobs.put(key, data, { contentType: "image/jpeg" }));
  return key;
}

async function deleteMedia(w: World, id: string): Promise<void> {
  expectOk(await w.blobs.remove(`media/${id}/photo.jpg`));
  expectOk(await w.db.deleteOne(MEDIA, id));
}

function copiesOf(w: World, id: string): string[] {
  return [...w.blobs.blobs.keys()].filter((k) => k.startsWith(`site/media/${id}/variants/`));
}

function privateBlobsOf(w: World, id: string): string[] {
  return [...w.blobs.blobs.keys()].filter((k) => k.startsWith(`media-variants/${id}/`));
}

async function rowsOf(w: World, id: string): Promise<Variant[]> {
  return expectOk(await w.db.findMany<Variant>(VARIANTS, { mediaId: id })).items;
}

function gate(): { wait: Promise<void>; open(): void; reached: Promise<void>; arrive(): void } {
  let open: () => void = () => {};
  let arrive: () => void = () => {};
  const wait = new Promise<void>((resolve) => { open = resolve; });
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  return { wait, open, reached, arrive };
}

function isAvailable(rows: Variant[]): boolean {
  return rows.length > 0 && rows.every((r) => r.state !== "planned");
}

describe("images/default: a render finishing after its item was deleted", () => {
  it("images.remove waits for a render in flight in the same process, and nothing of the item stays behind", async () => {
    const g = gate();
    const gated: Renderer = async (d, s, p) => { g.arrive(); await g.wait; return fixedRenderer(d, s, p); };
    const w = await world({}, gated);
    await seed(w, "m1", await jpeg(1000, 600));
    expectOk(await w.images.plan(["m1"]));
    const generating = w.images.generate("m1");
    await g.reached;
    await deleteMedia(w, "m1");
    let removed = false;
    const removing = w.images.remove("m1").then((r) => { removed = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(removed).toBe(false);
    g.open();
    await generating;
    expectOk(await removing);
    expect(copiesOf(w, "m1")).toEqual([]);
    expect(privateBlobsOf(w, "m1")).toEqual([]);
    expect(await rowsOf(w, "m1")).toEqual([]);
  });

  it("a render whose row was deleted by another process removes its copy and private blob", async () => {
    const g = gate();
    const gated: Renderer = async (d, s, p) => { g.arrive(); await g.wait; return fixedRenderer(d, s, p); };
    const w = await world({}, gated);
    const other = await w.open({}, fixedRenderer);
    await seed(w, "m1", await jpeg(1000, 600));
    expectOk(await w.images.plan(["m1"]));
    const generating = w.images.generate("m1");
    await g.reached;
    await deleteMedia(w, "m1");
    expectOk(await other.remove("m1"));
    expect(copiesOf(w, "m1")).toEqual([]);
    g.open();
    expectOk(await generating);
    expect(copiesOf(w, "m1")).toEqual([]);
    expect(privateBlobsOf(w, "m1")).toEqual([]);
    expect(await rowsOf(w, "m1")).toEqual([]);
  });
});

describe("images/default: a plan whose item is deleted while it places", () => {
  it("re-reads the item after placing and removes its rows and copies when another process deleted it", async () => {
    const w = await world();
    const other = await w.open();
    await seed(w, "m1", await jpeg(1000, 600));
    const g = gate();
    const createMany = w.db.createMany.bind(w.db);
    const createOne = w.db.createOne.bind(w.db);
    let armed = true;
    const pause = async (collection: string): Promise<void> => {
      if (armed && collection === VARIANTS) { armed = false; g.arrive(); await g.wait; }
    };
    w.db.createMany = async (collection, docs) => { await pause(collection); return createMany(collection, docs); };
    w.db.createOne = async (collection, doc) => { await pause(collection); return createOne(collection, doc); };
    const planning = w.images.plan(["m1"]);
    await g.reached;
    await deleteMedia(w, "m1");
    expectOk(await other.remove("m1"));
    g.open();
    expectOk(await planning);
    expect(copiesOf(w, "m1")).toEqual([]);
    expect(await rowsOf(w, "m1")).toEqual([]);
  });

  it("images.remove waits for a plan in flight in the same process", async () => {
    const w = await world();
    await seed(w, "m1", await jpeg(1000, 600));
    const g = gate();
    const put = w.blobs.put.bind(w.blobs);
    let armed = true;
    w.blobs.put = async (key, data, options) => {
      if (armed && key.startsWith("site/")) { armed = false; g.arrive(); await g.wait; }
      return put(key, data, options);
    };
    const planning = w.images.plan(["m1"]);
    await g.reached;
    await deleteMedia(w, "m1");
    let removed = false;
    const removing = w.images.remove("m1").then((r) => { removed = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(removed).toBe(false);
    g.open();
    await planning;
    expectOk(await removing);
    expect(copiesOf(w, "m1")).toEqual([]);
    expect(await rowsOf(w, "m1")).toEqual([]);
  });
});

describe("images/default: images.syncPublic never removes a live variant", { timeout: 60_000 }, () => {
  it("keeps every live copy when rows of deleted items and live rows together span more than one page", async () => {
    const w = await world({ sizes: undefined });
    for (let i = 0; i < 5; i++) {
      expectOk(await w.db.createOne(VARIANTS, { mediaId: "gone", size: `s${i}`, spec: "x", width: 1, height: 1, format: "webp", key: `media-variants/gone/s${i}.webp`, bytes: 0, state: "pending", error: null, attempts: 0, updatedAt: 1 }));
    }
    const data = await jpeg(64, 48);
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) {
      const id = `m${String(i).padStart(3, "0")}`;
      ids.push(id);
      await seed(w, id, data);
      expectOk(await w.images.plan([id]));
    }
    const before = ids.flatMap((id) => copiesOf(w, id)).length;
    expect(before).toBe(505);
    expectOk(await w.images.syncPublic());
    await whenIdle(w.images);
    expect(ids.flatMap((id) => copiesOf(w, id)).length).toBe(before);
    expect(await rowsOf(w, "gone")).toEqual([]);
  });

  it("keeps the rows and copies of an item placed by another process while it runs", async () => {
    const w = await world();
    const other = await w.open();
    await seed(w, "m0", await jpeg(400, 300));
    expectOk(await w.images.plan(["m0"]));
    const data = await jpeg(400, 300);
    const findMany = w.db.findMany.bind(w.db);
    let fired = false;
    w.db.findMany = async (collection, filter, options) => {
      if (!fired && collection === VARIANTS) {
        fired = true;
        await seed(w, "fresh", data);
        expectOk(await other.plan(["fresh"]));
      }
      return findMany(collection, filter, options);
    };
    expectOk(await w.images.syncPublic());
    await whenIdle(w.images);
    expect(await rowsOf(w, "fresh")).toHaveLength(1);
    expect(copiesOf(w, "fresh")).toHaveLength(1);
  });

  it("starts a sync job that renders rows still pending", async () => {
    const w = await world();
    await seed(w, "m1", await jpeg(1000, 600));
    expectOk(await w.images.plan(["m1"]));
    expectOk(await w.images.syncPublic());
    await whenIdle(w.images);
    const rows = await rowsOf(w, "m1");
    expect(rows.map((r) => r.state)).toEqual(["done"]);
  });
});

describe("images/default: a format change", () => {
  it("re-plans the size's own row: one row per size, Node serves the new file, the old file is retired and no longer listed", async () => {
    const w = await world({ sizes: [HERO] });
    await seed(w, "m1", await jpeg(1000, 600));
    expectOk(await w.images.plan(["m1"]));
    expectOk(await w.images.generate("m1"));
    const reformed = await w.open({ sizes: [{ ...HERO, format: "webp" }] });
    expectOk(await reformed.plan(["m1"]));
    const rows = await rowsOf(w, "m1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("media-variants/m1/hero.webp");
    expect(rows[0]!.state).toBe("pending");
    expect(expectOk(await reformed.read("m1", "hero.webp"))?.variant).toBe("original");
    expect(expectOk(await reformed.read("m1", "hero.jpg"))?.variant).toBe("original");
    expect(expectOk(await w.db.findMany<Retired>(RETIRED, { mediaId: "m1" })).items.map((r) => r.file)).toEqual(["hero.jpg"]);
    expect(expectOk(await reformed.variantsOf(["m1"])).get("m1")!.map((v) => reformed.publicPath("m1", v))).toEqual(["/media/m1/variants/hero.webp"]);
    expectOk(await reformed.generate("m1"));
    expect(expectOk(await reformed.read("m1", "hero.webp"))?.variant).toBe("done");
    expect(expectOk(await reformed.read("m1", "hero.jpg"))?.variant).toBe("original");
    expect((await rowsOf(w, "m1")).map((r) => r.state)).toEqual(["done"]);
  });

  it("changing the format back makes the old file current again instead of keeping it retired", async () => {
    const w = await world({ sizes: [HERO] });
    await seed(w, "m1", await jpeg(1000, 600));
    expectOk(await w.images.plan(["m1"]));
    const webp = await w.open({ sizes: [{ ...HERO, format: "webp" }] });
    expectOk(await webp.plan(["m1"]));
    const back = await w.open({ sizes: [HERO] });
    expectOk(await back.plan(["m1"]));
    expectOk(await back.generate("m1"));
    const rows = await rowsOf(w, "m1");
    expect(rows.map((r) => r.key)).toEqual(["media-variants/m1/hero.jpg"]);
    expect(expectOk(await w.db.findMany<Retired>(RETIRED, { mediaId: "m1" })).items.map((r) => r.file)).toEqual(["hero.webp"]);
    expect(expectOk(await back.read("m1", "hero.jpg"))?.variant).toBe("done");
    expectOk(await back.syncPublic());
    expect(w.blobs.blobs.get("site/media/m1/variants/hero.jpg")?.data).toEqual(new Uint8Array([9, 9, 4]));
  });
});

describe("images/default: an image that cannot be decoded", () => {
  it("stays unavailable and lists no path while its placeholder cannot be written, and becomes available once it is", async () => {
    const w = await world();
    await seed(w, "m1", new Uint8Array([1, 2, 3]), { width: 100, height: 50 });
    const put = w.blobs.put.bind(w.blobs);
    w.blobs.put = async (k, d, o) => (k.startsWith("site/") ? err(failure("TRANSIENT", "down")) : put(k, d, o));
    expectErr(await w.images.plan(["m1"]), "TRANSIENT");
    const rows = await rowsOf(w, "m1");
    expect(rows.map((r) => r.state)).toEqual(["planned"]);
    expect(isAvailable(rows)).toBe(false);
    w.blobs.put = put;
    await w.images.resume();
    const repaired = await rowsOf(w, "m1");
    expect(repaired.map((r) => r.state)).toEqual(["failed"]);
    expect(repaired[0]!.error).toBe("cannot decode");
    expect(w.blobs.blobs.get("site/media/m1/variants/thumb.webp")?.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("an inline generation writes no placeholder for it; the background loop places it right after", async () => {
    const w = await world();
    await seed(w, "m1", new Uint8Array([1, 2, 3]), { width: 100, height: 50 });
    let puts = 0;
    const put = w.blobs.put.bind(w.blobs);
    w.blobs.put = async (k, d, o) => { puts += 1; return put(k, d, o); };
    await w.images.generate("m1");
    expect(puts).toBe(0);
    expect((await rowsOf(w, "m1")).map((r) => r.state)).toEqual(["planned"]);
    await whenIdle(w.images);
    expect((await rowsOf(w, "m1")).map((r) => r.state)).toEqual(["failed"]);
    expect(w.blobs.blobs.get("site/media/m1/variants/thumb.webp")?.data).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("images/default: a spec change of a size still planned", () => {
  it("keeps the row planned until its placeholder is written, so no listed path lacks its object", async () => {
    const w = await world();
    await seed(w, "m1", await jpeg(1000, 600));
    const put = w.blobs.put.bind(w.blobs);
    w.blobs.put = async (k, d, o) => (k.startsWith("site/") ? err(failure("TRANSIENT", "down")) : put(k, d, o));
    expectErr(await w.images.plan(["m1"]), "TRANSIENT");
    w.blobs.put = async (k, d, o) => (k.startsWith("site/") ? err(failure("TRANSIENT", "down")) : put(k, d, o));
    const respecced = await w.open({ sizes: [{ ...THUMB, width: 300 }] });
    expectErr(await respecced.plan(["m1"]), "TRANSIENT");
    const stuck = await rowsOf(w, "m1");
    expect(stuck.map((r) => [r.state, r.width])).toEqual([["planned", 300]]);
    w.blobs.put = put;
    expectOk(await respecced.plan(["m1"]));
    const rows = await rowsOf(w, "m1");
    expect(rows.map((r) => r.state)).toEqual(["pending"]);
    expect(w.blobs.blobs.has("site/media/m1/variants/thumb.webp")).toBe(true);
  });
});

describe("images/default: one row per item and size", () => {
  it("two planners of one item at once create one row per size", async () => {
    const w = await world({ sizes: [THUMB, HERO] });
    const other = await w.open();
    await seed(w, "m1", await jpeg(1000, 600));
    const [a, b] = await Promise.all([w.images.plan(["m1"]), other.plan(["m1"])]);
    expectOk(a);
    expectOk(b);
    const rows = await rowsOf(w, "m1");
    expect(rows.map((r) => r.size).sort()).toEqual(["hero", "thumb"]);
    expect(rows.every((r) => r.state === "pending")).toBe(true);
  });

  it("the store itself rejects a second row for the same item and size", async () => {
    const w = await world();
    await seed(w, "m1", await jpeg(1000, 600));
    expectOk(await w.images.plan(["m1"]));
    const [row] = await rowsOf(w, "m1");
    expectErr(await w.db.createOne(VARIANTS, { ...row!, id: "another" }), "CONFLICT");
  });
});

describe("images/default: one item with a missing original", () => {
  it("does not stop the repair pass from placing the other items or resuming a stalled job", async () => {
    const w = await world();
    expectOk(await w.db.createOne(MEDIA, { id: "a-broken", key: "media/a-broken/photo.jpg", contentType: "image/jpeg", folder: "", filename: "photo.jpg", status: "ready", size: 10, width: null, height: null, createdAt: Date.now() }));
    await seed(w, "b-good", await jpeg(400, 300), { createdAt: Date.now() });
    const stalled = expectOk(await w.db.createOne<Job>(JOBS, { state: "error", total: 2, done: 0, failed: 0, cursor: "", startedAt: 1, updatedAt: 1, finishedAt: null, error: "earlier" }));
    const reopened = await w.open();
    const resumed = expectOk(await reopened.resume());
    expect(resumed?.id).toBe(stalled.id);
    await whenIdle(reopened);
    expect((await rowsOf(w, "b-good")).map((r) => r.state)).toEqual(["done"]);
    expect(await rowsOf(w, "a-broken")).toEqual([]);
  });

  it("does not stop the sync job at that item", async () => {
    const w = await world();
    expectOk(await w.db.createOne(MEDIA, { id: "a-broken", key: "media/a-broken/photo.jpg", contentType: "image/jpeg", folder: "", filename: "photo.jpg", status: "ready", size: 10, width: null, height: null, createdAt: 1 }));
    await seed(w, "b-good", await jpeg(400, 300));
    expectOk(await w.images.sync());
    await whenIdle(w.images);
    expect((await rowsOf(w, "b-good")).map((r) => r.state)).toEqual(["done"]);
    const job = expectOk(await w.db.findMany<Job>(JOBS, {})).items[0]!;
    expect(job.state).toBe("done");
    expect(job.failed).toBe(1);
  });
});
