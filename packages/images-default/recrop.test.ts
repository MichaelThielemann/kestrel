import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import type { Document, Filter, FindOptions, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import type { MediaFiles } from "@michaelthielemann/kestrel-contracts/media";
import { createFakeMedia, type FakeMedia } from "@michaelthielemann/kestrel-contracts/testing/fakeMedia";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Introspection, Manifest } from "@michaelthielemann/kestrel";
import { failure } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { DEFAULT_RENDER_TIMEOUT_MS, FRAMING, HIDDEN, ITEMS, JOBS, RETIRED, VARIANTS, createImages, whenIdle, type Config, type FramingRow, type Images, type ItemLease, type Job, type Variant } from "./impl.ts";
import type { PixelCrop } from "./framing.ts";
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

function recordingEvents(): Events & { emitted: Array<{ name: string; ids: unknown }> } {
  const emitted: Array<{ name: string; ids: unknown }> = [];
  return {
    emitted,
    async emit(name, data) { emitted.push({ name, ids: data.ids }); },
    on() { return () => {}; },
  };
}

const quiet: Logger = { step() {}, info() {}, error() {} };
const THUMB: Size = { name: "thumb", width: 64, fit: "inside", format: "webp", quality: 82 };
const WIDE_SMALL: Size = { name: "wide-small", width: 160, height: 90, fit: "cover", format: "webp", quality: 82 };
const WIDE_LARGE: Size = { name: "wide-large", width: 320, height: 180, fit: "cover", format: "webp", quality: 82 };
const SQUARE: Size = { name: "square", width: 100, height: 100, fit: "cover", format: "webp", quality: 82 };
const SIZES = [THUMB, WIDE_SMALL, WIDE_LARGE, SQUARE];
const CONFIG: Config = { prefix: "media-variants/", publicPath: "/media", publicCopy: { prefix: "site/" }, chunk: 5, staleAfterMs: 60000, maxAttempts: 2, renderTimeoutMs: DEFAULT_RENDER_TIMEOUT_MS, sizes: SIZES };
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

interface Render {
  size: string;
  crop: PixelCrop | null;
}

interface World {
  blobs: MemoryBlobs;
  db: FakePersistence;
  media: FakeMedia;
  events: Events & { emitted: Array<{ name: string; ids: unknown }> };
  renders: Render[];
  open(sizes?: Size[], render?: Renderer, deps?: { db?: Persistence; blobs?: Blobstore; media?: MediaFiles; now?: () => number }): Promise<Images>;
}

function bytesFor(size: string, crop: PixelCrop | null, round: number): Uint8Array {
  return new TextEncoder().encode(`${size}|${crop === null ? "centre" : `${crop.left},${crop.top},${crop.width},${crop.height}`}|${round}`);
}

async function world(): Promise<World> {
  const blobs = memoryBlobs();
  const db = createFakePersistence();
  const media = createFakeMedia();
  const events = recordingEvents();
  const renders: Render[] = [];
  const original = new Uint8Array(await sharp({ create: { width: 1000, height: 600, channels: 3, background: "#557799" } }).jpeg().toBuffer());
  media.add({ id: "m1", contentType: "image/jpeg", data: original, filename: "photo.jpg", createdAt: 1000 });
  const recording: Renderer = async (_data, size, planned) => {
    const crop = planned.crop ?? null;
    renders.push({ size: size.name, crop });
    return { data: bytesFor(size.name, crop, renders.length), width: planned.width, height: planned.height, format: planned.format, ext: planned.format, contentType: `image/${planned.format}` };
  };
  return {
    blobs,
    db,
    media,
    events,
    renders,
    open: (sizes = SIZES, render = recording, deps = {}) => createImages({ ...CONFIG, sizes }, { blobs: deps.blobs ?? blobs, db: deps.db ?? db, media: deps.media ?? media, logger: quiet, render, events }, deps.now ?? (() => 1000)),
  };
}

async function rowsBySize(w: World, mediaId = "m1"): Promise<Map<string, Variant>> {
  const rows = expectOk(await w.db.findMany<Variant>(VARIANTS, { mediaId })).items;
  return new Map(rows.map((row) => [row.size, row]));
}

function copyOf(w: World, file: string): string | null {
  const blob = w.blobs.blobs.get(`site/media/m1/variants/${file}`);
  return blob === undefined ? null : new TextDecoder().decode(blob.data);
}

function text(data: Uint8Array | undefined): string {
  return new TextDecoder().decode(data);
}

function gate(): { wait: Promise<void>; open(): void; reached: Promise<void>; arrive(): void } {
  let open: () => void = () => {};
  let arrive: () => void = () => {};
  const wait = new Promise<void>((resolve) => { open = resolve; });
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  return { wait, open, reached, arrive };
}

function heldRenders(held: number): { render: Renderer; gates: Array<ReturnType<typeof gate>> } {
  const gates = Array.from({ length: held }, () => gate());
  let calls = 0;
  const render: Renderer = async (d, s, p) => {
    const g = gates[calls++];
    if (g !== undefined) {
      g.arrive();
      await g.wait;
    }
    return { data: bytesFor(s.name, p.crop ?? null, calls), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
  };
  return { render, gates };
}

const CORNER_FOCUS = { focus: { x: 0, y: 0, w: 0.1, h: 0.1 } };
const SQUARE_PATH = "/media/m1/variants/square.webp";
const VERSIONED_SQUARE = /^\/media\/m1\/variants\/square\.webp\?v=[0-9a-z]+$/;

function expectSquarePath(images: Images, square: Variant): void {
  const path = images.publicPath("m1", square);
  if ((square.renders ?? 0) >= 2) expect(path).toMatch(VERSIONED_SQUARE);
  else expect(path).toBe(SQUARE_PATH);
}

describe("images/default images.setFraming", () => {
  it("stores the framing and answers it with the id", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.generate("m1"));
    const framed = expectOk(await images.setFraming("m1", { focus: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, crops: { "1:1": { x: 0.2, y: 0, w: 0.6, h: 1 } } }));
    expect(framed).toEqual({ id: "m1", framing: { focus: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, crops: { "1:1": { x: 0.2, y: 0, w: 0.6, h: 1 } } } });
    const views = expectOk(await images.framingsOf(["m1", "unknown"]));
    expect(views.get("m1")).toMatchObject({ focus: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, crops: { "1:1": { x: 0.2, y: 0, w: 0.6, h: 1 } } });
    expect(views.get("m1")).toMatchObject({ width: 1000, height: 600 });
    expect(views.get("unknown")).toEqual({ focus: null, crops: {}, width: null, height: null, ratios: [{ key: "16:9", sizes: ["wide-small", "wide-large"], manual: false, fits: true, crop: null }, { key: "1:1", sizes: ["square"], manual: false, fits: true, crop: null }] });
    await images.close();
  });

  it("gives an unframed item the oriented dimensions of its original once it is planned, swapped for an EXIF-rotated photo", async () => {
    const w = await world();
    const stored = new Uint8Array(await sharp({ create: { width: 1000, height: 600, channels: 3, background: "#557799" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer());
    w.media.add({ id: "upright", contentType: "image/jpeg", data: stored, filename: "upright.jpg", createdAt: 1000 });
    const images = await w.open();
    expect(expectOk(await images.framingsOf(["m1"])).get("m1")).toMatchObject({ width: null, height: null });
    expectOk(await images.plan(["m1", "upright"]));
    const views = expectOk(await images.framingsOf(["m1", "upright"]));
    expect(views.get("m1")).toMatchObject({ focus: null, width: 1000, height: 600 });
    expect(views.get("upright")).toMatchObject({ focus: null, width: 600, height: 1000 });
    await images.close();
  });

  it("replaces the whole framing, and an empty framing removes the stored one", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.setFraming("m1", { focus: { x: 0.1, y: 0.2, w: 0, h: 0 }, crops: { "1:1": { x: 0.2, y: 0, w: 0.6, h: 1 } } }));
    expectOk(await images.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } }));
    expect(expectOk(await images.framingsOf(["m1"])).get("m1")).toMatchObject({ focus: null, crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } });
    expectOk(await images.setFraming("m1", {}));
    expect(expectOk(await w.db.count(FRAMING, { mediaId: "m1" }))).toBe(0);
    await images.close();
  });

  it("answers VALIDATION for a malformed framing and for a crop whose pixel ratio does not match its key", async () => {
    const w = await world();
    const images = await w.open();
    expectErr(await images.setFraming("m1", { focus: { x: 2, y: 0, w: 0, h: 0 } }), "VALIDATION");
    expectErr(await images.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 1, h: 1 } } }), "VALIDATION");
    expectErr(await images.setFraming("m1", { size: "x" }), "VALIDATION");
    expect(expectOk(await w.db.count(FRAMING, {}))).toBe(0);
    await images.close();
  });

  it("answers NOT_FOUND for an unknown id, an item without variants and a hidden item", async () => {
    const w = await world();
    w.media.add({ id: "anim", contentType: "image/gif", data: new Uint8Array([71, 73, 70]), filename: "a.gif", createdAt: 1000 });
    const images = await w.open();
    expectOk(await images.generate("m1"));
    expectErr(await images.setFraming("missing", CORNER_FOCUS), "NOT_FOUND");
    expectErr(await images.setFraming("anim", CORNER_FOCUS), "NOT_FOUND");
    expectOk(await images.hide(["m1"]));
    expectErr(await images.setFraming("m1", CORNER_FOCUS), "NOT_FOUND");
    expect(expectOk(await w.db.count(FRAMING, {}))).toBe(0);
    await images.close();
  });
});

describe("images/default focus changes", () => {
  it("raises one images.variantsChanged when the focus changes, also with inside sizes only, and none for an unchanged one", async () => {
    const w = await world();
    const images = await w.open([THUMB]);
    expectOk(await images.generate("m1"));
    w.events.emitted.length = 0;

    expectOk(await images.setFraming("m1", CORNER_FOCUS));
    expect(w.events.emitted).toEqual([{ name: "images.variantsChanged", ids: ["m1"] }]);
    expectOk(await images.setFraming("m1", CORNER_FOCUS));
    expectOk(await images.setFraming("m1", { ...CORNER_FOCUS, crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } }));
    expect(w.events.emitted).toHaveLength(1);
    expectOk(await images.setFraming("m1", { focus: { x: 0.5, y: 0, w: 0.1, h: 0.1 } }));
    expectOk(await images.setFraming("m1", {}));
    expect(w.events.emitted).toHaveLength(3);
    expect(w.renders.map((r) => r.size)).toEqual(["thumb"]);
    await images.close();
  });
});

