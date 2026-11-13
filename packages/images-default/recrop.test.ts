import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import type { Document, Filter, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakeMedia, type FakeMedia } from "@michaelthielemann/kestrel-contracts/testing/fakeMedia";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Introspection, Manifest } from "@michaelthielemann/kestrel";
import { failure } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { DEFAULT_RENDER_TIMEOUT_MS, FRAMING, HIDDEN, VARIANTS, createImages, whenIdle, type Config, type Images, type Variant } from "./impl.ts";
import { cropToken } from "./framing.ts";
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
  open(sizes?: Size[], render?: Renderer, deps?: { db?: Persistence; blobs?: Blobstore }): Promise<Images>;
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
    open: (sizes = SIZES, render = recording, deps = {}) => createImages({ ...CONFIG, sizes }, { blobs: deps.blobs ?? blobs, db: deps.db ?? db, media, logger: quiet, render, events }, () => 1000),
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

const CORNER_FOCUS = { focus: { x: 0, y: 0, w: 0.1, h: 0.1 } };

describe("images/default images.setFraming", () => {
  it("stores the framing and answers it with the id", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.generate("m1"));
    const framed = expectOk(await images.setFraming("m1", { focus: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, crops: { "1:1": { x: 0.2, y: 0, w: 0.6, h: 1 } } }));
    expect(framed).toEqual({ id: "m1", framing: { focus: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, crops: { "1:1": { x: 0.2, y: 0, w: 0.6, h: 1 } } } });
    const views = expectOk(await images.framingsOf(["m1", "unknown"]));
    expect(views.get("m1")).toMatchObject({ focus: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, crops: { "1:1": { x: 0.2, y: 0, w: 0.6, h: 1 } } });
    expect(views.get("unknown")).toEqual({ focus: null, crops: {}, ratios: [{ key: "16:9", sizes: ["wide-small", "wide-large"], manual: false, fits: true, crop: null }, { key: "1:1", sizes: ["square"], manual: false, fits: true, crop: null }] });
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
    expect(images.publicPath("m1", after.get("wide-small")!)).toBe(`/media/m1/variants/wide-small.webp?v=${cropToken(wideCrop)}`);
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

  it("framing an item back to the centre re-renders without a crop and drops ?v=", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.setFraming("m1", CORNER_FOCUS));
    expectOk(await images.generate("m1"));
    expect(images.publicPath("m1", (await rowsBySize(w)).get("square")!)).toMatch(/\?v=/);
    w.renders.length = 0;

    expectOk(await images.setFraming("m1", { focus: { x: 0.5, y: 0.5, w: 0, h: 0 } }));
    expectOk(await images.generate("m1"));
    expect(w.renders.map((r) => r.crop)).toEqual([null, null, null]);
    const square = (await rowsBySize(w)).get("square")!;
    expect(square).toMatchObject({ state: "done", crop: "", renderedCrop: "" });
    expect(images.publicPath("m1", square)).toBe("/media/m1/variants/square.webp");
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

describe("images/default re-cropping while a render runs", () => {
  it("never commits done with a crop another process changed meanwhile", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.generate("m1"));
    const g = gate();
    const gated: Renderer = async (d, s, p) => {
      g.arrive();
      await g.wait;
      return { data: bytesFor(s.name, p.crop ?? null, 0), width: p.width, height: p.height, format: p.format, ext: p.format, contentType: `image/${p.format}` };
    };
    const renderer = await w.open([SQUARE], gated);
    const other = await w.open([SQUARE]);

    expectOk(await other.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } }));
    const generating = renderer.generate("m1");
    await g.reached;
    expectOk(await other.setFraming("m1", { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } }));
    g.open();
    expectOk(await generating);

    const square = (await rowsBySize(w)).get("square")!;
    expect(square).toMatchObject({ state: "pending", crop: "400,0,600,600", renderedCrop: "" });
    expect(first.publicPath("m1", square)).toBe("/media/m1/variants/square.webp");
    expect(copyOf(w, "square.webp")).toContain("|centre|");
    expect(text(expectOk(await first.read("m1", "square.webp"))?.data)).toContain("|centre|");

    expectOk(await other.generate("m1"));
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "done", crop: "400,0,600,600", renderedCrop: "400,0,600,600" });
    expect(copyOf(w, "square.webp")).toContain("400,0,600,600");
    for (const images of [first, renderer, other]) await images.close();
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
    expect(other.publicPath("m1", square)).toBe(`/media/m1/variants/square.webp?v=${cropToken({ left: 400, top: 0, width: 600, height: 600 })}`);
    expect(text(w.blobs.blobs.get(square.key)?.data)).toContain("400,0,600,600");
    expect(copyOf(w, "square.webp")).toContain("400,0,600,600");
    expect(text(expectOk(await other.read("m1", "square.webp"))?.data)).toContain("400,0,600,600");
    for (const images of [first, slow, other]) await images.close();
  });

  it("a render whose crop was replaced and set back meanwhile writes nothing, so the path keeps the bytes ?v= names", async () => {
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
    expect(other.publicPath("m1", square)).toBe(path);
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
    const slow = await w.open([SQUARE], undefined, { blobs: writes });
    const other = await w.open([SQUARE]);

    expectOk(await other.setFraming("m1", { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } }));
    w.events.emitted.length = 0;
    const generating = slow.generate("m1");
    await g.reached;
    expectOk(await other.setFraming("m1", kept));
    g.open();
    expectOk(await generating);

    const square = (await rowsBySize(w)).get("square")!;
    expect(square).toMatchObject({ state: "pending", crop: "400,0,600,600", renderedCrop: "0,0,600,600" });
    expect(other.publicPath("m1", square)).toBe(`/media/m1/variants/square.webp?v=${cropToken({ left: 0, top: 0, width: 600, height: 600 })}`);
    expect(text(w.blobs.blobs.get(square.key)?.data)).toContain("0,0,600,600");
    expect(w.events.emitted).toEqual([{ name: "images.variantsChanged", ids: ["m1"] }]);

    expectOk(await other.generate("m1"));
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

    expect(expectOk(await other.framingsOf(["m1"])).get("m1")!.ratios[0]!.crop).toEqual({ left: 400, top: 0, width: 600, height: 600 });
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "pending", crop: "400,0,600,600" });
    expectOk(await other.generate("m1"));
    expect(copyOf(w, "square.webp")).toContain("400,0,600,600");
    for (const images of [slow, other]) await images.close();
  });

  it("re-plans in the background when the re-planning of images.setFraming fails after the framing was stored", async () => {
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
    expect((await rowsBySize(w)).get("square")).toMatchObject({ state: "pending", crop: "400,0,600,600" });
    await images.close();
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
