import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { createFakeMedia, type FakeMedia, type FakeMediaInput } from "@michaelthielemann/kestrel-contracts/testing/fakeMedia";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok } from "@michaelthielemann/kestrel/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_RENDER_TIMEOUT_MS, JOBS, RETIRED, VARIANTS, createImages, whenIdle } from "./impl.ts";
import type { Config, Images, Job, Retired, Variant } from "./impl.ts";
import { ELIGIBLE, type Renderer } from "./generate.ts";
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
const THUMB: Size = { name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 };
const HERO: Size = { name: "hero", width: 800, fit: "inside", format: "original", quality: 82 };
const baseConfig: Config = { prefix: "media-variants/", publicPath: "/media", publicCopy: { prefix: "site/" }, chunk: 20, staleAfterMs: 60000, maxAttempts: DEFAULT_MAX_ATTEMPTS, renderTimeoutMs: DEFAULT_RENDER_TIMEOUT_MS, sizes: [THUMB] };
const fixedRenderer: Renderer = async (_data, size, planned) => ({ data: new Uint8Array([9, 9, size.name.length]), width: planned.width, height: planned.height, format: planned.format, ext: planned.format, contentType: `image/${planned.format}` });

async function jpeg(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } }).jpeg().toBuffer();
}

interface World {
  blobs: MemoryBlobstore;
  db: FakePersistence;
  media: FakeMedia;
  images: Images;
  open(overrides?: Partial<Config>, render?: Renderer): Promise<Images>;
}

async function world(config: Partial<Config> = {}, render: Renderer = fixedRenderer, clock: () => number = () => 1000): Promise<World> {
  const blobs = memoryBlobstore();
  const db = createFakePersistence();
  const media = createFakeMedia();
  const open = (overrides: Partial<Config> = {}, r: Renderer = render): Promise<Images> => createImages({ ...baseConfig, ...config, ...overrides }, { blobs, db, media, logger: noLogger, render: r }, clock);
  return { blobs, db, media, images: await open(), open };
}

async function seed(w: World, id: string, data: Uint8Array, patch: Partial<FakeMediaInput> = {}): Promise<void> {
  w.media.add({ id, contentType: "image/jpeg", data, filename: "photo.jpg", createdAt: 1000, ...patch });
}

async function deleteMedia(w: World, id: string): Promise<void> {
  w.media.remove(id);
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

function recordRemovals(w: World): string[] {
  const removed: string[] = [];
  const remove = w.blobs.remove.bind(w.blobs);
  w.blobs.remove = async (key) => {
    removed.push(key);
    return remove(key);
  };
  return removed;
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
    const removed = recordRemovals(w);
    expectOk(await w.images.syncPublic());
    await whenIdle(w.images);
    expect(removed.filter((key) => key.startsWith("site/") && !key.includes("/gone/"))).toEqual([]);
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
    const removed = recordRemovals(w);
    expectOk(await w.images.syncPublic());
    await whenIdle(w.images);
    expect(removed).toEqual([]);
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
    let clock = 1000;
    const w = await world({}, fixedRenderer, () => clock);
    await seed(w, "m1", new Uint8Array([1, 2, 3]), { width: 100, height: 50 });
    const put = w.blobs.put.bind(w.blobs);
    w.blobs.put = async (k, d, o) => (k.startsWith("site/") ? err(failure("TRANSIENT", "down")) : put(k, d, o));
    expectErr(await w.images.plan(["m1"]), "TRANSIENT");
    const rows = await rowsOf(w, "m1");
    expect(rows.map((r) => r.state)).toEqual(["planned"]);
    expect(isAvailable(rows)).toBe(false);
    w.blobs.put = put;
    clock += baseConfig.staleAfterMs + 1;
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
    await seed(w, "a-broken", await jpeg(400, 300), { createdAt: Date.now() });
    w.media.loseBytes("a-broken");
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
    await seed(w, "a-broken", await jpeg(400, 300), { createdAt: 1 });
    w.media.loseBytes("a-broken");
    await seed(w, "b-good", await jpeg(400, 300));
    expectOk(await w.images.sync());
    await whenIdle(w.images);
    expect((await rowsOf(w, "b-good")).map((r) => r.state)).toEqual(["done"]);
    const job = expectOk(await w.db.findMany<Job>(JOBS, {})).items[0]!;
    expect(job.state).toBe("done");
    expect(job.failed).toBe(1);
  });
});