describe("images/default re-cropping at the same path", () => {
  it("keeps the path and the old variant until the render is done, then switches ?v= and raises one images.variantsChanged", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.generate("m1"));
    const before = await rowsBySize(w);
    expect([...before.values()].every((row) => row.state === "done")).toBe(true);
    expect(images.publicPath("m1", before.get("wide-small")!)).toBe("/media/m1/variants/wide-small.webp");
    const oldBytes = copyOf(w, "wide-small.webp");
    w.renders.length = 0;
    w.events.emitted.length = 0;

    expectOk(await images.setFraming("m1", CORNER_FOCUS));
    const planned = await rowsBySize(w);
    expect(["wide-small", "wide-large", "square"].map((name) => planned.get(name)!.state)).toEqual(["pending", "pending", "pending"]);
    expect(planned.get("thumb")).toEqual(before.get("thumb"));
    expect(planned.get("wide-small")!.key).toBe(before.get("wide-small")!.key);
    expect(images.publicPath("m1", planned.get("wide-small")!)).toBe("/media/m1/variants/wide-small.webp");
    expect(copyOf(w, "wide-small.webp")).toBe(oldBytes);
    expect(expectOk(await images.read("m1", "wide-small.webp"))).toMatchObject({ variant: "done", fallback: false });
    expect(text(expectOk(await images.read("m1", "wide-small.webp"))?.data)).toBe(oldBytes);
    expect(w.events.emitted).toEqual([{ name: "images.variantsChanged", ids: ["m1"] }]);
    w.events.emitted.length = 0;
    expect(expectOk(await images.variantCounts(["m1"])).get("m1")).toEqual({ done: 1, pending: 3, error: 0, failed: 0 });

    expectOk(await images.generate("m1"));
    expect(w.renders.map((r) => r.size).sort()).toEqual(["square", "wide-large", "wide-small"]);
    const wideCrop = w.renders.find((r) => r.size === "wide-small")!.crop!;
    expect(wideCrop).toEqual({ left: 0, top: 0, width: 1000, height: 563 });
    const after = await rowsBySize(w);
    expect(after.get("wide-small")).toMatchObject({ state: "done", crop: "0,0,1000,563", renderedCrop: "0,0,1000,563" });
    expect(after.get("square")).toMatchObject({ state: "done", crop: "0,0,600,600", renderedCrop: "0,0,600,600" });
    expect(images.publicPath("m1", after.get("wide-small")!)).toMatch(/^\/media\/m1\/variants\/wide-small\.webp\?v=[0-9a-z]+$/);
    expect(copyOf(w, "wide-small.webp")).not.toBe(oldBytes);
    expect(copyOf(w, "wide-small.webp")).toContain("0,0,1000,563");
    expect(w.events.emitted).toEqual([{ name: "images.variantsChanged", ids: ["m1"] }]);
    expect(expectOk(await images.variantCounts(["m1"])).get("m1")).toEqual({ done: 4, pending: 0, error: 0, failed: 0 });
    await images.close();
  });

  it("re-renders only the cover sizes of a ratio whose crop changed, and never an inside size", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.generate("m1"));
    const before = await rowsBySize(w);
    w.renders.length = 0;

    expectOk(await images.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } }));
    expectOk(await images.generate("m1"));
    expect(w.renders).toEqual([{ size: "square", crop: { left: 0, top: 0, width: 600, height: 600 } }]);
    const after = await rowsBySize(w);
    for (const name of ["thumb", "wide-small", "wide-large"]) expect(after.get(name)).toEqual(before.get(name));
    await images.close();
  });

  it("framing an item back to the centre re-renders without a crop under a ?v= of its own", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.setFraming("m1", CORNER_FOCUS));
    expectOk(await images.generate("m1"));
    expect(images.publicPath("m1", (await rowsBySize(w)).get("square")!)).toBe(SQUARE_PATH);
    w.renders.length = 0;

    expectOk(await images.setFraming("m1", { focus: { x: 0.5, y: 0.5, w: 0, h: 0 } }));
    expectOk(await images.generate("m1"));
    expect(w.renders.map((r) => r.crop)).toEqual([null, null, null]);
    const square = (await rowsBySize(w)).get("square")!;
    expect(square).toMatchObject({ state: "done", crop: "", renderedCrop: "" });
    expect(images.publicPath("m1", square)).toMatch(VERSIONED_SQUARE);
    await images.close();
  });

  it("gives a cover size registered after the focus was set the focus's crop", async () => {
    const w = await world();
    const images = await w.open([THUMB]);
    expectOk(await images.generate("m1"));
    expectOk(await images.setFraming("m1", CORNER_FOCUS));
    expect(w.renders.map((r) => r.size)).toEqual(["thumb"]);

    const grown = await w.open([THUMB, SQUARE]);
    expectOk(await grown.plan(["m1"]));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ crop: "0,0,600,600", renderedCrop: "", width: 100, height: 100 });
    expectOk(await grown.generate("m1"));
    expect(w.renders.at(-1)).toEqual({ size: "square", crop: { left: 0, top: 0, width: 600, height: 600 } });
    await images.close();
    await grown.close();
  });

  it("plans a smaller cover variant when the crop is smaller than the size", async () => {
    const w = await world();
    const images = await w.open([{ name: "big-square", width: 800, height: 800, fit: "cover", format: "webp", quality: 82 }]);
    expectOk(await images.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 0.3, h: 0.5 } } }));
    expect((await rowsBySize(w)).get("big-square")).toMatchObject({ crop: "0,0,300,300", width: 300, height: 300 });
    await images.close();
  });

  it("treats variant rows without crop fields as centred and leaves them alone", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.generate("m1"));
    expectOk(await w.db.updateMany<Variant>(VARIANTS, { mediaId: "m1" }, { crop: null, renderedCrop: null }));
    const before = await rowsBySize(w);
    w.renders.length = 0;
    expectOk(await images.plan(["m1"]));
    expectOk(await images.generate("m1"));
    expect(w.renders).toEqual([]);
    expect(await rowsBySize(w)).toEqual(before);
    expect(images.publicPath("m1", before.get("square")!)).toBe("/media/m1/variants/square.webp");
    expect(expectOk(await images.variantCounts(["m1"])).get("m1")).toEqual({ done: 4, pending: 0, error: 0, failed: 0 });
    await images.close();
  });

  it("counts a done variant whose crop is not the one it was rendered with as pending", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.generate("m1"));
    expectOk(await w.db.updateMany<Variant>(VARIANTS, { mediaId: "m1", size: "square" }, { crop: "0,0,600,600" }));
    expect(expectOk(await images.variantCounts(["m1"])).get("m1")).toEqual({ done: 3, pending: 1, error: 0, failed: 0 });
    await images.close();
  });

  it("raises images.variantsChanged when the first render of a framed size is done", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.setFraming("m1", CORNER_FOCUS));
    w.events.emitted.length = 0;
    expectOk(await images.generate("m1"));
    expect(w.events.emitted).toEqual([{ name: "images.variantsChanged", ids: ["m1"] }]);
    await images.close();
  });

  it("raises no images.variantsChanged when a render of an unframed item is done", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.plan(["m1"]));
    w.events.emitted.length = 0;
    expectOk(await images.generate("m1"));
    expect(w.events.emitted).toEqual([]);
    await images.close();
  });
});

describe("images/default ?v= of a re-rendered variant", () => {
  const A = { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } };
  const B = { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } };

  async function squarePath(w: World, images: Images): Promise<string> {
    return images.publicPath("m1", (await rowsBySize(w)).get("square")!);
  }

  it("keeps the plain path after the first render, with and without a crop", async () => {
    const unframed = await world();
    const plain = await unframed.open();
    expectOk(await plain.generate("m1"));
    for (const row of (await rowsBySize(unframed)).values()) expect(plain.publicPath("m1", row)).toBe(`/media/m1/variants/${row.size}.webp`);
    await plain.close();

    const framed = await world();
    const images = await framed.open([SQUARE]);
    expectOk(await images.setFraming("m1", A));
    expectOk(await images.generate("m1"));
    expect((await rowsBySize(framed)).get("square")).toMatchObject({ state: "done", renderedCrop: "0,0,600,600" });
    expect(await squarePath(framed, images)).toBe(SQUARE_PATH);
    await images.close();
  });

  it("gives a crop set back to an earlier one a path it never had", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    const paths: string[] = [];
    for (const framing of [A, B, A]) {
      expectOk(await images.setFraming("m1", framing));
      expectOk(await images.generate("m1"));
      paths.push(await squarePath(w, images));
    }
    expect(paths[0]).toBe(SQUARE_PATH);
    expect(paths[1]).toMatch(VERSIONED_SQUARE);
    expect(paths[2]).toMatch(VERSIONED_SQUARE);
    expect(new Set(paths).size).toBe(3);
    await images.close();
  });

  it("keeps a query after a reset to automatic, different from the query before it", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.generate("m1"));
    expect(await squarePath(w, images)).toBe(SQUARE_PATH);
    expectOk(await images.setFraming("m1", A));
    expectOk(await images.generate("m1"));
    const cropped = await squarePath(w, images);
    expect(cropped).toMatch(VERSIONED_SQUARE);

    expectOk(await images.setFraming("m1", {}));
    expectOk(await images.generate("m1"));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "", renderedCrop: "" });
    const reset = await squarePath(w, images);
    expect(reset).toMatch(VERSIONED_SQUARE);
    expect(reset).not.toBe(cropped);
    await images.close();
  });

  it("never hands out the same path twice over many re-renders", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.generate("m1"));
    const paths = [await squarePath(w, images)];
    for (const framing of [A, B, {}, A, {}, B, A]) {
      expectOk(await images.setFraming("m1", framing));
      expectOk(await images.generate("m1"));
      paths.push(await squarePath(w, images));
    }
    expect(new Set(paths).size).toBe(paths.length);
    await images.close();
  });

  it("changes the query only once the new render is at the path", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.setFraming("m1", A));
    expectOk(await images.generate("m1"));
    expectOk(await images.setFraming("m1", B));
    expectOk(await images.generate("m1"));
    const before = await squarePath(w, images);

    expectOk(await images.setFraming("m1", A));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "pending", renderedCrop: "400,0,600,600" });
    expect(await squarePath(w, images)).toBe(before);
    expect(copyOf(w, "square.webp")).toContain("400,0,600,600");
    expectOk(await images.generate("m1"));
    expect(copyOf(w, "square.webp")).toContain("|0,0,600,600|");
    expect(await squarePath(w, images)).not.toBe(before);
    await images.close();
  });

  it("raises images.variantsChanged once a re-render with an unchanged crop changed the path", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.generate("m1"));
    const before = await squarePath(w, images);
    expectOk(await w.db.updateMany<Variant>(VARIANTS, { mediaId: "m1" }, { state: "pending" }));
    w.events.emitted.length = 0;
    expectOk(await images.generate("m1"));
    expect(await squarePath(w, images)).toMatch(VERSIONED_SQUARE);
    expect(await squarePath(w, images)).not.toBe(before);
    expect(w.events.emitted).toEqual([{ name: "images.variantsChanged", ids: ["m1"] }]);
    await images.close();
  });

  it("changes the query when a sync job or images.resume renders the re-crop in the background", async () => {
    const w = await world();
    const planner = await w.open([SQUARE]);
    expectOk(await planner.generate("m1"));
    expectOk(await planner.setFraming("m1", A));
    expect(await squarePath(w, planner)).toBe(SQUARE_PATH);
    expectOk(await planner.sync());
    await whenIdle(planner);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", renderedCrop: "0,0,600,600" });
    const synced = await squarePath(w, planner);
    expect(synced).toMatch(VERSIONED_SQUARE);

    expectOk(await planner.setFraming("m1", B));
    const later = await w.open([SQUARE], undefined, { now: () => 1001 + CONFIG.staleAfterMs });
    expectOk(await later.resume());
    await whenIdle(later);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", renderedCrop: "400,0,600,600" });
    const resumed = await squarePath(w, later);
    expect(resumed).toMatch(VERSIONED_SQUARE);
    expect(resumed).not.toBe(synced);
    for (const images of [planner, later]) await images.close();
  });

  it("gives a size registered again after a prune a query on its first render, since its path held bytes before", async () => {
    const w = await world();
    const images = await w.open([THUMB, SQUARE]);
    expectOk(await images.generate("m1"));
    expect(await squarePath(w, images)).toBe(SQUARE_PATH);
    const narrowed = await w.open([THUMB]);
    expectOk(await narrowed.prune(["square"]));
    expect((await rowsBySize(w)).has("square")).toBe(false);

    const grown = await w.open([THUMB, SQUARE]);
    expectOk(await grown.plan(["m1"]));
    expectOk(await grown.generate("m1"));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done" });
    expect(await squarePath(w, grown)).toMatch(VERSIONED_SQUARE);
    for (const open of [images, narrowed, grown]) await open.close();
  });

  it("gives the first render after a format change of a variant that rendered before a query at its new path", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.generate("m1"));
    expect(await squarePath(w, images)).toBe(SQUARE_PATH);
    const changed = await w.open([{ ...SQUARE, format: "original" }]);
    expectOk(await changed.plan(["m1"]));
    expectOk(await changed.generate("m1"));
    const row = (await rowsBySize(w)).get("square")!;
    expect(row).toMatchObject({ state: "done", renders: 2 });
    expect(changed.publicPath("m1", row)).toMatch(/^\/media\/m1\/variants\/square\.jpg\?v=[0-9a-z]+$/);
    for (const open of [images, changed]) await open.close();
  });

  it("gives a format change back to the row's own earlier path a query that path never had, with no render in between", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    const earlier: string[] = [];
    for (const framing of [A, B]) {
      expectOk(await images.setFraming("m1", framing));
      expectOk(await images.generate("m1"));
      earlier.push(await squarePath(w, images));
    }
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", format: "webp", renders: 2 });

    const failing: Renderer = async () => {
      throw new Error("premature end of input");
    };
    const original = await w.open([{ ...SQUARE, format: "original" }], failing);
    expectOk(await original.plan(["m1"]));
    await original.generate("m1");
    expect((await rowsBySize(w)).get("square")).toMatchObject({ format: "jpeg", renders: 2 });

    const back = await w.open([SQUARE]);
    expectOk(await back.plan(["m1"]));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ format: "webp" });
    const pending = await squarePath(w, back);
    expectOk(await back.generate("m1"));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", format: "webp" });
    const final = await squarePath(w, back);

    expect(pending).toMatch(VERSIONED_SQUARE);
    expect(final).toMatch(VERSIONED_SQUARE);
    expect(earlier).not.toContain(pending);
    expect(earlier).not.toContain(final);
    expect(final).not.toBe(pending);
    for (const open of [images, original, back]) await open.close();
  });

  it("gives a format change back to a path a pruned size rendered before a query on its first render there", async () => {
    const w = await world();
    const images = await w.open([THUMB, SQUARE]);
    expectOk(await images.generate("m1"));
    expect(await squarePath(w, images)).toBe(SQUARE_PATH);
    const narrowed = await w.open([THUMB]);
    expectOk(await narrowed.prune(["square"]));

    const original = await w.open([THUMB, { ...SQUARE, format: "original" }]);
    expectOk(await original.plan(["m1"]));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ format: "jpeg", renders: 0 });
    const back = await w.open([THUMB, { ...SQUARE, width: 140, height: 140 }]);
    expectOk(await back.plan(["m1"]));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ format: "webp", state: "pending" });
    expectOk(await back.generate("m1"));

    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", format: "webp" });
    expect(await squarePath(w, back)).toMatch(VERSIONED_SQUARE);
    for (const open of [images, narrowed, original, back]) await open.close();
  });

  it("exports each variant under its plain path with the bytes of its last render", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    for (const framing of [A, B, A]) {
      expectOk(await images.setFraming("m1", framing));
      expectOk(await images.generate("m1"));
    }
    expect(await squarePath(w, images)).toMatch(VERSIONED_SQUARE);
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "images-export-"));
    try {
      expect(expectOk(await images.exportTo(dir)).written).toBe(1);
      const files = await readdir(dir, { recursive: true });
      expect(files).toEqual(["photo.jpg.square.webp"]);
      expect(await readFile(join(dir, "photo.jpg.square.webp"), "utf8")).toContain("|0,0,600,600|");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await images.close();
  });
});

