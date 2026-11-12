import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import { createFakeMedia, type FakeMedia } from "@michaelthielemann/kestrel-contracts/testing/fakeMedia";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Introspection, Manifest } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createContext, type Context, type Step } from "@michaelthielemann/kestrel/context";
import { failure } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import module from "./module.ts";
import { DEFAULT_RENDER_TIMEOUT_MS, HIDDEN, RETIRED, VARIANTS, createImages, whenIdle, type Config, type Hidden, type Images, type Variant } from "./impl.ts";
import type { Renderer } from "./generate.ts";
import type { Size } from "./sizes.ts";

type MemoryBlobs = Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> };

function memoryBlobs(): MemoryBlobs {
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

function recordingEvents(): Events & { emitted: string[] } {
  const emitted: string[] = [];
  return {
    emitted,
    async emit(name) { emitted.push(name); },
    on() { return () => {}; },
  };
}

const quiet: Logger = { step() {}, info() {}, error() {} };
const THUMB: Size = { name: "thumb", width: 32, fit: "inside", format: "webp", quality: 82 };
const HERO: Size = { name: "hero", width: 48, fit: "inside", format: "original", quality: 82 };
const WIDE: Size = { name: "wide", width: 40, fit: "inside", format: "webp", quality: 82 };
const CONFIG: Config = { prefix: "media-variants/", publicPath: "/media", publicCopy: { prefix: "site/" }, chunk: 5, staleAfterMs: 60000, maxAttempts: 2, renderTimeoutMs: DEFAULT_RENDER_TIMEOUT_MS };
const RENDERED = new Uint8Array([7, 7, 7]);
const renderer: Renderer = async (_data, _size, planned) => ({ data: RENDERED, width: planned.width, height: planned.height, format: planned.format, ext: planned.format, contentType: `image/${planned.format}` });
const serving: Manifest = {
  core: { version: "0.0.0" },
  contracts: [],
  modules: [],
  steps: [],
  pipelines: [{ name: "serveImageVariant", steps: [{ spec: "images.serve", name: "images.serve", module: "images/default", description: { summary: "", reads: [], writes: [] } }] }],
  triggers: { http: [], events: [], crons: [] },
  warnings: [],
};
const introspection: Introspection = { describe: () => serving, observe: () => () => {}, health: () => ({ ok: true, restartRequired: false, modules: [] }) };

interface World {
  blobs: MemoryBlobs;
  db: FakePersistence;
  media: FakeMedia;
  events: Events & { emitted: string[] };
  original: Uint8Array;
  open(sizes?: Size[], render?: Renderer): Promise<Images>;
}

async function world(): Promise<World> {
  const blobs = memoryBlobs();
  const db = createFakePersistence();
  const media = createFakeMedia();
  const events = recordingEvents();
  const original = new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: "#557799" } }).jpeg().toBuffer());
  for (const id of ["a", "b"]) media.add({ id, contentType: "image/jpeg", data: original, filename: `${id}.jpg`, createdAt: 1000 });
  return {
    blobs,
    db,
    media,
    events,
    original,
    open: (sizes = [THUMB, HERO], render = renderer) => createImages({ ...CONFIG, sizes }, { blobs, db, media, logger: quiet, render, events }, () => 1000),
  };
}

function copiesOf(blobs: MemoryBlobs, mediaId: string): string[] {
  return [...blobs.blobs.keys()].filter((key) => key.startsWith(`site/media/${mediaId}/variants/`)).sort();
}

async function rendered(w: World, sizes?: Size[]): Promise<Images> {
  const images = await w.open(sizes);
  for (const id of ["a", "b"]) expectOk(await images.generate(id));
  return images;
}