describe("images/default: a variant write that fails", () => {
  it("counts an attempt each time its copy cannot be written, so the size gives up after maxAttempts", async () => {
    const w = await world({ maxAttempts: 2 });
    await seed(w, "m1", await jpeg(1000, 600));
    expectOk(await w.images.plan(["m1"]));
    const put = w.blobs.put.bind(w.blobs);
    w.blobs.put = async (k, d, o) => (k.startsWith("site/") ? err(failure("TRANSIENT", "down")) : put(k, d, o));
    expectErr(await w.images.generate("m1"), "TRANSIENT");
    expect((await rowsOf(w, "m1")).map((r) => [r.state, r.attempts])).toEqual([["error", 1]]);
    expectErr(await w.images.generate("m1"), "TRANSIENT");
    expect((await rowsOf(w, "m1")).map((r) => [r.state, r.attempts])).toEqual([["failed", 2]]);
    expect(expectOk(await w.images.generate("m1")).map((r) => r.state)).toEqual(["failed"]);
    expect(w.blobs.blobs.get("site/media/m1/variants/thumb.webp")?.contentType).toBe("image/jpeg");
  });

  it("an inline render whose copy cannot be written leaves the size to the background loop, which places and renders it", async () => {
    const w = await world();
    await seed(w, "m1", await jpeg(1000, 600));
    const put = w.blobs.put.bind(w.blobs);
    let failing = true;
    w.blobs.put = async (k, d, o) => (failing && k.startsWith("site/") ? err(failure("TRANSIENT", "down")) : put(k, d, o));
    expectErr(await w.images.generate("m1"), "TRANSIENT");
    expect((await rowsOf(w, "m1")).map((r) => r.state)).toEqual(["planned"]);
    failing = false;
    await whenIdle(w.images);
    expect((await rowsOf(w, "m1")).map((r) => r.state)).toEqual(["done"]);
    expect(w.blobs.blobs.get("site/media/m1/variants/thumb.webp")?.contentType).toBe("image/webp");
  });
});

describe("images/default: reading media through media@1", () => {
  function callsFrom(w: World): () => Array<{ method: string; args: readonly unknown[] }> {
    const mark = w.media.calls.length;
    return () => w.media.calls.slice(mark);
  }

  it("checks the size set against the stored rows with counts, without reading every media item", async () => {
    const w = await world();
    for (const id of ["a", "b", "c"]) {
      await seed(w, id, await jpeg(400, 300));
      expectOk(await w.images.plan([id]));
    }
    const since = callsFrom(w);
    const reopened = await w.open({ sizes: [{ ...THUMB, width: 300 }] });
    expectOk(await reopened.register([{ name: "extra", width: 100 }]));
    expect(since().length).toBeGreaterThan(0);
    for (const call of since()) expect(call).toEqual({ method: "count", args: [ELIGIBLE] });
    await whenIdle(reopened);
    expect((await rowsOf(w, "a")).map((r) => [r.size, r.width]).sort()).toEqual([["extra", 100], ["thumb", 300]]);
  });

  it("the repair pass reads only the media items created in the last 24 hours and leaves older ones to the nightly sync", async () => {
    const day = 24 * 60 * 60 * 1000;
    const w = await world({}, fixedRenderer, () => 10 * day);
    await seed(w, "old", await jpeg(400, 300), { createdAt: 8 * day });
    await seed(w, "fresh", await jpeg(400, 300), { createdAt: 10 * day - 1000 });
    const since = callsFrom(w);
    expectOk(await w.images.resume());
    const scans = since().filter((call) => call.method === "scan");
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) expect(scan.args[0]).toEqual({ ...ELIGIBLE, createdSince: 9 * day });
    expect(await rowsOf(w, "old")).toEqual([]);
    expect((await rowsOf(w, "fresh")).map((r) => r.state)).toEqual(["done"]);
  });
});