describe("images/default re-cropping while a render runs", () => {
  it("never commits done with a crop another process changed meanwhile", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.generate("m1"));
    const { render, gates } = heldRenders(2);
    const renderer = await w.open([SQUARE], render);
    const other = await w.open([SQUARE]);

    expectOk(await other.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } }));
    const generating = renderer.generate("m1");
    await gates[0]!.reached;
    expectOk(await other.setFraming("m1", { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } }));
    gates[0]!.open();
    await gates[1]!.reached;

    const square = (await rowsBySize(w)).get("square")!;
    expect(square).toMatchObject({ state: "pending", crop: "400,0,600,600", renderedCrop: "" });
    expect(first.publicPath("m1", square)).toBe("/media/m1/variants/square.webp");
    expect(copyOf(w, "square.webp")).toContain("|centre|");
    expect(text(expectOk(await first.read("m1", "square.webp"))?.data)).toContain("|centre|");

    gates[1]!.open();
    expectOk(await generating);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
    expect(copyOf(w, "square.webp")).toContain("400,0,600,600");
    expect(w.renders.length).toBe(1);
    for (const images of [first, renderer, other]) await images.close();
  });

  it("a request to render while a render of the item runs renders again after it, so a crop changed after the running render passed that size is rendered", async () => {
    const w = await world();
    const twoRatios = [SQUARE, WIDE_SMALL];
    const first = await w.open(twoRatios);
    expectOk(await first.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } }));
    const { render, gates } = heldRenders(2);
    const renderer = await w.open(twoRatios, render);
    const other = await w.open(twoRatios);

    const generating = renderer.generate("m1");
    await gates[0]!.reached;
    gates[0]!.open();
    await gates[1]!.reached;
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", renderedCrop: "0,0,600,600" });
    expectOk(await other.setFraming("m1", { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } }));
    const requested = renderer.generate("m1");
    gates[1]!.open();
    expectOk(await generating);
    expectOk(await requested);

    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
    expect(copyOf(w, "square.webp")).toContain("400,0,600,600");
    for (const images of [first, renderer, other]) await images.close();
  });

  it("a render that loses its commit to a newer crop's render leaves the newer crop's bytes at the path, whichever bytes reached the path last", async () => {
    for (const lateWrite of ["variant", "public copy"] as const) {
      const w = await world();
      const first = await w.open([SQUARE]);
      expectOk(await first.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } }));
      const g = gate();
      let armed = true;
      const writes: Blobstore = {
        ...w.blobs,
        put: async (key, data, options) => {
          const held = armed && key.startsWith(lateWrite === "variant" ? "media-variants/" : "site/");
          if (held) armed = false;
          if (held && lateWrite === "variant") {
            g.arrive();
            await g.wait;
          }
          const put = await w.blobs.put(key, data, options);
          if (held && lateWrite === "public copy") {
            g.arrive();
            await g.wait;
          }
          return put;
        },
      };
      const slow = await w.open([SQUARE], undefined, { blobs: writes });
      const other = await w.open([SQUARE]);

      const generating = slow.generate("m1");
      await g.reached;
      expectOk(await other.setFraming("m1", { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } }));
      expectOk(await other.generate("m1"));
      g.open();
      expectOk(await generating);
      await whenIdle(slow);

      const square = (await rowsBySize(w)).get("square")!;
      expect(square, lateWrite).toMatchObject({ state: "done", crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
      expectSquarePath(other, square);
      expect(text(w.blobs.blobs.get(square.key)?.data), lateWrite).toContain("400,0,600,600");
      expect(copyOf(w, "square.webp"), lateWrite).toContain("400,0,600,600");
      expect(text(expectOk(await other.read("m1", "square.webp"))?.data)).toContain("400,0,600,600");
      expect(expectOk(await other.variantCounts(["m1"])).get("m1")).toEqual({ done: 1, pending: 0, error: 0, failed: 0 });
      for (const images of [first, slow, other]) await images.close();
    }
  });

  it("a first render whose crop changes while another process places the row keeps its bytes in the public copy and names their crop in ?v=", async () => {
    const w = await world();
    const other = await w.open([SQUARE]);
    expectOk(await w.db.createOne(FRAMING, { mediaId: "m1", focus: null, crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } }, width: 1000, height: 600, updatedAt: 1 }));
    const g = gate();
    let armed = true;
    const writes: Blobstore = {
      ...w.blobs,
      put: async (key, data, options) => {
        const put = await w.blobs.put(key, data, options);
        if (armed && key.startsWith("site/")) {
          armed = false;
          g.arrive();
          await g.wait;
        }
        return put;
      },
    };
    const { render, gates } = heldRenders(2);
    gates[0]!.open();
    const p = await w.open([SQUARE], render, { blobs: writes });

    const pRun = p.generate("m1");
    await g.reached;
    expectOk(await other.setFraming("m1", { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } }));
    expect(copyOf(w, "square.webp")).toContain("0,0,600,600");
    g.open();
    await gates[1]!.reached;

    const square = (await rowsBySize(w)).get("square")!;
    expect(square).toMatchObject({ state: "pending", crop: "400,0,600,600", renderedCrop: "0,0,600,600" });
    expectSquarePath(other, square);
    expect(copyOf(w, "square.webp")).toContain("0,0,600,600");

    gates[1]!.open();
    expectOk(await pRun);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", renderedCrop: "400,0,600,600" });
    expect(copyOf(w, "square.webp")).toContain("400,0,600,600");
    for (const images of [p, other]) await images.close();
  });

  it("close() starts no render after it returns, also not the one a framing saved during a render asks for, which images.resume renders later", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } }));
    const { render, gates } = heldRenders(2);
    const slow = await w.open([SQUARE], render);

    const generating = slow.generate("m1");
    await gates[0]!.reached;
    expectOk(await first.setFraming("m1", { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } }));
    const closing = slow.close();
    gates[0]!.open();
    gates[1]!.open();
    expectOk(await generating);
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "pending", crop: "0,0,600,600" });
    expect(copyOf(w, "square.webp")).not.toContain("400,0,600,600");
    expect(w.renders).toEqual([]);

    const later = await w.open([SQUARE], undefined, { now: () => 1001 + CONFIG.staleAfterMs });
    expectOk(await later.resume());
    await whenIdle(later);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
    for (const images of [first, later]) await images.close();
  });

  it("a render that finishes after a newer crop was committed leaves the newer crop's bytes at the path", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.generate("m1"));
    const g = gate();
    const gated: Renderer = async (d, s, p) => {
      g.arrive();
      await g.wait;
      return { data: bytesFor(s.name, p.crop ?? null, 0), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
    };
    const slow = await w.open([SQUARE], gated);
    const other = await w.open([SQUARE]);

    expectOk(await other.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } }));
    const generating = slow.generate("m1");
    await g.reached;
    expectOk(await other.setFraming("m1", { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } }));
    expectOk(await other.generate("m1"));
    g.open();
    expectOk(await generating);

    const square = (await rowsBySize(w)).get("square")!;
    expect(square).toMatchObject({ state: "done", crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
    expectSquarePath(other, square);
    expect(text(w.blobs.blobs.get(square.key)?.data)).toContain("400,0,600,600");
    expect(copyOf(w, "square.webp")).toContain("400,0,600,600");
    expect(text(expectOk(await other.read("m1", "square.webp"))?.data)).toContain("400,0,600,600");
    for (const images of [first, slow, other]) await images.close();
  });

  it("a render whose crop was replaced and set back meanwhile writes nothing, and the render after it leaves that crop's bytes at the path under a new ?v=", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    const kept = { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } };
    expectOk(await first.setFraming("m1", kept));
    expectOk(await first.generate("m1"));
    const before = (await rowsBySize(w)).get("square")!;
    const path = first.publicPath("m1", before);
    const g = gate();
    const gated: Renderer = async (d, s, p) => {
      g.arrive();
      await g.wait;
      return { data: bytesFor(s.name, p.crop ?? null, 0), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
    };
    const slow = await w.open([SQUARE], gated);
    const other = await w.open([SQUARE]);

    expectOk(await other.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } }));
    const generating = slow.generate("m1");
    await g.reached;
    expectOk(await other.setFraming("m1", kept));
    g.open();
    expectOk(await generating);

    const square = (await rowsBySize(w)).get("square")!;
    expect(square).toMatchObject({ crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
    expect(other.publicPath("m1", square)).toMatch(VERSIONED_SQUARE);
    expect(other.publicPath("m1", square)).not.toBe(path);
    expect(text(w.blobs.blobs.get(square.key)?.data)).toContain("400,0,600,600");
    expect(copyOf(w, "square.webp")).toContain("400,0,600,600");
    for (const images of [first, slow, other]) await images.close();
  });

  it("a render whose crop changes after it wrote the path records that crop as rendered, so ?v= names the bytes at the path", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    const kept = { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } };
    expectOk(await first.setFraming("m1", kept));
    expectOk(await first.generate("m1"));
    const g = gate();
    const writes: Blobstore = {
      ...w.blobs,
      put: async (key, data, options) => {
        if (key.startsWith("media-variants/")) {
          g.arrive();
          await g.wait;
        }
        return w.blobs.put(key, data, options);
      },
    };
    const { render, gates } = heldRenders(2);
    gates[0]!.open();
    const slow = await w.open([SQUARE], render, { blobs: writes });
    const other = await w.open([SQUARE]);

    expectOk(await other.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } }));
    w.events.emitted.length = 0;
    const generating = slow.generate("m1");
    await g.reached;
    expectOk(await other.setFraming("m1", kept));
    g.open();
    await gates[1]!.reached;

    const square = (await rowsBySize(w)).get("square")!;
    expect(square).toMatchObject({ state: "pending", crop: "400,0,600,600", renderedCrop: "0,0,600,600" });
    expectSquarePath(other, square);
    expect(text(w.blobs.blobs.get(square.key)?.data)).toContain("0,0,600,600");
    expect(w.events.emitted).toEqual([{ name: "images.variantsChanged", ids: ["m1"] }]);

    gates[1]!.open();
    expectOk(await generating);
    const settled = (await rowsBySize(w)).get("square")!;
    expect(settled).toMatchObject({ state: "done", crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
    expect(copyOf(w, "square.webp")).toContain("400,0,600,600");
    expect(w.events.emitted).toHaveLength(2);
    for (const images of [first, slow, other]) await images.close();
  });

  it("re-planning with a framing another process replaced meanwhile leaves the rows on the stored framing", async () => {
    const w = await world();
    const g = gate();
    let framingReads = 0;
    let armed = false;
    const reads: Persistence = {
      ...w.db,
      findOne: async <T extends Document>(collection: string, filter: Filter) => {
        const found = await w.db.findOne<T>(collection, filter);
        if (armed && collection === FRAMING && ++framingReads === 3) {
          g.arrive();
          await g.wait;
        }
        return found;
      },
    };
    const slow = await w.open([SQUARE], undefined, { db: reads });
    const other = await w.open([SQUARE]);
    expectOk(await other.generate("m1"));

    armed = true;
    const framing = slow.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } });
    await g.reached;
    expectOk(await other.setFraming("m1", { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } }));
    g.open();
    expectOk(await framing);
    await whenIdle(slow);

    expect(expectOk(await other.framingsOf(["m1"])).get("m1")!.ratios[0]!.crop).toEqual({ left: 400, top: 0, width: 600, height: 600 });
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
    expect(copyOf(w, "square.webp")).toContain("400,0,600,600");
    for (const images of [slow, other]) await images.close();
  });

  it("re-plans and renders in the background when the re-planning of images.setFraming fails after the framing was stored", async () => {
    const w = await world();
    let failing = false;
    const writes: Persistence = {
      ...w.db,
      updateMany: async (collection, filter, patch) => {
        if (failing && collection === VARIANTS && "crop" in patch) {
          failing = false;
          return err(failure("TRANSIENT", "busy"));
        }
        return w.db.updateMany(collection, filter, patch);
      },
    };
    const images = await w.open([SQUARE], undefined, { db: writes });
    expectOk(await images.generate("m1"));

    failing = true;
    expectErr(await images.setFraming("m1", { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } }), "TRANSIENT");
    await whenIdle(images);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
    expect(copyOf(w, "square.webp")).toContain("400,0,600,600");
    await images.close();
  });

  it("images.resume renders a re-cropped row left pending longer than staleAfterMs, and leaves a recently re-cropped one to the render under way", async () => {
    const w = await world();
    const planner = await w.open([SQUARE]);
    expectOk(await planner.generate("m1"));
    expectOk(await planner.setFraming("m1", { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } }));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "pending", crop: "400,0,600,600", renderedCrop: "" });

    const soon = await w.open([SQUARE], undefined, { now: () => 1000 + CONFIG.staleAfterMs });
    expectOk(await soon.resume());
    await whenIdle(soon);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "pending", renderedCrop: "" });

    const later = await w.open([SQUARE], undefined, { now: () => 1001 + CONFIG.staleAfterMs });
    expectOk(await later.resume());
    await whenIdle(later);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
    expect(copyOf(w, "square.webp")).toContain("400,0,600,600");
    for (const images of [planner, soon, later]) await images.close();
  });

  it("images.resume leaves a pending row that was never rendered to the render queued for it, however long it waits", async () => {
    const w = await world();
    const planner = await w.open([SQUARE]);
    expectOk(await planner.plan(["m1"]));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "pending", bytes: 0 });

    const later = await w.open([SQUARE], undefined, { now: () => 1001 + 10 * CONFIG.staleAfterMs });
    expectOk(await later.resume());
    await whenIdle(later);
    expect(w.renders).toEqual([]);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "pending", bytes: 0 });
    for (const images of [planner, later]) await images.close();
  });

  it("images.resume reaches a stale re-cropped row past rows of sizes no longer declared and rows it cannot render", async () => {
    const w = await world();
    const planner = await w.open([SQUARE]);
    expectOk(await planner.generate("m1"));
    expectOk(await planner.setFraming("m1", { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } }));
    const undeclared = Array.from({ length: 200 }, (_, i) => ({ mediaId: `gone${i}`, size: "old", slot: `gone${i}/old`, spec: "old", width: 10, height: 10, format: "webp", key: `media-variants/gone${i}/old.webp`, bytes: 10, error: null, attempts: 0, updatedAt: 0, crop: "", renderedCrop: "", originalWidth: 0, originalHeight: 0 }));
    expectOk(await w.db.createMany<Variant>(VARIANTS, [...undeclared.map((row) => ({ ...row, state: "pending" as const })), ...undeclared.map((row) => ({ ...row, slot: `${row.slot}-planned`, state: "planned" as const }))]));
    const original = expectOk(await w.media.load("m1"))!.data;
    for (let i = 0; i < 200; i += 1) {
      w.media.add({ id: `lost${i}`, contentType: "image/jpeg", data: original, filename: "lost.jpg", createdAt: 1000 });
      expectOk(await planner.generate(`lost${i}`));
      w.media.loseBytes(`lost${i}`);
    }
    expectOk(await w.db.updateMany<Variant>(VARIANTS, { mediaId: { like: "lost%" } }, { state: "pending", updatedAt: 0 }));

    const later = await w.open([SQUARE], undefined, { now: () => 1001 + CONFIG.staleAfterMs });
    for (let pass = 0; pass < 2; pass += 1) {
      expectOk(await later.resume());
      await whenIdle(later);
    }
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
    for (const images of [planner, later]) await images.close();
  });

  it("answers NOT_FOUND and stores nothing when the item is hidden while images.setFraming waits for a render of it", async () => {
    const w = await world();
    const g = gate();
    const gated: Renderer = async (d, s, p) => {
      g.arrive();
      await g.wait;
      return { data: bytesFor(s.name, p.crop ?? null, 0), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
    };
    const images = await w.open([SQUARE], gated);
    expectOk(await images.plan(["m1"]));
    const generating = images.generate("m1");
    await g.reached;
    const framing = images.setFraming("m1", CORNER_FOCUS);
    const hiding = images.hide(["m1"]);
    while (!expectOk(await images.hidden(["m1"])).has("m1")) await new Promise((resolve) => setTimeout(resolve, 1));
    g.open();
    expectOk(await generating);
    expectErr(await framing, "NOT_FOUND");
    expectOk(await hiding);
    expect(expectOk(await w.db.count(FRAMING, {}))).toBe(0);
    await images.close();
  });

  it("in one process, images.setFraming waits for a render of the item and re-plans after it", async () => {
    const w = await world();
    const g = gate();
    const gated: Renderer = async (d, s, p) => {
      g.arrive();
      await g.wait;
      return { data: bytesFor(s.name, p.crop ?? null, 0), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
    };
    const images = await w.open([SQUARE], gated);
    expectOk(await images.plan(["m1"]));
    const generating = images.generate("m1");
    await g.reached;
    let framed = false;
    const framing = images.setFraming("m1", CORNER_FOCUS).then((r) => { framed = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(framed).toBe(false);
    g.open();
    expectOk(await generating);
    expectOk(await framing);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "pending", crop: "0,0,600,600", renderedCrop: "" });
    await images.close();
  });
});