describe("images/default hidden items", () => {
  it("hiding an item removes the public copies of its variants, keeps its rows and private variants, and stops serving them", async () => {
    const w = await world();
    const images = await rendered(w);
    expect(copiesOf(w.blobs, "a")).toEqual(["site/media/a/variants/hero.jpg", "site/media/a/variants/thumb.webp"]);

    expectOk(await images.hide(["a"]));

    expect(copiesOf(w.blobs, "a")).toEqual([]);
    expect(copiesOf(w.blobs, "b")).toHaveLength(2);
    const rows = expectOk(await w.db.findMany<Variant>(VARIANTS, { mediaId: "a" })).items;
    expect(rows.map((row) => row.state)).toEqual(["done", "done"]);
    for (const row of rows) expect(w.blobs.blobs.has(row.key)).toBe(true);
    expect(expectOk(await images.read("a", "thumb.webp"))).toBeNull();
    expect(expectOk(await images.read("b", "thumb.webp"))).toMatchObject({ variant: "done" });
    await images.close();
  });

  it("showing a hidden item writes its public copies again from the stored variants and serves them", async () => {
    const w = await world();
    const images = await rendered(w);
    expectOk(await images.hide(["a"]));

    expectOk(await images.show(["a"]));

    expect(copiesOf(w.blobs, "a")).toEqual(["site/media/a/variants/hero.jpg", "site/media/a/variants/thumb.webp"]);
    expect(w.blobs.blobs.get("site/media/a/variants/thumb.webp")?.data).toEqual(RENDERED);
    expect(expectOk(await images.read("a", "thumb.webp"))).toMatchObject({ variant: "done", fallback: false });
    expect(expectOk(await w.db.count(HIDDEN, {}))).toBe(0);
    await images.close();
  });

  it("hide and show are idempotent and raise no images.variantsChanged", async () => {
    const w = await world();
    const images = await rendered(w);
    w.events.emitted.length = 0;

    expectOk(await images.hide(["a", "a"]));
    expectOk(await images.hide(["a"]));
    expect(expectOk(await w.db.count(HIDDEN, { mediaId: "a" }))).toBe(1);
    expectOk(await images.show(["a"]));
    expectOk(await images.show(["a"]));

    expect(copiesOf(w.blobs, "a")).toHaveLength(2);
    expect(w.events.emitted).toEqual([]);
    await images.close();
  });

  it("a render that ends after the item was hidden writes no public copy", async () => {
    const w = await world();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const slow: Renderer = async (data, size, planned, options) => {
      started();
      await gate;
      return renderer(data, size, planned, options);
    };
    const images = await w.open([THUMB, HERO], slow);
    expectOk(await images.plan(["a"]));
    const generating = images.generate("a");
    await running;
    const hiding = images.hide(["a"]);
    release();
    expectOk(await generating);
    expectOk(await hiding);
    await whenIdle(images);

    expect(copiesOf(w.blobs, "a")).toEqual([]);
    expect(expectOk(await w.db.findMany<Variant>(VARIANTS, { mediaId: "a" })).items.map((row) => row.state)).toEqual(["done", "done"]);
    await images.close();
  });

  it("rendering a hidden item stores its variants without public copies", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.hide(["a"]));

    expectOk(await images.generate("a"));
    await whenIdle(images);

    expect(copiesOf(w.blobs, "a")).toEqual([]);
    expect(expectOk(await w.db.findMany<Variant>(VARIANTS, { mediaId: "a" })).items.map((row) => row.state)).toEqual(["done", "done"]);
    expectOk(await images.show(["a"]));
    expect(copiesOf(w.blobs, "a")).toHaveLength(2);
    await images.close();
  });

  it("placing a hidden item writes no placeholder copy, also for a size registered later", async () => {
    const w = await world();
    const first = await w.open([THUMB]);
    expectOk(await first.hide(["a"]));
    expectOk(await first.plan(["a"]));
    expect(copiesOf(w.blobs, "a")).toEqual([]);
    await first.close();

    const wider = await w.open([THUMB, WIDE]);
    expectOk(await wider.plan(["a"]));
    const rows = expectOk(await w.db.findMany<Variant>(VARIANTS, { mediaId: "a" })).items;
    expect(rows.map((row) => [row.size, row.state]).sort()).toEqual([["thumb", "pending"], ["wide", "pending"]]);
    expect(copiesOf(w.blobs, "a")).toEqual([]);
    expect(copiesOf(w.blobs, "b")).toEqual([]);

    expectOk(await wider.show(["a"]));
    expect(copiesOf(w.blobs, "a")).toEqual(["site/media/a/variants/thumb.webp", "site/media/a/variants/wide.webp"]);
    expect(w.blobs.blobs.get("site/media/a/variants/wide.webp")?.data).toEqual(w.original);
    await wider.close();
  });

  it("retiring a size of a hidden item writes no copy at the retired path until the item is shown", async () => {
    const w = await world();
    const before = await rendered(w);
    expectOk(await before.hide(["a"]));
    await before.close();

    const narrowed = await w.open([THUMB]);
    expectOk(await narrowed.prune(["hero"]));
    expect(expectOk(await w.db.count(RETIRED, { mediaId: "a" }))).toBe(1);
    expect(copiesOf(w.blobs, "a")).toEqual([]);
    expect(w.blobs.blobs.get("site/media/b/variants/hero.jpg")?.data).toEqual(w.original);
    expect(expectOk(await narrowed.read("a", "hero.jpg"))).toBeNull();

    expectOk(await narrowed.show(["a"]));
    expect(w.blobs.blobs.get("site/media/a/variants/hero.jpg")?.data).toEqual(w.original);
    expect(expectOk(await narrowed.read("a", "hero.jpg"))).toMatchObject({ variant: "original", fallback: true });
    await narrowed.close();
  });

  it("images.syncPublic writes no copy of a hidden item and removes one it finds, also at a retired path", async () => {
    const w = await world();
    const before = await rendered(w);
    expectOk(await before.hide(["a"]));
    await before.close();
    const images = await w.open([THUMB]);
    expectOk(await images.prune(["hero"]));
    await w.blobs.put("site/media/a/variants/thumb.webp", RENDERED, { contentType: "image/webp" });
    await w.blobs.put("site/media/a/variants/hero.jpg", w.original, { contentType: "image/jpeg" });

    const synced = expectOk(await images.syncPublic());
    await whenIdle(images);

    expect(synced.removed).toBe(2);
    expect(synced.written).toBe(0);
    expect(copiesOf(w.blobs, "a")).toEqual([]);
    expect(copiesOf(w.blobs, "b")).toEqual(["site/media/b/variants/hero.jpg", "site/media/b/variants/thumb.webp"]);
    expect(expectOk(await w.db.count(VARIANTS, { mediaId: "a" }))).toBe(1);
    await images.close();
  });

  it("export leaves out the variants of a hidden item", async () => {
    const w = await world();
    const images = await rendered(w);
    expectOk(await images.hide(["a"]));
    const dir = await mkdtemp(join(tmpdir(), "images-hidden-export-"));
    try {
      const exported = expectOk(await images.exportTo(dir));
      expect(exported).toEqual({ written: 2, skipped: 2 });
      expect((await readdir(dir)).sort()).toEqual(["b.jpg.hero.jpg", "b.jpg.thumb.webp"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await images.close();
    }
  });

  it("stays hidden across a restart", async () => {
    const w = await world();
    const before = await rendered(w);
    expectOk(await before.hide(["a"]));
    await before.close();

    const restarted = await w.open();
    restarted.attach(introspection);
    await whenIdle(restarted);
    expectOk(await restarted.syncPublic());
    await whenIdle(restarted);

    expect(expectOk(await restarted.read("a", "thumb.webp"))).toBeNull();
    expect(copiesOf(w.blobs, "a")).toEqual([]);
    expect(expectOk(await w.db.count(VARIANTS, { mediaId: "a" }))).toBe(2);
    await restarted.close();
  });

  it("records nothing for an id media@1 does not know and drops the mark with the item's variants", async () => {
    const w = await world();
    const images = await rendered(w);
    expectOk(await images.hide(["ghost"]));
    expect(expectOk(await w.db.count(HIDDEN, {}))).toBe(0);

    expectOk(await images.hide(["a", "b"]));
    expectOk(await images.remove("a"));
    expect(expectOk(await w.db.findMany<Hidden>(HIDDEN, {})).items.map((row) => row.mediaId)).toEqual(["b"]);
    await images.close();

    w.media.remove("b");
    const restarted = await w.open();
    restarted.attach(introspection);
    await whenIdle(restarted);
    expect(expectOk(await w.db.count(HIDDEN, {}))).toBe(0);
    await restarted.close();
  });
});