describe("images/default: images.syncPublic touches only <id>/variants/<file>", () => {
  it("leaves a key with a deeper id path, and a depth-1 file, alone", async () => {
    const w = await world();
    await seed(w, "m1", await jpeg(400, 300));
    expectOk(await w.images.plan(["m1"]));
    for (const key of ["site/media/x/y/variants/z.webp", "site/media/m1/variants/deep/z.webp", "site/media/m1/photo.jpg", "site/media/stray.webp"]) {
      expectOk(await w.blobs.put(key, new Uint8Array([1]), { contentType: "image/webp" }));
    }
    const synced = expectOk(await w.images.syncPublic());
    expect(synced.removed).toBe(0);
    for (const key of ["site/media/x/y/variants/z.webp", "site/media/m1/variants/deep/z.webp", "site/media/m1/photo.jpg", "site/media/stray.webp"]) expect(w.blobs.blobs.has(key)).toBe(true);
  });
});

describe("images/default: images.syncPublic racing a render", () => {
  it("a copy it writes from content read before another process's render finished ends with the render", async () => {
    const w = await world();
    const other = await w.open();
    await seed(w, "m1", await jpeg(1000, 600));
    expectOk(await w.images.plan(["m1"]));
    w.blobs.blobs.delete("site/media/m1/variants/thumb.webp");
    const put = w.blobs.put.bind(w.blobs);
    let armed = true;
    w.blobs.put = async (key, data, options) => {
      if (armed && key === "site/media/m1/variants/thumb.webp") {
        armed = false;
        expectOk(await other.generate("m1"));
      }
      return put(key, data, options);
    };
    expectOk(await w.images.syncPublic());
    await whenIdle(w.images);
    expect((await rowsOf(w, "m1")).map((r) => r.state)).toEqual(["done"]);
    expect(w.blobs.blobs.get("site/media/m1/variants/thumb.webp")?.data).toEqual(new Uint8Array([9, 9, 5]));
  });
});

describe("images/default: a content type with parameters", () => {
  it("an SVG sent with a charset gets no variant rows", async () => {
    const w = await world();
    await seed(w, "m1", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), { contentType: "image/svg+xml; charset=utf-8" });
    expectOk(await w.images.plan(["m1"]));
    expectOk(await w.images.generate("m1"));
    expect(await rowsOf(w, "m1")).toEqual([]);
  });
});

describe("images/default: images.remove in the same process", () => {
  it("stops a render of the item after its current size instead of rendering every size first", async () => {
    let renders = 0;
    const g = gate();
    const gated: Renderer = async (d, s, p) => {
      renders += 1;
      g.arrive();
      await g.wait;
      return fixedRenderer(d, s, p);
    };
    const w = await world({ sizes: [THUMB, HERO, { ...THUMB, name: "small", width: 640 }] }, gated);
    await seed(w, "m1", await jpeg(1000, 600));
    expectOk(await w.images.plan(["m1"]));
    const generating = w.images.generate("m1");
    await g.reached;
    await deleteMedia(w, "m1");
    const removing = w.images.remove("m1");
    g.open();
    await generating;
    expectOk(await removing);
    expect(renders).toBe(1);
    expect(copiesOf(w, "m1")).toEqual([]);
    expect(await rowsOf(w, "m1")).toEqual([]);
  });
});

describe("images/default: rows written before 6.0.0", () => {
  it("setup refuses variant or retired rows without a slot, naming the collection", async () => {
    const w = await world();
    expectOk(await w.db.createOne(VARIANTS, { mediaId: "old", size: "thumb", spec: "x", width: 1, height: 1, format: "webp", key: "media-variants/old/thumb.webp", bytes: 0, state: "done", error: null, attempts: 0, updatedAt: 1 }));
    await expect(w.open()).rejects.toThrow(/1 row\(s\) in "images_variants" have no slot/);
    expectOk(await w.db.deleteMany(VARIANTS, {}));
    expectOk(await w.db.createOne(RETIRED, { mediaId: "old", file: "thumb.webp", retiredAt: 1 }));
    await expect(w.open()).rejects.toThrow(/1 row\(s\) in "images_retired" have no slot/);
  });
});