describe("images/default framing and the item's lifecycle", () => {
  it("images.remove deletes the framing with the variants", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.setFraming("m1", CORNER_FOCUS));
    w.media.remove("m1");
    expectOk(await images.remove("m1"));
    expect(expectOk(await w.db.count(FRAMING, { mediaId: "m1" }))).toBe(0);
    await images.close();
  });

  it("the sweep of items that are gone deletes their framing and hidden rows together", async () => {
    const w = await world();
    const original = expectOk(await w.media.load("m1"))!.data;
    w.media.add({ id: "m2", contentType: "image/jpeg", data: original, filename: "other.jpg", createdAt: 1000 });
    const images = await w.open();
    for (const id of ["m1", "m2"]) {
      expectOk(await images.generate(id));
      expectOk(await images.setFraming(id, CORNER_FOCUS));
    }
    expectOk(await images.hide(["m1"]));
    await images.close();
    expectOk(await w.db.deleteMany(VARIANTS, {}));
    expectOk(await w.db.deleteMany(HIDDEN, { mediaId: "m2" }));
    w.media.remove("m1");
    w.media.remove("m2");

    const restarted = await w.open();
    restarted.attach(introspection);
    await whenIdle(restarted);
    expect(expectOk(await w.db.count(FRAMING, {}))).toBe(0);
    expect(expectOk(await w.db.count(HIDDEN, {}))).toBe(0);
    await restarted.close();
  });

  it("keeps the framing and crops of a hidden item unchanged, and writes no public copy while it re-renders hidden", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.setFraming("m1", CORNER_FOCUS));
    expectOk(await images.generate("m1"));
    const framed = await rowsBySize(w);
    const view = expectOk(await images.framingsOf(["m1"])).get("m1");

    expectOk(await images.hide(["m1"]));
    expect(copyOf(w, "square.webp")).toBeNull();
    expectOk(await w.db.updateMany<Variant>(VARIANTS, { mediaId: "m1", size: "square" }, { state: "pending" }));
    expectOk(await images.generate("m1"));
    expect(copyOf(w, "square.webp")).toBeNull();
    expectOk(await images.show(["m1"]));

    expect(expectOk(await images.framingsOf(["m1"])).get("m1")).toEqual(view);
    const shown = await rowsBySize(w);
    for (const name of ["wide-small", "wide-large", "square"]) expect(shown.get(name)).toMatchObject({ crop: framed.get(name)!.crop, renderedCrop: framed.get(name)!.renderedCrop, state: "done" });
    expect(copyOf(w, "square.webp")).toContain("0,0,600,600");
    await images.close();
  });
});

const LEFT = { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } };
const RIGHT = { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } };
const LATER = 1001 + 10 * CONFIG.staleAfterMs;

function holdOnce(w: World, prefix: string): { blobs: Blobstore; g: ReturnType<typeof gate> } {
  const g = gate();
  let armed = true;
  return {
    g,
    blobs: {
      ...w.blobs,
      put: async (key, data, options) => {
        if (armed && key.startsWith(prefix)) {
          armed = false;
          g.arrive();
          await g.wait;
        }
        return w.blobs.put(key, data, options);
      },
    },
  };
}

function stopAt(w: World, state: Variant["state"]): { db: Persistence; stopped: ReturnType<typeof gate> } {
  const stopped = gate();
  const stop = async (collection: string, patch: object): Promise<void> => {
    if (collection === VARIANTS && Reflect.get(patch, "state") === state) {
      stopped.arrive();
      await new Promise<never>(() => undefined);
    }
  };
  return {
    stopped,
    db: {
      ...w.db,
      updateMany: async (collection, filter, patch) => {
        await stop(collection, patch);
        return w.db.updateMany(collection, filter, patch);
      },
      updateOne: async <T extends Document>(collection: string, id: string, patch: Partial<Omit<T, "id">>) => {
        await stop(collection, patch);
        return w.db.updateOne<T>(collection, id, patch);
      },
    },
  };
}

async function expectRenderedWith(w: World, images: Images, crop: string): Promise<void> {
  const square = (await rowsBySize(w)).get("square")!;
  expect(square).toMatchObject({ state: "done", crop, renderedCrop: crop });
  expectSquarePath(images, square);
  expect(text(w.blobs.blobs.get(square.key)?.data)).toContain(`|${crop}|`);
  expect(copyOf(w, "square.webp")).toContain(`|${crop}|`);
  expect(text(expectOk(await images.read("m1", "square.webp"))?.data)).toContain(`|${crop}|`);
}

describe("images/default writes of a variant's path", () => {
  it("a render whose crop changes while it holds the path and whose public copy then fails renders the new crop, which ends at the path under its ?v=", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.setFraming("m1", LEFT));
    const g = gate();
    let holdPrivate = true;
    let failCopy = true;
    const writes: Blobstore = {
      ...w.blobs,
      put: async (key, data, options) => {
        if (holdPrivate && key.startsWith("media-variants/")) {
          holdPrivate = false;
          g.arrive();
          await g.wait;
        } else if (failCopy && !holdPrivate && key.startsWith("site/")) {
          failCopy = false;
          return err(failure("TRANSIENT", "copy store unavailable"));
        }
        return w.blobs.put(key, data, options);
      },
    };
    const slow = await w.open([SQUARE], undefined, { blobs: writes });
    const other = await w.open([SQUARE]);

    const generating = slow.generate("m1");
    await g.reached;
    expectOk(await other.setFraming("m1", RIGHT));
    expectOk(await other.generate("m1"));
    g.open();
    expectErr(await generating, "TRANSIENT");
    await whenIdle(slow);
    await whenIdle(other);

    await expectRenderedWith(w, other, "400,0,600,600");
    for (const images of [first, slow, other]) await images.close();
  });

  it("while a render holds the item, another process saves a newer crop and renders nothing; the holder renders the newer crop before it lets go", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.setFraming("m1", LEFT));
    const stale = holdOnce(w, "media-variants/");
    const p = await w.open([SQUARE], undefined, { blobs: stale.blobs });
    const q = await w.open([SQUARE]);

    const pRun = p.generate("m1");
    await stale.g.reached;
    expectOk(await first.setFraming("m1", RIGHT));
    expectOk(await q.generate("m1"));
    const waiting = (await rowsBySize(w)).get("square")!;
    expect(waiting).toMatchObject({ state: "pending", crop: "0,0,600,600", renderedCrop: "" });
    expect(copyOf(w, "square.webp")).not.toContain("400,0,600,600");
    stale.g.open();
    expectOk(await pRun);
    await whenIdle(p);
    await whenIdle(q);

    await expectRenderedWith(w, q, "400,0,600,600");
    for (const images of [first, p, q]) await images.close();
  });

  it("an item left by a stopped process is rendered again by images.resume once its lease has expired, with the crop set meanwhile", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.setFraming("m1", LEFT));
    const held = holdOnce(w, "media-variants/");
    const stopping = stopAt(w, "done");
    const slow = await w.open([SQUARE], undefined, { blobs: held.blobs, db: stopping.db });
    const other = await w.open([SQUARE]);

    void slow.generate("m1");
    await held.g.reached;
    expectOk(await other.setFraming("m1", RIGHT));
    expectOk(await other.generate("m1"));
    held.g.open();
    await stopping.stopped.reached;
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "pending", crop: "0,0,600,600" });

    const soon = await w.open([SQUARE]);
    expectOk(await soon.resume());
    await whenIdle(soon);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "pending" });

    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);
    await expectRenderedWith(w, later, "400,0,600,600");
    for (const images of [first, other, soon, later]) await images.close();
  });

  it("a placement left by a stopped process after it wrote the original is finished by images.resume, and a render meanwhile leaves the item to it", async () => {
    const w = await world();
    const boot = await w.open([SQUARE]);
    expectOk(await w.db.createOne(FRAMING, { mediaId: "m1", focus: null, crops: LEFT.crops, width: 1000, height: 600, updatedAt: 1 }));
    const placing = holdOnce(w, "site/");
    const stopping = stopAt(w, "pending");
    const placer = await w.open([SQUARE], undefined, { blobs: placing.blobs, db: stopping.db });
    const renderer = await w.open([SQUARE]);

    void placer.plan(["m1"]);
    await placing.g.reached;
    expect(expectOk(await renderer.generate("m1")).map((row) => row.state)).toEqual(["planned"]);
    expect(w.renders).toEqual([]);
    placing.g.open();
    await stopping.stopped.reached;
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "planned", renderedCrop: "" });

    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);
    await expectRenderedWith(w, later, "0,0,600,600");
    for (const images of [boot, renderer, later]) await images.close();
  });

  it("a writer that stalls past staleAfterMs while it writes the path has the item rendered again after another process took it over", async () => {
    for (const late of ["variant", "public copy"] as const) {
      const w = await world();
      const first = await w.open([SQUARE]);
      expectOk(await first.setFraming("m1", LEFT));
      const held = holdOnce(w, late === "variant" ? "media-variants/" : "site/");
      const slow = await w.open([SQUARE], undefined, { blobs: held.blobs });
      const generating = slow.generate("m1");
      await held.g.reached;

      const later = await w.open([SQUARE], undefined, { now: () => LATER });
      expectOk(await later.setFraming("m1", RIGHT));
      expectOk(await later.generate("m1"));
      await expectRenderedWith(w, later, "400,0,600,600");
      held.g.open();
      expectOk(await generating);
      await whenIdle(slow);

      await expectRenderedWith(w, later, "400,0,600,600");
      for (const images of [first, slow, later]) await images.close();
    }
  });

  it("a public copy images.show writes while another process changes the crop ends with the new crop's render", async () => {
    const w = await world();
    let calls = 0;
    const sameLength: Renderer = async (_d, s, p) => {
      calls += 1;
      const crop = p.crop ?? null;
      const label = `${s.name}|${crop === null ? "centre" : `${crop.left},${crop.top},${crop.width},${crop.height}`}|${calls}|`;
      return { data: new TextEncoder().encode(label.padEnd(40, "#")), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
    };
    const first = await w.open([SQUARE], sameLength);
    expectOk(await first.setFraming("m1", LEFT));
    expectOk(await first.generate("m1"));
    expectOk(await first.hide(["m1"]));
    const showing = holdOnce(w, "site/");
    const shower = await w.open([SQUARE], sameLength, { blobs: showing.blobs });
    const other = await w.open([SQUARE], sameLength);

    const shown = shower.show(["m1"]);
    await showing.g.reached;
    expectOk(await other.setFraming("m1", RIGHT));
    expectOk(await other.generate("m1"));
    showing.g.open();
    expectOk(await shown);
    await whenIdle(shower);
    await whenIdle(other);

    await expectRenderedWith(w, other, "400,0,600,600");
    expect(expectOk(await other.syncPublic()).written).toBe(0);
    for (const images of [first, shower, other]) await images.close();
  });

  it("images.resume renders a stale re-cropped row ahead of planned rows it cannot place, and moves behind only the rows it tried", async () => {
    const w = await world();
    const planner = await w.open([SQUARE]);
    expectOk(await planner.generate("m1"));
    expectOk(await planner.setFraming("m1", RIGHT));
    const original = expectOk(await w.media.load("m1"))!.data;
    const spec = (await rowsBySize(w)).get("square")!.spec;
    const lost: Array<Omit<Variant, "id">> = [];
    for (let i = 0; i < 200; i += 1) {
      w.media.add({ id: `lost${i}`, contentType: "image/jpeg", data: original, filename: "lost.jpg", createdAt: 1000 });
      w.media.loseBytes(`lost${i}`);
      lost.push({ mediaId: `lost${i}`, size: "square", slot: `lost${i}/square`, spec, width: 10, height: 10, format: "webp", key: `media-variants/lost${i}/square.webp`, bytes: 0, state: "planned", error: null, attempts: 0, updatedAt: 0, crop: "", renderedCrop: "", originalWidth: 0, originalHeight: 0 });
    }
    expectOk(await w.db.createMany<Variant>(VARIANTS, lost));

    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);
    await expectRenderedWith(w, later, "400,0,600,600");
    const left = expectOk(await w.db.findMany<Variant>(VARIANTS, { mediaId: { like: "lost%" } }, { limit: 500 })).items;
    expect(left.filter((row) => row.updatedAt === 0)).toHaveLength(1);
    expect(left.filter((row) => row.updatedAt === LATER)).toHaveLength(199);
    for (const images of [planner, later]) await images.close();
  });

  it("images.resume applies a stored framing whose re-planning failed in a process that was closing", async () => {
    const w = await world();
    let failing = false;
    const busy: Persistence = {
      ...w.db,
      findMany: async <T extends Document>(collection: string, filter: Filter, options?: FindOptions) => {
        if (failing && collection === VARIANTS) {
          failing = false;
          return err(failure("TRANSIENT", "database busy"));
        }
        return w.db.findMany<T>(collection, filter, options);
      },
    };
    const closing = await w.open([SQUARE], undefined, { db: busy });
    expectOk(await closing.generate("m1"));
    await closing.close();
    failing = true;
    expectErr(await closing.setFraming("m1", RIGHT), "TRANSIENT");
    await whenIdle(closing);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "" });

    const soon = await w.open([SQUARE]);
    expectOk(await soon.resume());
    await whenIdle(soon);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "" });

    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);
    await expectRenderedWith(w, later, "400,0,600,600");
    for (const images of [soon, later]) await images.close();
  });

  it("close() while images.resume renders keeps the paused sync job paused, and images.resume answers CONFLICT", async () => {
    const w = await world();
    const planner = await w.open([SQUARE]);
    expectOk(await planner.generate("m1"));
    expectOk(await planner.setFraming("m1", RIGHT));
    await planner.close();
    const job = expectOk(await w.db.createOne<Job>(JOBS, { state: "paused", total: 1, done: 0, failed: 0, cursor: "", startedAt: 2000, updatedAt: 2000, finishedAt: null, error: null }));
    const { render, gates } = heldRenders(1);
    const later = await w.open([SQUARE], render, { now: () => LATER });

    const resuming = later.resume();
    await gates[0]!.reached;
    const closing = later.close();
    gates[0]!.open();
    expectErr(await resuming, "CONFLICT");
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(expectOk(await w.db.findOne<Job>(JOBS, { id: job.id }))).toMatchObject({ state: "paused" });
  });

  it("an inline render that runs out of time leaves its sizes to a placement and render in the background, which finish them", async () => {
    const w = await world();
    let calls = 0;
    const slowFirst: Renderer = async (_d, s, p) => {
      calls += 1;
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 200));
      return { data: bytesFor(s.name, p.crop ?? null, calls), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
    };
    const images = await createImages({ ...CONFIG, sizes: [SQUARE, WIDE_SMALL], renderTimeoutMs: 50 }, { blobs: w.blobs, db: w.db, media: w.media, logger: quiet, render: slowFirst, events: w.events }, () => 1000);
    expectOk(await images.generate("m1"));
    await whenIdle(images);
    expect([...(await rowsBySize(w)).values()].map((row) => row.state)).toEqual(["done", "done"]);
    expect(copyOf(w, "square.webp")).toContain("|centre|");
    await images.close();
  });
});