describe("images/default hideMany, showMany and attach steps", () => {
  interface Steps {
    hideMany: Step;
    showMany: Step;
    attach: Step;
  }

  function ctxWith(result: unknown): Context {
    return { ...createContext({ trigger: { kind: "http", name: "t" } }), result };
  }

  it("hideMany and showMany act on result.ids and pass the result on unchanged", async () => {
    const w = await world();
    const images = await rendered(w);
    const steps = boundaryCast<Steps>(module.steps!(images), "host");
    const result = { ids: ["a"], skipped: [{ id: "x", reason: "not_found" }] };

    const hidden = expectOk(await steps.hideMany(ctxWith(result)));
    expect(hidden.result).toEqual(result);
    expect(copiesOf(w.blobs, "a")).toEqual([]);

    const shown = expectOk(await steps.showMany(ctxWith(result)));
    expect(shown.result).toEqual(result);
    expect(copiesOf(w.blobs, "a")).toHaveLength(2);
    await images.close();
  });

  it("hideMany and showMany throw when the pipeline put no ids in result", async () => {
    const w = await world();
    const images = await w.open();
    const steps = boundaryCast<Steps>(module.steps!(images), "host");
    await expect(steps.hideMany(ctxWith({}))).rejects.toThrow(/no ids in result/);
    await expect(steps.showMany(ctxWith(undefined))).rejects.toThrow(/no ids in result/);
    await images.close();
  });

  it("attach lists no variant paths for a hidden item", async () => {
    const w = await world();
    const images = await rendered(w);
    expectOk(await images.hide(["a"]));
    const steps = boundaryCast<Steps>(module.steps!(images), "host");

    const single = expectOk(await steps.attach(ctxWith({ id: "a", contentType: "image/jpeg" })));
    expect(single.result).toMatchObject({ id: "a", available: false, variants: [], variantCounts: { done: 2 } });

    const list = expectOk(await steps.attach(ctxWith({ items: [{ id: "a", contentType: "image/jpeg" }, { id: "b", contentType: "image/jpeg" }] })));
    const items = boundaryCast<{ items: Array<{ id: string; available: boolean; variants: unknown[] }> }>(list.result, "host").items;
    expect(items.map((item) => [item.id, item.available, item.variants.length])).toEqual([["a", false, 0], ["b", true, 2]]);
    await images.close();
  });
});