describe("images/default one writer per item across processes", () => {
  function pauseAt(w: World, at: (collection: string, call: "findOne" | "findMany") => boolean): { db: Persistence; g: ReturnType<typeof gate>; arm(): void } {
    const g = gate();
    let armed = false;
    const pause = async (collection: string, call: "findOne" | "findMany"): Promise<void> => {
      if (armed && at(collection, call)) {
        armed = false;
        g.arrive();
        await g.wait;
      }
    };
    return {
      g,
      arm: () => {
        armed = true;
      },
      db: {
        ...w.db,
        findOne: async <T extends Document>(collection: string, filter: Filter) => {
          const found = await w.db.findOne<T>(collection, filter);
          await pause(collection, "findOne");
          return found;
        },
        findMany: async <T extends Document>(collection: string, filter: Filter, options?: FindOptions) => {
          const found = await w.db.findMany<T>(collection, filter, options);
          await pause(collection, "findMany");
          return found;
        },
      },
    };
  }

  it("a reset saved while another process places an older framing leaves the rows on the centre", async () => {
    const w = await world();
    let framingReads = 0;
    const paused = pauseAt(w, (collection) => collection === FRAMING && ++framingReads === 3);
    const slow = await w.open([SQUARE], undefined, { db: paused.db });
    const other = await w.open([SQUARE]);
    expectOk(await other.generate("m1"));

    paused.arm();
    const framing = slow.setFraming("m1", LEFT);
    await paused.g.reached;
    expectOk(await other.setFraming("m1", {}));
    paused.g.open();
    expectOk(await framing);
    await whenIdle(slow);

    expect(expectOk(await w.db.count(FRAMING, {}))).toBe(0);
    const square = (await rowsBySize(w)).get("square")!;
    expect(square).toMatchObject({ state: "done", crop: "", renderedCrop: "" });
    expectSquarePath(other, square);
    expect(copyOf(w, "square.webp")).toContain("|centre|");
    expect(expectOk(await other.framingsOf(["m1"])).get("m1")!.ratios[0]).toMatchObject({ manual: false, crop: null });
    for (const images of [slow, other]) await images.close();
  });

  it("a placement that read the rows before a framing was saved and the framing after it ends on the stored framing after a save and reset", async () => {
    const w = await world();
    const rowsRead = pauseAt(w, (collection, call) => collection === VARIANTS && call === "findMany");
    const editor = await w.open([SQUARE]);
    expectOk(await editor.plan(["m1"]));
    const framingRead = gate();
    let holdFraming = false;
    const worker = await w.open([SQUARE], undefined, {
      db: {
        ...rowsRead.db,
        findOne: async <T extends Document>(collection: string, filter: Filter) => {
          const found = await rowsRead.db.findOne<T>(collection, filter);
          if (holdFraming && collection === FRAMING) {
            holdFraming = false;
            framingRead.arrive();
            await framingRead.wait;
          }
          return found;
        },
      },
    });

    rowsRead.arm();
    const placing = worker.plan(["m1"]);
    await rowsRead.g.reached;
    expectOk(await editor.setFraming("m1", LEFT));
    holdFraming = true;
    rowsRead.g.open();
    await framingRead.reached;
    expectOk(await editor.setFraming("m1", {}));
    framingRead.open();
    expectOk(await placing);
    await whenIdle(worker);

    expect(expectOk(await w.db.count(FRAMING, {}))).toBe(0);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "", renderedCrop: "" });
    expect(copyOf(w, "square.webp")).toContain("|centre|");
    for (const images of [editor, worker]) await images.close();
  });

  it("a re-crop render whose public copy fails keeps the earlier render at both paths under its ?v=, and images.resume renders it again", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.setFraming("m1", LEFT));
    expectOk(await first.generate("m1"));
    let failing = false;
    const blobs: Blobstore = { ...w.blobs, put: async (key, data, options) => (failing && key.startsWith("site/") ? err(failure("TRANSIENT", "copy store down")) : w.blobs.put(key, data, options)) };
    const other = await w.open([SQUARE], undefined, { blobs });
    expectOk(await other.setFraming("m1", RIGHT));
    failing = true;
    expectErr(await other.generate("m1"), "TRANSIENT");
    await whenIdle(other);

    const square = (await rowsBySize(w)).get("square")!;
    expect(square).toMatchObject({ state: "error", crop: "400,0,600,600", renderedCrop: "0,0,600,600", attempts: 1 });
    expectSquarePath(other, square);
    expect(text(w.blobs.blobs.get(square.key)?.data)).toContain("|0,0,600,600|");
    expect(copyOf(w, "square.webp")).toContain("|0,0,600,600|");
    expect(text(expectOk(await other.read("m1", "square.webp"))?.data)).toContain("|0,0,600,600|");

    failing = false;
    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);
    await expectRenderedWith(w, later, "400,0,600,600");
    for (const images of [first, other, later]) await images.close();
  });

  it("a first render whose public copy fails leaves no render at the private path, so both paths answer the original", async () => {
    const w = await world();
    const blobs: Blobstore = { ...w.blobs, put: async (key, data, options) => (key.startsWith("site/") && w.blobs.blobs.has(key) ? err(failure("TRANSIENT", "copy store down")) : w.blobs.put(key, data, options)) };
    const images = await w.open([SQUARE], undefined, { blobs });
    expectOk(await images.plan(["m1"]));
    expectErr(await images.generate("m1"), "TRANSIENT");
    const square = (await rowsBySize(w)).get("square")!;
    expect(square).toMatchObject({ state: "error", bytes: 0 });
    expect(w.blobs.blobs.has(square.key)).toBe(false);
    expect(expectOk(await images.read("m1", "square.webp"))).toMatchObject({ fallback: true, variant: "original" });
    await images.close();
  });

  it("a public copy images.show writes that stalls past staleAfterMs is written again from the newer render another process left at the path", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.setFraming("m1", LEFT));
    expectOk(await first.generate("m1"));
    const held = holdOnce(w, "site/");
    const copier = await w.open([SQUARE], undefined, { blobs: held.blobs });
    const showing = copier.show(["m1"]);
    await held.g.reached;

    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.setFraming("m1", RIGHT));
    expectOk(await later.generate("m1"));
    await expectRenderedWith(w, later, "400,0,600,600");
    held.g.open();
    expectOk(await showing);
    await whenIdle(copier);

    await expectRenderedWith(w, later, "400,0,600,600");
    for (const images of [first, copier, later]) await images.close();
  });

  it("an upload placed in one process while images.syncPublic runs in another ends rendered", async () => {
    const w = await world();
    const boot = await w.open([SQUARE]);
    await boot.close();
    expectOk(await w.db.createOne<Job>(JOBS, { state: "running", total: 1, done: 0, failed: 0, cursor: "zzz", startedAt: 999, updatedAt: 1000, finishedAt: null, error: null }));
    const placing = holdOnce(w, "site/");
    const upload = await w.open([SQUARE], undefined, { blobs: placing.blobs });
    const admin = await w.open([SQUARE]);

    const planning = upload.plan(["m1"]);
    await placing.g.reached;
    expectOk(await admin.syncPublic());
    placing.g.open();
    expectOk(await planning);
    await whenIdle(upload);
    await whenIdle(admin);

    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", renderedCrop: "" });
    expect(copyOf(w, "square.webp")).toContain("|centre|");
    for (const images of [upload, admin]) await images.close();
  });

  it("images.resume reaches a planned row, a requested item and a new upload in one pass past 200 items it cannot render", async () => {
    const w = await world();
    const planner = await w.open([SQUARE]);
    const original = expectOk(await w.media.load("m1"))!.data;
    for (let i = 0; i < 200; i += 1) {
      w.media.add({ id: `lost${i}`, contentType: "image/jpeg", data: original, filename: "lost.jpg", createdAt: 1000 });
      expectOk(await planner.generate(`lost${i}`));
      w.media.loseBytes(`lost${i}`);
    }
    expectOk(await w.db.updateMany<Variant>(VARIANTS, { mediaId: { like: "lost%" } }, { state: "pending", updatedAt: 0 }));
    expectOk(await planner.generate("m1"));
    expectOk(await w.db.updateMany<Variant>(VARIANTS, { mediaId: "m1" }, { state: "planned", bytes: 0, renderedCrop: "", updatedAt: 0 }));
    w.media.add({ id: "m2", contentType: "image/jpeg", data: original, filename: "framed.jpg", createdAt: 1000 });
    expectOk(await planner.generate("m2"));
    expectOk(await w.db.createOne(FRAMING, { mediaId: "m2", focus: null, crops: RIGHT.crops, width: 1000, height: 600, updatedAt: 0 }));
    expectOk(await w.db.updateMany<ItemLease>(ITEMS, { mediaId: "m2" }, { request: "asked", updatedAt: 0 }));
    w.media.add({ id: "m3", contentType: "image/jpeg", data: original, filename: "new.jpg", createdAt: LATER - 1000 });

    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);
    expect((await rowsBySize(w, "m1")).get("square")).toMatchObject({ state: "done" });
    expect((await rowsBySize(w, "m2")).get("square")).toMatchObject({ state: "done", crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
    expect((await rowsBySize(w, "m3")).get("square")).toMatchObject({ state: "done" });
    for (const images of [planner, later]) await images.close();
  });

  it("an item whose holder stopped before its first render is rendered by a later images.resume when the first repair fails", async () => {
    const w = await world();
    const planner = await w.open([SQUARE]);
    expectOk(await planner.plan(["m1"]));
    expectOk(await w.db.updateMany<ItemLease>(ITEMS, { mediaId: "m1" }, { writer: "stopped/1", writerUntil: 1000 + CONFIG.staleAfterMs }));
    const redelivered = await w.open([SQUARE]);
    expect(expectOk(await redelivered.generate("m1")).map((row) => row.state)).toEqual(["pending"]);

    let failing = true;
    const busy: Persistence = {
      ...w.db,
      findMany: async <T extends Document>(collection: string, filter: Filter, options?: FindOptions) => {
        if (failing && collection === VARIANTS && Reflect.get(filter, "mediaId") === "m1") {
          failing = false;
          return err(failure("TRANSIENT", "database busy"));
        }
        return w.db.findMany<T>(collection, filter, options);
      },
    };
    const first = await w.open([SQUARE], undefined, { db: busy, now: () => LATER });
    expectOk(await first.resume());
    await whenIdle(first);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "pending", bytes: 0 });

    const second = await w.open([SQUARE], undefined, { now: () => LATER + CONFIG.staleAfterMs + 1 });
    expectOk(await second.resume());
    await whenIdle(second);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done" });
    for (const images of [planner, redelivered, first, second]) await images.close();
  });
});

describe("images/default writes of a holder whose item or row changed meanwhile", () => {
  function failingCopyAfterStall(w: World): { blobs: Blobstore; g: ReturnType<typeof gate> } {
    const g = gate();
    let holdPrivate = true;
    let failCopy = false;
    return {
      g,
      blobs: {
        ...w.blobs,
        put: async (key, data, options) => {
          if (holdPrivate && key.startsWith("media-variants/")) {
            holdPrivate = false;
            g.arrive();
            await g.wait;
            failCopy = true;
          } else if (failCopy && key.startsWith("site/")) {
            failCopy = false;
            return err(failure("TRANSIENT", "copy store unavailable"));
          }
          return w.blobs.put(key, data, options);
        },
      },
    };
  }

  it("a holder whose lease ran out while its variant write stalled and whose public copy then fails leaves the newer render at both paths under its ?v=", async () => {
    for (const before of ["never rendered", "rendered"] as const) {
      const w = await world();
      const first = await w.open([SQUARE]);
      if (before === "rendered") expectOk(await first.generate("m1"));
      expectOk(await first.setFraming("m1", LEFT));
      const stalled = failingCopyAfterStall(w);
      const slow = await w.open([SQUARE], undefined, { blobs: stalled.blobs });
      const generating = slow.generate("m1");
      await stalled.g.reached;

      const later = await w.open([SQUARE], undefined, { now: () => LATER });
      expectOk(await later.setFraming("m1", RIGHT));
      expectOk(await later.generate("m1"));
      await expectRenderedWith(w, later, "400,0,600,600");
      stalled.g.open();
      expectOk(await generating);
      await whenIdle(slow);
      await whenIdle(later);

      await expectRenderedWith(w, later, "400,0,600,600");
      for (const images of [first, slow, later]) await images.close();
    }
  });

  it("a render whose public copy lands but whose hidden check after it fails puts the earlier bytes back at both paths", async () => {
    for (const before of ["never rendered", "rendered"] as const) {
      const w = await world();
      const first = await w.open([SQUARE]);
      expectOk(await first.setFraming("m1", LEFT));
      if (before === "rendered") expectOk(await first.generate("m1"));
      let failNextHiddenCheck = false;
      const blobs: Blobstore = {
        ...w.blobs,
        put: async (key, data, options) => {
          const put = await w.blobs.put(key, data, options);
          if (key.startsWith("site/") && text(data).startsWith("square|")) failNextHiddenCheck = true;
          return put;
        },
      };
      const db: Persistence = {
        ...w.db,
        count: async (collection, filter) => {
          if (failNextHiddenCheck && collection === HIDDEN) {
            failNextHiddenCheck = false;
            return err(failure("TRANSIENT", "database busy"));
          }
          return w.db.count(collection, filter);
        },
      };
      const other = await w.open([SQUARE], undefined, { blobs, db });
      if (before === "rendered") expectOk(await other.setFraming("m1", RIGHT));
      expectErr(await other.generate("m1"), "TRANSIENT");

      const square = (await rowsBySize(w)).get("square")!;
      expect(square.state).toBe("error");
      if (before === "rendered") {
        expect(square.renderedCrop).toBe("0,0,600,600");
        expectSquarePath(other, square);
        expect(text(w.blobs.blobs.get(square.key)?.data)).toContain("|0,0,600,600|");
        expect(copyOf(w, "square.webp")).toContain("|0,0,600,600|");
      } else {
        const original = expectOk(await w.media.load("m1"))!.data;
        expect(w.blobs.blobs.has(square.key)).toBe(false);
        expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")?.data).toEqual(original);
        expect(expectOk(await other.read("m1", "square.webp"))).toMatchObject({ fallback: true, variant: "original" });
      }
      for (const images of [first, other]) await images.close();
    }
  });

  it("a render that fails after another process took the item over and rendered it leaves that render done", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.setFraming("m1", LEFT));
    const g = gate();
    let holding = true;
    const failing: Renderer = async () => {
      if (holding) {
        holding = false;
        g.arrive();
        await g.wait;
      }
      throw new Error("premature end of input");
    };
    const slow = await w.open([SQUARE], failing);
    const generating = slow.generate("m1");
    await g.reached;

    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.setFraming("m1", RIGHT));
    expectOk(await later.generate("m1"));
    g.open();
    expectOk(await generating);
    await whenIdle(slow);

    await expectRenderedWith(w, later, "400,0,600,600");
    expect((await rowsBySize(w)).get("square")).toMatchObject({ attempts: 1, error: null });
    for (const images of [first, slow, later]) await images.close();
  });

  it("a framing saved while another save waits for the item is the one stored, also after the waiting save takes the item", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.generate("m1"));
    const renderGate = gate();
    let holdRender = true;
    const held: Renderer = async (_d, s, p) => {
      if (holdRender) {
        holdRender = false;
        renderGate.arrive();
        await renderGate.wait;
      }
      return { data: bytesFor(s.name, p.crop ?? null, 0), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
    };
    const holder = await w.open([SQUARE], held);
    const askGate = gate();
    let pauseAsk = true;
    const asking: Persistence = {
      ...w.db,
      updateMany: async (collection, filter, patch) => {
        if (pauseAsk && collection === ITEMS && Reflect.has(patch, "request") && !Reflect.has(patch, "writer")) {
          pauseAsk = false;
          askGate.arrive();
          await askGate.wait;
        }
        return w.db.updateMany(collection, filter, patch);
      },
    };
    const earlier = await w.open([SQUARE], undefined, { db: asking });
    const latest = await w.open([SQUARE]);

    expectOk(await first.setFraming("m1", { crops: { "1:1": { x: 0.1, y: 0, w: 0.6, h: 1 } } }));
    const rendering = holder.generate("m1");
    await renderGate.reached;
    const saving = earlier.setFraming("m1", RIGHT);
    await askGate.reached;
    expect(expectOk(await latest.setFraming("m1", LEFT)).framing.crops).toEqual(LEFT.crops);
    renderGate.open();
    expectOk(await rendering);
    await whenIdle(holder);
    askGate.open();
    expect(expectOk(await saving).framing.crops).toEqual(RIGHT.crops);
    for (const images of [holder, earlier, latest]) await whenIdle(images);

    expect(expectOk(await w.db.findOne<FramingRow>(FRAMING, { mediaId: "m1" }))?.crops).toEqual(LEFT.crops);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ crop: "0,0,600,600" });
    for (const images of [first, holder, earlier, latest]) await images.close();
  });

  it("images.resume leaves a placement under way to its queued render, in the same and in another process", async () => {
    for (const sameProcess of [false, true]) {
      const w = await world();
      const placing = holdOnce(w, "site/");
      const listed = gate();
      const watching: Persistence = {
        ...w.db,
        findMany: async <T extends Document>(collection: string, filter: Filter, options?: FindOptions) => {
          const found = await w.db.findMany<T>(collection, filter, options);
          if (collection === VARIANTS && Reflect.get(filter, "state") === "planned") listed.arrive();
          return found;
        },
      };
      const planner = await w.open([THUMB, SQUARE], undefined, { blobs: placing.blobs, db: watching });
      const planning = planner.plan(["m1"]);
      await placing.g.reached;
      const cron = sameProcess ? planner : await w.open([THUMB, SQUARE], undefined, { db: watching, now: () => 1005 });
      const resuming = cron.resume();
      await listed.reached;
      placing.g.open();
      expectOk(await planning);
      expectOk(await resuming);
      for (const images of [planner, cron]) await whenIdle(images);

      expect(w.renders).toEqual([]);
      expect([...(await rowsBySize(w)).values()].map((row) => row.state)).toEqual(["pending", "pending"]);
      for (const images of new Set([planner, cron])) await images.close();
    }
  });

  it("a render that finishes after another process pruned its size leaves the original's bytes at the retired path and answers the item", async () => {
    const w = await world();
    const g = gate();
    let holding = true;
    const render: Renderer = async (_d, s, p) => {
      if (holding && s.name === "square") {
        holding = false;
        g.arrive();
        await g.wait;
      }
      return { data: bytesFor(s.name, p.crop ?? null, 0), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
    };
    const declaring = await w.open([THUMB, SQUARE], render);
    const narrowed = await w.open([THUMB]);
    expectOk(await declaring.plan(["m1"]));
    const generating = declaring.generate("m1");
    await g.reached;
    expectOk(await narrowed.prune(["square"]));
    g.open();
    expectOk(await generating);
    await whenIdle(declaring);

    const original = expectOk(await w.media.load("m1"))!.data;
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")?.data).toEqual(original);
    expect([...w.blobs.blobs.keys()].filter((key) => key.startsWith("media-variants/m1/square"))).toEqual([]);
    expect(expectOk(await narrowed.read("m1", "square.webp"))).toMatchObject({ variant: "original" });
    expect([...(await rowsBySize(w)).keys()]).toEqual(["thumb"]);
    for (const images of [declaring, narrowed]) await images.close();
  });

  it("a holder whose lease ran out while it loaded the original re-plans nothing over the framing another process stored meanwhile", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.generate("m1"));
    const g = gate();
    let loads = 0;
    const slowMedia: MediaFiles = {
      ...w.media,
      load: async (id) => {
        if (++loads === 2) {
          g.arrive();
          await g.wait;
        }
        return w.media.load(id);
      },
    };
    const slow = await w.open([SQUARE], undefined, { media: slowMedia });
    const framing = slow.setFraming("m1", { focus: { x: 0, y: 0, w: 0.1, h: 0.1 } });
    await g.reached;

    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.setFraming("m1", { focus: { x: 0.9, y: 0, w: 0.1, h: 0.1 } }));
    g.open();
    expectOk(await framing);
    expectOk(await later.generate("m1"));
    await whenIdle(slow);
    await whenIdle(later);

    expect(expectOk(await w.db.findOne<FramingRow>(FRAMING, { mediaId: "m1" }))?.focus).toMatchObject({ x: 0.9 });
    await expectRenderedWith(w, later, "400,0,600,600");
    for (const images of [first, slow, later]) await images.close();
  });

  it("a format change that stalls past staleAfterMs while it overwrites the old path leaves the row another process placed and rendered", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.generate("m1"));
    const asOriginal: Size = { ...SQUARE, format: "original" };
    const stalled = holdOnce(w, "site/");
    const slow = await w.open([asOriginal], undefined, { blobs: stalled.blobs });
    const planning = slow.plan(["m1"]);
    await stalled.g.reached;

    const later = await w.open([asOriginal], undefined, { now: () => LATER });
    expectOk(await later.plan(["m1"]));
    expectOk(await later.generate("m1"));
    const rendered = (await rowsBySize(w)).get("square")!;
    expect(rendered).toMatchObject({ state: "done", format: "jpeg" });
    stalled.g.open();
    expectOk(await planning);

    expect((await rowsBySize(w)).get("square")).toMatchObject({ id: rendered.id, state: "done", bytes: rendered.bytes });
    await whenIdle(slow);
    await whenIdle(later);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", format: "jpeg" });
    for (const images of [first, slow, later]) await images.close();
  });
});

describe("images/default work a call leaves unfinished", () => {
  function heldRender(): { render: Renderer; g: ReturnType<typeof gate> } {
    const g = gate();
    let holding = true;
    return {
      g,
      render: async (_d, s, p) => {
        if (holding) {
          holding = false;
          g.arrive();
          await g.wait;
        }
        return { data: bytesFor(s.name, p.crop ?? null, 0), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
      },
    };
  }

  function isRequest(collection: string, patch: object): boolean {
    return collection === ITEMS && Reflect.has(patch, "request") && !Reflect.has(patch, "writer");
  }

  function isTake(collection: string, patch: object): boolean {
    return collection === ITEMS && typeof Reflect.get(patch, "writer") === "string" && Reflect.get(patch, "writer") !== "";
  }

  function failingOnce(w: World, matches: (collection: string, patch: object) => boolean): Persistence {
    let failing = true;
    return {
      ...w.db,
      updateMany: async (collection, filter, patch) => {
        if (failing && matches(collection, patch)) {
          failing = false;
          return err(failure("TRANSIENT", "database busy"));
        }
        return w.db.updateMany(collection, filter, patch);
      },
    };
  }

  function timingOut(slow: (size: string, call: number) => boolean): Renderer {
    let calls = 0;
    return async (_d, s, p) => {
      calls += 1;
      if (slow(s.name, calls)) await new Promise((resolve) => setTimeout(resolve, 200));
      return { data: bytesFor(s.name, p.crop ?? null, calls), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
    };
  }

  function openTimingOut(w: World, render: Renderer, now: () => number): Promise<Images> {
    return createImages({ ...CONFIG, sizes: [SQUARE, WIDE_SMALL], renderTimeoutMs: 50 }, { blobs: w.blobs, db: w.db, media: w.media, logger: quiet, render, events: w.events }, now);
  }

  it("a framing stored while another process renders the item is placed and rendered when the request to the holder cannot be written", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.generate("m1"));
    expectOk(await first.setFraming("m1", LEFT));
    const held = heldRender();
    const holder = await w.open([SQUARE], held.render);
    const saver = await w.open([SQUARE], undefined, { db: failingOnce(w, isRequest) });

    const rendering = holder.generate("m1");
    await held.g.reached;
    expectErr(await saver.setFraming("m1", RIGHT), "TRANSIENT");
    held.g.open();
    expectOk(await rendering);
    for (const images of [saver, holder, saver]) await whenIdle(images);

    expect(expectOk(await w.db.findOne<FramingRow>(FRAMING, { mediaId: "m1" }))?.crops).toEqual(RIGHT.crops);
    await expectRenderedWith(w, holder, "400,0,600,600");
    for (const images of [first, holder, saver]) await images.close();
  });

  it("a framing stored after the holder let go is left as a request, which images.resume serves once staleAfterMs has passed", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.generate("m1"));
    expectOk(await first.setFraming("m1", LEFT));
    const held = heldRender();
    const holder = await w.open([SQUARE], held.render);
    const leaseRead = gate();
    let pausing = false;
    const pausedDb: Persistence = {
      ...w.db,
      findOne: async <T extends Document>(collection: string, filter: Filter) => {
        const found = await w.db.findOne<T>(collection, filter);
        if (pausing && collection === ITEMS) {
          pausing = false;
          leaseRead.arrive();
          await leaseRead.wait;
        }
        return found;
      },
    };
    const saver = await w.open([SQUARE], undefined, { db: pausedDb });

    const rendering = holder.generate("m1");
    await held.g.reached;
    const rendersBefore = w.renders.length;
    pausing = true;
    const saving = saver.setFraming("m1", RIGHT);
    await leaseRead.reached;
    held.g.open();
    expectOk(await rendering);
    await whenIdle(holder);
    leaseRead.open();
    expectOk(await saving);
    await whenIdle(saver);

    expect(w.renders.length).toBe(rendersBefore);
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", renderedCrop: "0,0,600,600" });
    const lease = expectOk(await w.db.findOne<ItemLease>(ITEMS, { mediaId: "m1" }));
    expect(lease?.writer).toBe("");
    expect(lease?.request).not.toBe("");
    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);
    await expectRenderedWith(w, later, "400,0,600,600");
    for (const images of [first, holder, saver, later]) await images.close();
  });

  it("a queued render that runs out of time leaves the item to images.resume, which renders the sizes it did not reach once staleAfterMs has passed", async () => {
    const w = await world();
    const render = timingOut((_size, call) => call === 1);
    const images = await openTimingOut(w, render, () => 1000);
    expectOk(await images.plan(["m1"]));
    expectOk(await images.generate("m1"));
    await whenIdle(images);
    expect(await rowsBySize(w)).toMatchObject(new Map([["square", expect.objectContaining({ state: "error" })], ["wide-small", expect.objectContaining({ state: "pending", bytes: 0 })]]));

    const soon = await openTimingOut(w, render, () => 1000 + CONFIG.staleAfterMs);
    expectOk(await soon.resume());
    await whenIdle(soon);
    expect((await rowsBySize(w)).get("wide-small")).toMatchObject({ state: "pending", bytes: 0 });

    const later = await openTimingOut(w, render, () => LATER);
    expectOk(await later.resume());
    await whenIdle(later);
    expect([...(await rowsBySize(w)).values()].map((row) => row.state)).toEqual(["done", "done"]);
    for (const opened of [images, soon, later]) await opened.close();
  });

  it("a size that gives up after a last render that ran out of time no longer holds back the sizes after it", async () => {
    const w = await world();
    const render = timingOut((size) => size === "square");
    const images = await openTimingOut(w, render, () => 1000);
    expectOk(await images.plan(["m1"]));
    expectOk(await images.generate("m1"));
    const later = await openTimingOut(w, render, () => LATER);
    expectOk(await later.resume());
    await whenIdle(later);

    expect(await rowsBySize(w)).toMatchObject(new Map([["square", expect.objectContaining({ state: "failed", attempts: CONFIG.maxAttempts })], ["wide-small", expect.objectContaining({ state: "done" })]]));
    for (const opened of [images, later]) await opened.close();
  });

  it("a re-crop render that fails leaves its row to images.resume, which renders it with the new crop", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.generate("m1"));
    let failing = true;
    const failingOnceRender: Renderer = async (_d, s, p) => {
      if (failing) {
        failing = false;
        throw new Error("premature end of input");
      }
      return { data: bytesFor(s.name, p.crop ?? null, 0), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
    };
    const editor = await w.open([SQUARE], failingOnceRender);
    expectOk(await editor.setFraming("m1", RIGHT));
    expectOk(await editor.generate("m1"));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "error", crop: "400,0,600,600", renderedCrop: "" });

    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);
    await expectRenderedWith(w, later, "400,0,600,600");
    for (const images of [first, editor, later]) await images.close();
  });

  it("a restore whose take of the item fails has its public copies written by images.resume", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.generate("m1"));
    expectOk(await images.hide(["m1"]));
    expect(copyOf(w, "square.webp")).toBeNull();

    const restoring = await w.open([SQUARE], undefined, { db: failingOnce(w, isTake) });
    expectErr(await restoring.show(["m1"]), "TRANSIENT");
    expect(expectOk(await images.hidden(["m1"])).has("m1")).toBe(false);
    expect(copyOf(w, "square.webp")).toBeNull();

    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);
    expect(copyOf(w, "square.webp")).toContain("square|");
    for (const opened of [images, restoring, later]) await opened.close();
  });

  it("a trashed item whose public copies cannot all be removed has them removed by images.resume", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.generate("m1"));
    let failing = true;
    const blobs: Blobstore = {
      ...w.blobs,
      remove: async (key) => {
        if (failing && key.startsWith("site/")) {
          failing = false;
          return err(failure("TRANSIENT", "copy store unavailable"));
        }
        return w.blobs.remove(key);
      },
    };
    const trashing = await w.open([SQUARE], undefined, { blobs });
    expectErr(await trashing.hide(["m1"]), "TRANSIENT");
    expect(copyOf(w, "square.webp")).not.toBeNull();

    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);
    expect(copyOf(w, "square.webp")).toBeNull();
    expect(expectOk(await later.hidden(["m1"])).has("m1")).toBe(true);
    for (const opened of [images, trashing, later]) await opened.close();
  });

  it("images.setFraming answers NOT_FOUND and stores nothing when the item is removed after it was read", async () => {
    const w = await world();
    const loaded = gate();
    let pausing = false;
    const slowMedia: MediaFiles = {
      ...w.media,
      load: async (id) => {
        const found = await w.media.load(id);
        if (pausing) {
          pausing = false;
          loaded.arrive();
          await loaded.wait;
        }
        return found;
      },
    };
    const images = await w.open([SQUARE], undefined, { media: slowMedia });
    expectOk(await images.generate("m1"));
    pausing = true;
    const framing = images.setFraming("m1", RIGHT);
    await loaded.reached;
    w.media.remove("m1");
    expectOk(await images.remove("m1"));
    loaded.open();

    expectErr(await framing, "NOT_FOUND");
    expect(expectOk(await w.db.count(FRAMING, {}))).toBe(0);
    expect(expectOk(await w.db.count(VARIANTS, {}))).toBe(0);
    await images.close();
  });

  it("a render whose size another process pruned meanwhile goes on with the item's other sizes and leaves the pruned one out of its answer", async () => {
    const w = await world();
    const g = gate();
    let holding = true;
    const render: Renderer = async (_d, s, p) => {
      if (holding && s.name === "square") {
        holding = false;
        g.arrive();
        await g.wait;
      }
      return { data: bytesFor(s.name, p.crop ?? null, 0), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
    };
    const declaring = await w.open([SQUARE, THUMB], render);
    const narrowed = await w.open([THUMB]);
    expectOk(await declaring.plan(["m1"]));
    const generating = declaring.generate("m1");
    await g.reached;
    expectOk(await narrowed.prune(["square"]));
    g.open();

    const answered = expectOk(await generating);
    expect(answered.map((row) => [row.size, row.state])).toEqual([["thumb", "done"]]);
    expect([...(await rowsBySize(w)).values()].map((row) => [row.size, row.state])).toEqual([["thumb", "done"]]);
    const original = expectOk(await w.media.load("m1"))!.data;
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")?.data).toEqual(original);
    for (const images of [declaring, narrowed]) await images.close();
  });

  it("a render whose commit misses a row another process re-planned after taking the item over renders the stored crop again", async () => {
    for (const before of ["never rendered", "rendered"] as const) {
      const w = await world();
      const first = await w.open([SQUARE]);
      expectOk(await first.plan(["m1"]));
      if (before === "rendered") expectOk(await first.generate("m1"));
      expectOk(await first.setFraming("m1", LEFT));
      const committing = gate();
      let pausing = true;
      const db: Persistence = {
        ...w.db,
        updateMany: async (collection, filter, patch) => {
          if (pausing && collection === VARIANTS && Reflect.get(patch, "state") === "done") {
            pausing = false;
            committing.arrive();
            await committing.wait;
          }
          return w.db.updateMany(collection, filter, patch);
        },
      };
      const slow = await w.open([SQUARE], undefined, { db });
      const generating = slow.generate("m1");
      await committing.reached;

      const later = await w.open([SQUARE], undefined, { now: () => LATER });
      expectOk(await later.setFraming("m1", RIGHT));
      committing.open();
      expectOk(await generating);
      await whenIdle(slow);

      await expectRenderedWith(w, later, "400,0,600,600");
      for (const images of [first, slow, later]) await images.close();
    }
  });
});

describe("images/default writes racing a lease-free prune or a request left on a free lease", () => {
  function pauseFirstPut(w: World, key: string): { blobs: Blobstore; g: ReturnType<typeof gate>; arm(): void } {
    const g = gate();
    let armed = false;
    return {
      g,
      arm: () => {
        armed = true;
      },
      blobs: {
        ...w.blobs,
        put: async (k, data, options) => {
          if (armed && k === key) {
            armed = false;
            g.arrive();
            await g.wait;
          }
          return w.blobs.put(k, data, options);
        },
      },
    };
  }

  function holdLeaseElsewhere(w: World): Promise<unknown> {
    return w.db.updateMany<ItemLease>(ITEMS, { mediaId: "m1" }, { writer: "elsewhere", writerUntil: 100 * LATER });
  }

  function freeLease(w: World): Promise<unknown> {
    return w.db.updateMany<ItemLease>(ITEMS, { mediaId: "m1" }, { writer: "", writerUntil: 0 });
  }

  it("a public copy of a row that another process prunes while the copy is written ends with the original's bytes at the retired path", async () => {
    for (const writer of ["images.showMany", "images.syncPublic"] as const) {
      const w = await world();
      const paused = pauseFirstPut(w, "site/media/m1/variants/square.webp");
      const declaring = await w.open([SQUARE, THUMB], undefined, { blobs: paused.blobs });
      const narrowed = await w.open([THUMB]);
      expectOk(await declaring.generate("m1"));
      if (writer === "images.showMany") expectOk(await declaring.hide(["m1"]));
      else w.blobs.blobs.delete("site/media/m1/variants/square.webp");

      paused.arm();
      const writing: Promise<{ ok: boolean }> = writer === "images.showMany" ? declaring.show(["m1"]) : declaring.syncPublic();
      await paused.g.reached;
      expectOk(await narrowed.prune(["square"]));
      paused.g.open();
      expect((await writing).ok).toBe(true);
      await whenIdle(declaring);

      const original = expectOk(await w.media.load("m1"))!.data;
      expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")?.data).toEqual(original);
      expect(expectOk(await narrowed.read("m1", "square.webp"))).toMatchObject({ variant: "original" });
      for (const images of [declaring, narrowed]) await images.close();
    }
  });

  it("a re-render whose public copy fails while another process prunes its size leaves no bytes at the private path and the original in the public copy", async () => {
    const w = await world();
    const g = gate();
    let pausePrivate = false;
    let failCopy = false;
    const blobs: Blobstore = {
      ...w.blobs,
      put: async (key, data, options) => {
        if (pausePrivate && key === "media-variants/m1/square.webp") {
          pausePrivate = false;
          failCopy = true;
          g.arrive();
          await g.wait;
        } else if (failCopy && key === "site/media/m1/variants/square.webp") {
          failCopy = false;
          return err(failure("TRANSIENT", "copy store unavailable"));
        }
        return w.blobs.put(key, data, options);
      },
    };
    const declaring = await w.open([SQUARE, THUMB], undefined, { blobs });
    const narrowed = await w.open([THUMB]);
    expectOk(await declaring.generate("m1"));
    expectOk(await declaring.setFraming("m1", LEFT));
    pausePrivate = true;
    const generating = declaring.generate("m1");
    await g.reached;
    expectOk(await narrowed.prune(["square"]));
    g.open();
    expectOk(await generating);
    await whenIdle(declaring);

    const original = expectOk(await w.media.load("m1"))!.data;
    expect(w.blobs.blobs.has("media-variants/m1/square.webp")).toBe(false);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")?.data).toEqual(original);
    for (const images of [declaring, narrowed]) await images.close();
  });

  it("two first framings saved at once, one by the holder of the item and one by another process, both succeed and the rows follow the one stored", async () => {
    const w = await world();
    const creating = gate();
    let pausing = true;
    const db: Persistence = {
      ...w.db,
      createOne: async <T extends Document>(collection: string, doc: Omit<T, "id">) => {
        if (pausing && collection === FRAMING) {
          pausing = false;
          creating.arrive();
          await creating.wait;
        }
        return w.db.createOne<T>(collection, doc);
      },
    };
    const first = await w.open([SQUARE]);
    expectOk(await first.generate("m1"));
    const holder = await w.open([SQUARE], undefined, { db });
    const other = await w.open([SQUARE]);
    const saving = holder.setFraming("m1", LEFT);
    await creating.reached;
    expectOk(await other.setFraming("m1", RIGHT));
    creating.open();
    expectOk(await saving);
    await whenIdle(holder);
    await whenIdle(other);

    const stored = expectOk(await w.db.findOne<FramingRow>(FRAMING, { mediaId: "m1" }));
    expect(stored?.crops).toEqual(LEFT.crops);
    await expectRenderedWith(w, holder, "0,0,600,600");
    for (const images of [first, holder, other]) await images.close();
  });

  it("a trash that finds a request on a free lease serves it, so a framing stored for that request is rendered", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.generate("m1"));
    expectOk(await first.setFraming("m1", LEFT));
    expectOk(await first.generate("m1"));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", renderedCrop: "0,0,600,600" });

    await holdLeaseElsewhere(w);
    const saver = await w.open([SQUARE]);
    expectOk(await saver.setFraming("m1", RIGHT));
    await freeLease(w);
    expect(expectOk(await w.db.findOne<ItemLease>(ITEMS, { mediaId: "m1" }))?.request).not.toBe("");

    const trashing = await w.open([SQUARE]);
    expectOk(await trashing.hide(["m1"]));
    await whenIdle(trashing);

    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
    expect(copyOf(w, "square.webp")).toBeNull();
    for (const images of [first, saver, trashing]) await images.close();
  });

  it("a restore that finds the item held and whose holder lets go before the request is written writes the public copies itself", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.generate("m1"));
    expectOk(await images.hide(["m1"]));
    await holdLeaseElsewhere(w);

    let letGoAfterRead = true;
    const db: Persistence = {
      ...w.db,
      findOne: async <T extends Document>(collection: string, filter: Filter) => {
        const found = await w.db.findOne<T>(collection, filter);
        if (letGoAfterRead && collection === ITEMS) {
          letGoAfterRead = false;
          await freeLease(w);
        }
        return found;
      },
    };
    const restoring = await w.open([SQUARE], undefined, { db });
    expectOk(await restoring.show(["m1"]));

    expect(letGoAfterRead).toBe(false);
    expect(copyOf(w, "square.webp")).toContain("square|");
    expect(expectOk(await w.db.findOne<ItemLease>(ITEMS, { mediaId: "m1" }))?.writer).toBe("");
    for (const opened of [images, restoring]) await opened.close();
  });

  it("images.generate renders the item after one failed read of its lease, and a sync job finishes past it", async () => {
    const w = await world();
    let failing = false;
    const db: Persistence = {
      ...w.db,
      findOne: async <T extends Document>(collection: string, filter: Filter) => {
        if (failing && collection === ITEMS) {
          failing = false;
          return err(failure("TRANSIENT", "database busy"));
        }
        return w.db.findOne<T>(collection, filter);
      },
    };
    const images = await w.open([SQUARE], undefined, { db });
    failing = true;
    expectErr(await images.generate("m1"), "TRANSIENT");

    const rendered = expectOk(await images.generate("m1"));
    expect(rendered.map((row) => [row.size, row.state])).toEqual([["square", "done"]]);
    w.media.add({ id: "m2", contentType: "image/jpeg", data: expectOk(await w.media.load("m1"))!.data, filename: "second.jpg", createdAt: 1000 });
    failing = true;
    expectErr(await images.generate("m2"), "TRANSIENT");
    expectOk(await images.sync());
    await whenIdle(images);

    expect(expectOk(await w.db.findMany<Job>(JOBS, {})).items.map((job) => job.state)).toEqual(["done"]);
    expect((await rowsBySize(w, "m2")).get("square")).toMatchObject({ state: "done" });
    await images.close();
  });

  it("a format change whose holder lost the item before it overwrote the old path writes nothing more", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.generate("m1"));
    const before = (await rowsBySize(w)).get("square")!;
    const db: Persistence = {
      ...w.db,
      createOne: async <T extends Document>(collection: string, doc: Omit<T, "id">) => {
        const created = await w.db.createOne<T>(collection, doc);
        if (collection === RETIRED) await holdLeaseElsewhere(w);
        return created;
      },
    };
    const changing = await w.open([{ ...SQUARE, format: "original" }], undefined, { db });
    expectOk(await changing.plan(["m1"]));
    await whenIdle(changing);

    expect((await rowsBySize(w)).get("square")).toMatchObject({ id: before.id, key: before.key, format: "webp", state: "done" });
    expect(w.blobs.blobs.has(before.key)).toBe(true);
    expect(copyOf(w, "square.webp")).toContain("square|");
    for (const images of [first, changing]) await images.close();
  });

  it("images.resume removes the variants and public copies of an item media@1 no longer has when it serves a request left on it", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.generate("m1"));
    expect(copyOf(w, "square.webp")).not.toBeNull();
    w.media.remove("m1");
    expectOk(await w.db.updateMany<ItemLease>(ITEMS, { mediaId: "m1" }, { request: "left behind", updatedAt: 1000 }));

    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);

    expect(expectOk(await w.db.count(VARIANTS, { mediaId: "m1" }))).toBe(0);
    expect(expectOk(await w.db.count(ITEMS, { mediaId: "m1" }))).toBe(0);
    expect([...w.blobs.blobs.keys()].filter((key) => key.includes("/m1/"))).toEqual([]);
    for (const opened of [images, later]) await opened.close();
  });

  it("images.resume finishes an images.remove that failed partway after media.remove", async () => {
    const w = await world();
    const images = await w.open([THUMB, SQUARE]);
    expectOk(await images.generate("m1"));
    w.media.remove("m1");
    let failing = true;
    const blobs: Blobstore = {
      ...w.blobs,
      remove: async (key) => {
        if (failing && key === "site/media/m1/variants/square.webp") {
          failing = false;
          return err(failure("TRANSIENT", "copy store unavailable"));
        }
        return w.blobs.remove(key);
      },
    };
    const removing = await w.open([THUMB, SQUARE], undefined, { blobs });
    expectErr(await removing.remove("m1"), "TRANSIENT");
    expect(copyOf(w, "square.webp")).not.toBeNull();

    const later = await w.open([THUMB, SQUARE], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);

    expect(expectOk(await w.db.count(VARIANTS, { mediaId: "m1" }))).toBe(0);
    expect(expectOk(await w.db.count(ITEMS, { mediaId: "m1" }))).toBe(0);
    expect([...w.blobs.blobs.keys()].filter((key) => key.includes("/m1/"))).toEqual([]);
    for (const opened of [images, removing, later]) await opened.close();
  });

  it("images.remove still deletes an item's variants when leaving its request fails", async () => {
    const w = await world();
    const images = await w.open([THUMB, SQUARE]);
    expectOk(await images.generate("m1"));
    w.media.remove("m1");
    let failing = true;
    const writes: Persistence = {
      ...w.db,
      updateMany: async (collection, filter, patch) => {
        if (failing && collection === ITEMS && "request" in patch) {
          failing = false;
          return err(failure("TRANSIENT", "busy"));
        }
        return w.db.updateMany(collection, filter, patch);
      },
    };
    const removing = await w.open([THUMB, SQUARE], undefined, { db: writes });
    expectOk(await removing.remove("m1"));

    expect(failing).toBe(false);
    expect(expectOk(await w.db.count(VARIANTS, { mediaId: "m1" }))).toBe(0);
    expect(expectOk(await w.db.count(ITEMS, { mediaId: "m1" }))).toBe(0);
    expect([...w.blobs.blobs.keys()].filter((key) => key.includes("/m1/"))).toEqual([]);
    for (const opened of [images, removing]) await opened.close();
  });

  it("images.remove answers the error of leaving its request when deleting the variants fails too", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.generate("m1"));
    w.media.remove("m1");
    const writes: Persistence = {
      ...w.db,
      updateMany: async (collection, filter, patch) => {
        if (collection === ITEMS && "request" in patch) return err(failure("TRANSIENT", "busy"));
        return w.db.updateMany(collection, filter, patch);
      },
    };
    const blobs: Blobstore = {
      ...w.blobs,
      remove: async (key) => (key === "site/media/m1/variants/square.webp" ? err(failure("TRANSIENT", "copy store unavailable")) : w.blobs.remove(key)),
    };
    const removing = await w.open([SQUARE], undefined, { db: writes, blobs });
    expect(expectErr(await removing.remove("m1"), "TRANSIENT").message).toBe("busy");
    for (const opened of [images, removing]) await opened.close();
  });

  it("images.resume finishes a failed images.remove of an item that never held a lease", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.generate("m1"));
    expectOk(await w.db.deleteMany(ITEMS, { mediaId: "m1" }));
    w.media.remove("m1");
    let failing = true;
    const blobs: Blobstore = {
      ...w.blobs,
      remove: async (key) => {
        if (failing && key === "site/media/m1/variants/square.webp") {
          failing = false;
          return err(failure("TRANSIENT", "copy store unavailable"));
        }
        return w.blobs.remove(key);
      },
    };
    const removing = await w.open([SQUARE], undefined, { blobs });
    expectErr(await removing.remove("m1"), "TRANSIENT");

    const later = await w.open([SQUARE], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);

    expect(expectOk(await w.db.count(VARIANTS, { mediaId: "m1" }))).toBe(0);
    expect(expectOk(await w.db.count(ITEMS, { mediaId: "m1" }))).toBe(0);
    expect([...w.blobs.blobs.keys()].filter((key) => key.includes("/m1/"))).toEqual([]);
    for (const opened of [images, removing, later]) await opened.close();
  });
});

describe("images/default rows a sync job left on an earlier spec", () => {
  const WIDER: Size = { ...SQUARE, width: 120, height: 120 };

  it("images.resume renders an item whose row of a declared size was planned with another spec, once no sync job runs", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.generate("m1"));
    expectOk(await w.db.createOne<Job>(JOBS, { state: "done", total: 1, done: 1, failed: 0, cursor: "m1", startedAt: 1000, updatedAt: 1000, finishedAt: 1000, error: null }));

    const later = await w.open([WIDER], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);

    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", width: 120, height: 120 });
    expect(copyOf(w, "square.webp")).toContain("square|");
    expect(expectOk(await later.variantCounts(["m1"])).get("m1")).toEqual({ done: 1, pending: 0, error: 0, failed: 0 });
    for (const opened of [images, later]) await opened.close();
  });

  it("images.resume leaves such rows to a sync job that is still running", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.generate("m1"));
    expectOk(await w.db.createOne<Job>(JOBS, { state: "running", total: 1, done: 0, failed: 0, cursor: "zzz", startedAt: LATER, updatedAt: LATER, finishedAt: null, error: null }));

    const later = await w.open([WIDER], undefined, { now: () => LATER });
    expectOk(await later.resume());
    await whenIdle(later);

    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", width: 100, height: 100 });
    for (const opened of [images, later]) await opened.close();
  });
});

describe("images/default variantCounts and a stored framing", () => {
  it("counts a done row as pending while the stored framing cuts its size differently, until it renders again", async () => {
    const w = await world();
    const images = await w.open([THUMB, SQUARE]);
    expectOk(await images.generate("m1"));
    expect(expectOk(await images.variantCounts(["m1"])).get("m1")).toEqual({ done: 2, pending: 0, error: 0, failed: 0 });

    expectOk(await w.db.createOne<FramingRow>(FRAMING, { mediaId: "m1", focus: null, crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } }, width: 1000, height: 600, updatedAt: 1000 }));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "", renderedCrop: "" });
    expect(expectOk(await images.variantCounts(["m1"])).get("m1")).toEqual({ done: 1, pending: 1, error: 0, failed: 0 });

    expectOk(await images.plan(["m1"]));
    expectOk(await images.generate("m1"));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", renderedCrop: "0,0,600,600" });
    expect(expectOk(await images.variantCounts(["m1"])).get("m1")).toEqual({ done: 2, pending: 0, error: 0, failed: 0 });

    expectOk(await w.db.deleteMany(FRAMING, { mediaId: "m1" }));
    expect(expectOk(await images.variantCounts(["m1"])).get("m1")).toEqual({ done: 1, pending: 1, error: 0, failed: 0 });
    await images.close();
  });
});
