import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import { createFakeMedia, type FakeMedia } from "@michaelthielemann/kestrel-contracts/testing/fakeMedia";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createContext, type Context, type Step } from "@michaelthielemann/kestrel/context";
import { failure } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { validateSchema } from "@michaelthielemann/kestrel/schema";
import module from "./module.ts";
import { DEFAULT_RENDER_TIMEOUT_MS, FRAMING, ITEMS, VARIANTS, createImages, whenIdle, type Config, type Images, type ItemLease, type Variant } from "./impl.ts";
import type { PixelCrop } from "./framing.ts";
import { render, type Renderer } from "./generate.ts";
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
const BANNER: Size = { name: "banner", width: 250, height: 150, fit: "cover", format: "webp", quality: 82 };
const WIDE: Size = { name: "wide", width: 160, height: 90, fit: "cover", format: "webp", quality: 82 };
const WIDE_LARGE: Size = { name: "wide-large", width: 320, height: 180, fit: "cover", format: "webp", quality: 82 };
const SQUARE: Size = { name: "square", width: 100, height: 100, fit: "cover", format: "webp", quality: 82 };
const SIZES = [THUMB, BANNER, WIDE, WIDE_LARGE, SQUARE];
const CONFIG: Config = { prefix: "media-variants/", publicPath: "/media", publicCopy: { prefix: "site/" }, chunk: 5, staleAfterMs: 60000, maxAttempts: 2, renderTimeoutMs: DEFAULT_RENDER_TIMEOUT_MS, sizes: SIZES };

const CORNER_FOCUS = { focus: { x: 0, y: 0, w: 0.1, h: 0.1 } };
const RIGHT_CROP = { crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } };
const LEFT_CROP = { crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } };
const RIGHT: PixelCrop = { left: 400, top: 0, width: 600, height: 600 };
const LEFT: PixelCrop = { left: 0, top: 0, width: 600, height: 600 };
const LATER = 1001 + CONFIG.staleAfterMs;
const SQUARE_PATH = "/media/m1/variants/square.webp";
const VERSIONED_SQUARE = /^\/media\/m1\/variants\/square\.webp\?v=[0-9a-z]+$/;

interface AttachedVariant {
  size: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
  state: string;
  path: string;
  crop: PixelCrop | null;
}

interface World {
  blobs: MemoryBlobs;
  db: FakePersistence;
  media: FakeMedia;
  events: Events & { emitted: Array<{ name: string; ids: unknown }> };
  open(sizes?: Size[], renderer?: Renderer, deps?: { blobs?: Blobstore; now?: () => number }): Promise<Images>;
}

async function world(): Promise<World> {
  const blobs = memoryBlobs();
  const db = createFakePersistence();
  const media = createFakeMedia();
  const red = await sharp({ create: { width: 400, height: 600, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const original = new Uint8Array(await sharp({ create: { width: 1000, height: 600, channels: 3, background: "#0000ff" } }).composite([{ input: red, left: 0, top: 0 }]).jpeg().toBuffer());
  media.add({ id: "m1", contentType: "image/jpeg", data: original, filename: "photo.jpg", createdAt: 1000 });
  const events = recordingEvents();
  return {
    blobs,
    db,
    media,
    events,
    open: (sizes = SIZES, renderer = render, deps = {}) => createImages({ ...CONFIG, sizes }, { blobs: deps.blobs ?? blobs, db, media, logger: quiet, render: renderer, events }, deps.now ?? (() => 1000)),
  };
}

function ctx(patch: Partial<Context>): Context {
  return { ...createContext({ trigger: { kind: "http", name: "t" } }), ...patch };
}

async function attached(images: Images, id = "m1"): Promise<Map<string, AttachedVariant>> {
  const steps = boundaryCast<{ attach: Step }>(module.steps!(images), "host");
  const description = boundaryCast<{ extendsItems: Record<string, unknown> }>(module.describe!(images).attach, "host");
  const single = expectOk(await steps.attach(ctx({ result: { id, contentType: "image/jpeg" } })));
  expect(validateSchema(description.extendsItems, single.result)).toEqual([]);
  const list = expectOk(await steps.attach(ctx({ result: { items: [{ id, contentType: "image/jpeg" }] } })));
  const fromList = boundaryCast<{ items: Array<{ variants: AttachedVariant[] }> }>(list.result, "host").items[0]!.variants;
  const variants = boundaryCast<{ variants: AttachedVariant[] }>(single.result, "host").variants;
  expect(fromList).toEqual(variants);
  return new Map(variants.map((variant) => [variant.size, variant]));
}

async function thumbnail(images: Images, file: string): Promise<number[]> {
  const found = expectOk(await images.read("m1", file));
  const { data } = await sharp(found!.data).resize(16, 9, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  return [...data].map((value) => Math.round(value / 64));
}

async function leftEdgeIsBlue(images: Images, file: string): Promise<boolean> {
  const found = expectOk(await images.read("m1", file));
  const { data } = await sharp(found!.data).raw().toBuffer({ resolveWithObject: true });
  return data[2]! > 200 && data[0]! < 60;
}

function gate(): { wait: Promise<void>; open(): void; reached: Promise<void>; arrive(): void } {
  let open: () => void = () => {};
  let arrive: () => void = () => {};
  const wait = new Promise<void>((resolve) => { open = resolve; });
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  return { wait, open, reached, arrive };
}

function heldNext(): { renderer: Renderer; held: ReturnType<typeof gate>; arm(): void } {
  const held = gate();
  let armed = false;
  return {
    held,
    arm() { armed = true; },
    async renderer(data, size, planned, options) {
      if (armed) {
        armed = false;
        held.arrive();
        await held.wait;
      }
      return render(data, size, planned, options);
    },
  };
}

describe("images/default variants[].crop in images.attach", () => {
  it("is null for an inside size, for a cover size of the original's ratio without a framing or with a focus only, and the focus cut for another ratio", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.generate("m1"));
    const unframed = await attached(images);
    expect([...unframed.values()].map((variant) => [variant.size, variant.state, variant.crop]).sort()).toEqual([
      ["banner", "done", null],
      ["square", "done", null],
      ["thumb", "done", null],
      ["wide", "done", null],
      ["wide-large", "done", null],
    ]);

    expectOk(await images.setFraming("m1", CORNER_FOCUS));
    expectOk(await images.generate("m1"));
    const focused = await attached(images);
    expect(focused.get("thumb")).toMatchObject({ state: "done", crop: null });
    expect(focused.get("banner")).toMatchObject({ state: "done", crop: null, path: "/media/m1/variants/banner.webp" });
    expect(focused.get("wide")).toMatchObject({ state: "done", crop: { left: 0, top: 0, width: 1000, height: 563 } });
    expect(focused.get("wide-large")).toMatchObject({ state: "done", crop: focused.get("wide")!.crop });
    expect(await thumbnail(images, "wide-large.webp")).toEqual(await thumbnail(images, "wide.webp"));
    expect(focused.get("square")).toMatchObject({ state: "done", crop: LEFT });
    expect(expectOk(await images.framingsOf(["m1"])).get("m1")!.ratios.map((ratio) => [ratio.key, ratio.crop])).toEqual([
      ["5:3", null],
      ["16:9", focused.get("wide")!.crop],
      ["1:1", focused.get("square")!.crop],
    ]);
    await images.close();
  });

  it("reports a manual crop once its render is done, and the bytes at the path show it", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.generate("m1"));
    expect(await leftEdgeIsBlue(images, "square.webp")).toBe(false);

    expectOk(await images.setFraming("m1", RIGHT_CROP));
    expect((await attached(images)).get("square")).toMatchObject({ state: "pending", crop: null, path: SQUARE_PATH });
    expectOk(await images.generate("m1"));
    const square = (await attached(images)).get("square")!;
    expect(square).toMatchObject({ state: "done", crop: RIGHT });
    expect(square.path).toMatch(VERSIONED_SQUARE);
    expect(await leftEdgeIsBlue(images, "square.webp")).toBe(true);
    await images.close();
  });

  it("keeps the old crop and path while a re-render after a framing change runs, then switches crop and ?v= together", async () => {
    const w = await world();
    const holder = heldNext();
    const images = await w.open([SQUARE], holder.renderer);
    expectOk(await images.setFraming("m1", RIGHT_CROP));
    expectOk(await images.generate("m1"));
    const before = (await attached(images)).get("square")!;
    expect(before).toMatchObject({ state: "done", crop: RIGHT, path: SQUARE_PATH });

    expectOk(await images.setFraming("m1", LEFT_CROP));
    expect((await attached(images)).get("square")).toEqual({ ...before, state: "pending" });

    holder.arm();
    const generating = images.generate("m1");
    await holder.held.reached;
    const during = (await attached(images)).get("square")!;
    expect(during).toMatchObject({ crop: RIGHT, path: SQUARE_PATH });
    expect(await leftEdgeIsBlue(images, "square.webp")).toBe(true);
    holder.held.open();
    expectOk(await generating);

    const after = (await attached(images)).get("square")!;
    expect(after).toMatchObject({ state: "done", crop: LEFT });
    expect(after.path).toMatch(VERSIONED_SQUARE);
    expect(after.path).not.toBe(before.path);
    expect(await leftEdgeIsBlue(images, "square.webp")).toBe(false);
    await images.close();
  });

  it("keeps the old crop and path while the re-render after a framing change fails, until it gives up", async () => {
    const w = await world();
    let failing = false;
    const renderer: Renderer = async (data, size, planned, options) => {
      if (failing) throw new Error("render failed");
      return render(data, size, planned, options);
    };
    const images = await w.open([SQUARE], renderer);
    expectOk(await images.setFraming("m1", RIGHT_CROP));
    expectOk(await images.generate("m1"));
    const before = (await attached(images)).get("square")!;
    expect(before).toMatchObject({ state: "done", crop: RIGHT });

    expectOk(await images.setFraming("m1", LEFT_CROP));
    failing = true;
    expectOk(await images.generate("m1"));
    expect((await attached(images)).get("square")).toMatchObject({ state: "error", crop: RIGHT, path: before.path });
    expect(await leftEdgeIsBlue(images, "square.webp")).toBe(true);

    for (let attempt = 1; attempt < CONFIG.maxAttempts; attempt += 1) expectOk(await images.generate("m1"));
    expect((await attached(images)).get("square")).toMatchObject({ state: "failed", crop: RIGHT, path: before.path });
    expect(await leftEdgeIsBlue(images, "square.webp")).toBe(true);
    await images.close();
  });

  it("reports null after a reset to automatic once its render is done, and the manual crop until then", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.setFraming("m1", RIGHT_CROP));
    expectOk(await images.generate("m1"));
    const manual = (await attached(images)).get("square")!;

    expectOk(await images.setFraming("m1", {}));
    expect((await attached(images)).get("square")).toMatchObject({ state: "pending", crop: RIGHT, path: manual.path });
    expectOk(await images.generate("m1"));
    const reset = (await attached(images)).get("square")!;
    expect(reset).toMatchObject({ state: "done", crop: null });
    expect(reset.path).toMatch(VERSIONED_SQUARE);
    expect(reset.path).not.toBe(manual.path);
    await images.close();
  });

  it("reports null at the new path of a format change until its render is done, then the crop", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.setFraming("m1", RIGHT_CROP));
    expectOk(await images.generate("m1"));
    const changed = await w.open([{ ...SQUARE, format: "original" }]);
    expectOk(await changed.plan(["m1"]));
    const replanned = (await attached(changed)).get("square");
    expect(replanned).toMatchObject({ state: "pending", crop: null, path: "/media/m1/variants/square.jpg" });
    expectOk(await changed.generate("m1"));
    const square = (await attached(changed)).get("square")!;
    expect(square).toMatchObject({ state: "done", format: "jpeg", crop: RIGHT });
    expect(square.path).toMatch(/^\/media\/m1\/variants\/square\.jpg\?v=[0-9a-z]+$/);
    expect(await leftEdgeIsBlue(changed, "square.jpg")).toBe(true);
    for (const open of [images, changed]) await open.close();
  });

  it("reports null for a row without a rendered crop and for one whose rendered crop does not parse", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.setFraming("m1", RIGHT_CROP));
    expectOk(await images.generate("m1"));
    for (const renderedCrop of [null, "", "400,0,x,600", "400,0,0,600", "-1,0,600,600", "400;0;600;600"]) {
      expectOk(await w.db.updateMany<Variant>(VARIANTS, { mediaId: "m1" }, { renderedCrop }));
      expect((await attached(images)).get("square"), String(renderedCrop)).toMatchObject({ size: "square", crop: null });
    }
    await images.close();
  });

  it("lists no variants for a hidden item", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.setFraming("m1", RIGHT_CROP));
    expectOk(await images.generate("m1"));
    expectOk(await images.hide(["m1"]));
    expect((await attached(images)).size).toBe(0);
    expectOk(await images.show(["m1"]));
    expect((await attached(images)).get("square")).toMatchObject({ crop: RIGHT });
    await images.close();
  });

  it("leaves the export and the public copy at the plain path with the bytes of the crop's render", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.setFraming("m1", RIGHT_CROP));
    expectOk(await images.generate("m1"));
    expect((await attached(images)).get("square")).toMatchObject({ crop: RIGHT });
    const rendered = expectOk(await images.read("m1", "square.webp"))!.data;
    expect([...w.blobs.blobs.keys()].filter((key) => key.startsWith("site/"))).toEqual(["site/media/m1/variants/square.webp"]);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(rendered);
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "images-crop-export-"));
    try {
      expect(expectOk(await images.exportTo(dir)).written).toBe(1);
      expect(await readdir(dir, { recursive: true })).toEqual(["photo.jpg.square.webp"]);
      const exported = new Uint8Array(await readFile(join(dir, "photo.jpg.square.webp")));
      expect(exported).toEqual(new Uint8Array(rendered));
      const { data } = await sharp(exported).raw().toBuffer({ resolveWithObject: true });
      expect(data[2]! > 200 && data[0]! < 60).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await images.close();
  });
  it.each([
    ["error", 1],
    ["failed", CONFIG.maxAttempts],
  ])("renders an %s size again after a write that stalled past staleAfterMs lands late, so crop and ?v= follow the bytes at the path", async (state, failures) => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.setFraming("m1", RIGHT_CROP));
    expectOk(await first.generate("m1"));
    const before = (await attached(first)).get("square")!;
    expectOk(await first.setFraming("m1", LEFT_CROP));

    const held = gate();
    let armed = true;
    const stalling: Blobstore = {
      ...w.blobs,
      put: async (key, data, options) => {
        if (armed && key.startsWith("media-variants/")) {
          armed = false;
          held.arrive();
          await held.wait;
        }
        return w.blobs.put(key, data, options);
      },
    };
    const slow = await w.open([SQUARE], render, { blobs: stalling });
    const generating = slow.generate("m1");
    await held.reached;

    const failing: Renderer = async () => { throw new Error("render failed"); };
    const later = await w.open([SQUARE], failing, { now: () => LATER });
    for (let attempt = 0; attempt < failures; attempt += 1) expectOk(await later.generate("m1"));
    expect((await attached(later)).get("square")).toMatchObject({ state, crop: RIGHT, path: before.path });

    held.open();
    await generating;
    await whenIdle(slow);
    await whenIdle(later);
    const after = (await attached(later)).get("square")!;
    expect(after).toMatchObject({ state: "done", crop: LEFT });
    expect(after.path).toMatch(VERSIONED_SQUARE);
    expect(after.path).not.toBe(before.path);
    expect(expectOk(await later.variantsOf(["m1"])).get("m1")!.map((row) => [row.state, row.attempts])).toEqual([["done", 1]]);
    expect(await leftEdgeIsBlue(later, "square.webp")).toBe(false);
    for (const images of [first, slow, later]) await images.close();
  });

  it("moves the entry to the new render's crop and a new ?v= when its public copy fails and the earlier bytes cannot be put back", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.setFraming("m1", RIGHT_CROP));
    expectOk(await first.generate("m1"));
    const before = (await attached(first)).get("square")!;
    expectOk(await first.setFraming("m1", LEFT_CROP));

    let variantPuts = 0;
    const broken: Blobstore = {
      ...w.blobs,
      put: async (key, data, options) => {
        if (key.startsWith("site/")) return err(failure("TRANSIENT", "copy store unavailable"));
        if (key.startsWith("media-variants/") && (variantPuts += 1) > 1) return err(failure("TRANSIENT", "variant store unavailable"));
        return w.blobs.put(key, data, options);
      },
    };
    const images = await w.open([SQUARE], render, { blobs: broken });
    w.events.emitted.length = 0;
    await images.generate("m1");
    expect(w.events.emitted).toEqual([{ name: "images.variantsChanged", ids: ["m1"] }]);
    const errored = (await attached(images)).get("square")!;
    expect(errored).toMatchObject({ state: "error", crop: LEFT });
    expect(errored.bytes).toBe(w.blobs.blobs.get("media-variants/m1/square.webp")!.data.byteLength);
    expect(errored.bytes).not.toBe(before.bytes);
    expect(errored.path).toMatch(VERSIONED_SQUARE);
    expect(errored.path).not.toBe(before.path);
    expect(await leftEdgeIsBlue(images, "square.webp")).toBe(false);

    for (let attempt = 1; attempt < CONFIG.maxAttempts; attempt += 1) await images.generate("m1");
    expect((await attached(images)).get("square")).toEqual({ ...errored, state: "failed" });
    expect(await leftEdgeIsBlue(images, "square.webp")).toBe(false);
    for (const open of [first, images]) await open.close();
  });

  it("writes the render left at the path to the public copy once the copy store accepts it again, so origin and copy answer the listed crop", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.setFraming("m1", RIGHT_CROP));
    expectOk(await first.generate("m1"));
    expectOk(await first.setFraming("m1", LEFT_CROP));

    let copyFailures = 1;
    let variantPuts = 0;
    const broken: Blobstore = {
      ...w.blobs,
      put: async (key, data, options) => {
        if (key.startsWith("site/") && copyFailures > 0) {
          copyFailures -= 1;
          return err(failure("TRANSIENT", "copy store unavailable"));
        }
        if (key.startsWith("media-variants/") && (variantPuts += 1) === 2) return err(failure("TRANSIENT", "variant store unavailable"));
        return w.blobs.put(key, data, options);
      },
    };
    const images = await w.open([SQUARE], render, { blobs: broken });
    await images.generate("m1");
    const errored = (await attached(images)).get("square")!;
    expect(errored).toMatchObject({ state: "error", crop: LEFT });
    expect(errored.path).toMatch(VERSIONED_SQUARE);
    const served = expectOk(await images.read("m1", "square.webp"))!.data;
    expect(await leftEdgeIsBlue(images, "square.webp")).toBe(false);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(served);
    for (const open of [first, images]) await open.close();
  });

  it("writes a first render left at a fresh path to the public copy instead of the original when the copy store accepts it again", async () => {
    const w = await world();
    const inside = await w.open([THUMB]);
    expectOk(await inside.setFraming("m1", RIGHT_CROP));
    expectOk(await inside.generate("m1"));
    const planned = await w.open([THUMB, SQUARE]);
    expectOk(await planned.plan(["m1"]));

    let copyFailures = 1;
    const broken: Blobstore = {
      ...w.blobs,
      put: async (key, data, options) => {
        if (key.startsWith("site/") && copyFailures > 0) {
          copyFailures -= 1;
          return err(failure("TRANSIENT", "copy store unavailable"));
        }
        return w.blobs.put(key, data, options);
      },
      remove: async (key) => (key.startsWith("media-variants/") ? err(failure("TRANSIENT", "variant store unavailable")) : w.blobs.remove(key)),
    };
    const images = await w.open([THUMB, SQUARE], render, { blobs: broken });
    await images.generate("m1");
    const square = (await attached(images)).get("square")!;
    expect(square).toMatchObject({ state: "error", crop: RIGHT, path: SQUARE_PATH });
    const served = expectOk(await images.read("m1", "square.webp"))!.data;
    expect(await leftEdgeIsBlue(images, "square.webp")).toBe(true);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(served);
    for (const open of [inside, planned, images]) await open.close();
  });

  it("gives the path a new ?v= and raises images.variantsChanged when a public copy that held other bytes is written again after an outage", async () => {
    const w = await world();
    const first = await w.open([SQUARE]);
    expectOk(await first.setFraming("m1", RIGHT_CROP));
    expectOk(await first.generate("m1"));
    expectOk(await first.setFraming("m1", LEFT_CROP));

    let copyDown = true;
    let variantPuts = 0;
    const broken: Blobstore = {
      ...w.blobs,
      put: async (key, data, options) => {
        if (key.startsWith("site/") && copyDown) return err(failure("TRANSIENT", "copy store unavailable"));
        if (key.startsWith("media-variants/") && (variantPuts += 1) > 1) return err(failure("TRANSIENT", "variant store unavailable"));
        return w.blobs.put(key, data, options);
      },
    };
    const images = await w.open([SQUARE], render, { blobs: broken });
    for (let attempt = 0; attempt < CONFIG.maxAttempts; attempt += 1) await images.generate("m1");
    const errored = (await attached(images)).get("square")!;
    expect(errored).toMatchObject({ state: "failed", crop: LEFT });
    expect(errored.path).toMatch(VERSIONED_SQUARE);
    const stale = w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data;
    expect(stale).not.toEqual(expectOk(await images.read("m1", "square.webp"))!.data);

    copyDown = false;
    w.events.emitted.length = 0;
    expectOk(await images.syncPublic());
    const synced = (await attached(images)).get("square")!;
    expect(synced).toMatchObject({ state: "failed", crop: LEFT });
    expect(synced.path).toMatch(VERSIONED_SQUARE);
    expect(synced.path).not.toBe(errored.path);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(expectOk(await images.read("m1", "square.webp"))!.data);
    expect(w.events.emitted).toEqual([{ name: "images.variantsChanged", ids: ["m1"] }]);

    w.events.emitted.length = 0;
    expectOk(await images.syncPublic());
    expect((await attached(images)).get("square")).toEqual(synced);
    expect(w.events.emitted).toEqual([]);
    for (const open of [first, images]) await open.close();
  });

  it("keeps the listing, the origin and the public copy on the listed crop at a pruned size whose row delete failed, and retires the path on a retry", async () => {
    const w = await world();
    const full = await w.open([THUMB, SQUARE]);
    expectOk(await full.setFraming("m1", RIGHT_CROP));
    expectOk(await full.generate("m1"));
    const before = (await attached(full)).get("square")!;
    const rendered = await renderedBytes(full, "m1", "square.webp");

    const small = await w.open([THUMB]);
    const deleteOne = w.db.deleteOne.bind(w.db);
    let failDelete = true;
    w.db.deleteOne = async (collection, id) => {
      if (failDelete && collection === VARIANTS) {
        failDelete = false;
        return err(failure("TRANSIENT", "db unavailable"));
      }
      return deleteOne(collection, id);
    };
    const pruned = await small.prune(["square"]);
    expect(pruned.ok).toBe(false);
    expect((await attached(small)).get("square")).toEqual(before);
    expect(await renderedBytes(small, "m1", "square.webp")).toEqual(rendered);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(rendered);

    expectOk(await small.syncPublic());
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(rendered);

    expectOk(await small.prune(["square"]));
    expect((await attached(small)).has("square")).toBe(false);
    const served = expectOk(await small.read("m1", "square.webp"))!;
    expect(served.fallback).toBe(true);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(served.data);
    expect(w.blobs.blobs.has("media-variants/m1/square.webp")).toBe(false);
    for (const open of [full, small]) await open.close();
  });

  it("keeps the listing, the origin and the public copy on the listed crop when the row update of a format change fails, and moves the row on a retry", async () => {
    const w = await world();
    const webp = await w.open([SQUARE]);
    expectOk(await webp.setFraming("m1", RIGHT_CROP));
    expectOk(await webp.generate("m1"));
    const before = (await attached(webp)).get("square")!;
    const rendered = await renderedBytes(webp, "m1", "square.webp");
    await webp.close();

    const updateMany = w.db.updateMany.bind(w.db);
    let failMove = true;
    w.db.updateMany = async (collection, filter, patch, ...rest) => {
      if (failMove && collection === VARIANTS && "key" in patch) {
        failMove = false;
        return err(failure("TRANSIENT", "db unavailable"));
      }
      return updateMany(collection, filter, patch, ...rest);
    };
    const changed = await w.open([{ ...SQUARE, format: "original" }]);
    expect((await changed.plan(["m1"])).ok).toBe(false);
    expect((await attached(changed)).get("square")).toEqual(before);
    expect(await renderedBytes(changed, "m1", "square.webp")).toEqual(rendered);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(rendered);

    expectOk(await changed.plan(["m1"]));
    expect((await attached(changed)).get("square")).toMatchObject({ state: "pending", crop: null, path: "/media/m1/variants/square.jpg" });
    const original = expectOk(await w.media.load("m1"))!.data;
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(original);
    expect(w.blobs.blobs.has("media-variants/m1/square.webp")).toBe(false);
    await changed.close();
  });

  it("renders an entry again with a new ?v= when syncPublic finds other bytes at its key than its restored row records", async () => {
    const w = await world();
    const images = await w.open([SQUARE]);
    expectOk(await images.setFraming("m1", RIGHT_CROP));
    expectOk(await images.generate("m1"));
    const backup = await Promise.all([VARIANTS, FRAMING].map(async (collection) => ({ collection, rows: expectOk(await w.db.findMany<{ id: string }>(collection, {}, {})).items.map((row) => ({ ...row })) })));
    expectOk(await images.setFraming("m1", LEFT_CROP));
    expectOk(await images.generate("m1"));
    const recropped = (await attached(images)).get("square")!;
    expect(recropped).toMatchObject({ state: "done", crop: LEFT });
    await images.close();

    for (const { collection, rows } of backup) {
      for (const { id, ...fields } of rows) expectOk(await w.db.updateOne(collection, id, fields));
    }
    const restored = await w.open([SQUARE]);
    expect((await attached(restored)).get("square")).toMatchObject({ state: "done", crop: RIGHT, path: SQUARE_PATH });
    w.events.emitted.length = 0;
    expectOk(await restored.syncPublic());
    await whenIdle(restored);
    const rendered = (await attached(restored)).get("square")!;
    expect(rendered).toMatchObject({ state: "done", crop: RIGHT });
    expect(rendered.path).toMatch(VERSIONED_SQUARE);
    expect(rendered.path).not.toBe(recropped.path);
    expect(await leftEdgeIsBlue(restored, "square.webp")).toBe(true);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(await renderedBytes(restored, "m1", "square.webp"));
    expect(w.events.emitted.some(({ name }) => name === "images.variantsChanged")).toBe(true);

    w.events.emitted.length = 0;
    expectOk(await restored.syncPublic());
    await whenIdle(restored);
    expect((await attached(restored)).get("square")).toEqual(rendered);
    expect(w.events.emitted).toEqual([]);
    await restored.close();
  });

  it("gives the path one more ?v= when syncPublic rewrites a public copy another instance put right while it listed", async () => {
    const w = await world();
    let duringPrivateList: (() => Promise<void>) | null = null;
    const racing: Blobstore = {
      ...w.blobs,
      list: async (prefix) => {
        if (prefix === CONFIG.prefix && duringPrivateList !== null) {
          const run = duringPrivateList;
          duringPrivateList = null;
          await run();
        }
        return w.blobs.list(prefix);
      },
    };
    const syncing = await w.open([SQUARE], render, { blobs: racing });
    const other = await w.open([SQUARE]);
    expectOk(await syncing.setFraming("m1", RIGHT_CROP));
    expectOk(await syncing.generate("m1"));
    let afterOther: AttachedVariant | undefined;
    duringPrivateList = async () => {
      expectOk(await other.setFraming("m1", LEFT_CROP));
      expectOk(await other.generate("m1"));
      afterOther = (await attached(other)).get("square");
    };
    w.events.emitted.length = 0;
    expectOk(await syncing.syncPublic());
    expect(afterOther).toMatchObject({ state: "done", crop: LEFT });
    const synced = (await attached(syncing)).get("square")!;
    expect(synced).toEqual({ ...afterOther, path: synced.path });
    expect(synced.path).toMatch(VERSIONED_SQUARE);
    expect(synced.path).not.toBe(afterOther!.path);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(await renderedBytes(syncing, "m1", "square.webp"));
    expect(w.events.emitted.filter(({ name }) => name === "images.variantsChanged")).toHaveLength(2);
    for (const open of [syncing, other]) await open.close();
  });

  it("gives a size without a finished render a ?v= and raises images.variantsChanged when syncPublic rewrites its public copy of other bytes", async () => {
    const w = await world();
    const inside = await w.open([THUMB]);
    expectOk(await inside.generate("m1"));
    const listed: string[] = [];
    const listing: Blobstore = { ...w.blobs, list: async (prefix) => { listed.push(prefix); return w.blobs.list(prefix); } };
    const added = await w.open([THUMB, SQUARE], render, { blobs: listing });
    expectOk(await added.plan(["m1"]));
    expect((await attached(added)).get("square")).toMatchObject({ state: "pending", path: SQUARE_PATH });
    w.blobs.blobs.set("site/media/m1/variants/square.webp", { data: new Uint8Array([1, 2, 3]), contentType: "image/webp" });

    w.events.emitted.length = 0;
    listed.length = 0;
    expectOk(await added.syncPublic());
    expect(listed).toEqual(["site/media/", CONFIG.prefix]);
    const synced = (await attached(added)).get("square")!;
    expect(synced).toMatchObject({ state: "pending", crop: null });
    expect(synced.path).toMatch(VERSIONED_SQUARE);
    const served = expectOk(await added.read("m1", "square.webp"))!;
    expect(served.fallback).toBe(true);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(served.data);
    expect(w.events.emitted).toEqual([{ name: "images.variantsChanged", ids: ["m1"] }]);
    for (const open of [inside, added]) await open.close();
  });

  it("writes the public copies of a shown item, a missing public copy and one of another byte size without reading the copies they replace", async () => {
    const w = await world();
    let copyReads = 0;
    const counting: Blobstore = {
      ...w.blobs,
      get: async (key) => {
        if (key.startsWith("site/")) copyReads += 1;
        return w.blobs.get(key);
      },
    };
    const images = await w.open([SQUARE], render, { blobs: counting });
    expectOk(await images.setFraming("m1", RIGHT_CROP));
    expectOk(await images.generate("m1"));
    const before = (await attached(images)).get("square")!;
    const rendered = await renderedBytes(images, "m1", "square.webp");

    expectOk(await images.hide(["m1"]));
    expectOk(await images.show(["m1"]));
    await whenIdle(images);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(rendered);

    w.blobs.blobs.delete("site/media/m1/variants/square.webp");
    w.events.emitted.length = 0;
    expect(expectOk(await images.syncPublic()).written).toBe(1);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(rendered);
    expect(w.events.emitted).toEqual([]);
    expect((await attached(images)).get("square")).toEqual(before);
    expect(copyReads).toBe(0);

    w.blobs.blobs.set("site/media/m1/variants/square.webp", { data: new Uint8Array([1, 2, 3]), contentType: "image/webp" });
    expect(expectOk(await images.syncPublic()).written).toBe(1);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(rendered);
    expect((await attached(images)).get("square")!.path).toMatch(VERSIONED_SQUARE);
    expect(w.events.emitted).toEqual([{ name: "images.variantsChanged", ids: ["m1"] }]);
    expect(copyReads).toBe(0);
    await images.close();
  });

  it("records a render without bytes as a failed attempt and keeps listing the crop of the bytes at the path", async () => {
    const w = await world();
    let empty = false;
    const renderer: Renderer = async (data, size, planned, options) => {
      const rendered = await render(data, size, planned, options);
      return empty ? { ...rendered, data: new Uint8Array(0) } : rendered;
    };
    const images = await w.open([SQUARE], renderer);
    expectOk(await images.setFraming("m1", RIGHT_CROP));
    expectOk(await images.generate("m1"));
    const before = (await attached(images)).get("square")!;
    const rendered = await renderedBytes(images, "m1", "square.webp");

    expectOk(await images.setFraming("m1", LEFT_CROP));
    empty = true;
    expectOk(await images.generate("m1"));
    const row = expectOk(await images.variantsOf(["m1"])).get("m1")![0]!;
    expect([row.state, row.error, row.bytes]).toEqual(["error", "the render produced no bytes", before.bytes]);
    expect((await attached(images)).get("square")).toMatchObject({ state: "error", crop: RIGHT, path: before.path });
    expect(await renderedBytes(images, "m1", "square.webp")).toEqual(rendered);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(rendered);
    await images.close();
  });

  it("answers the original at a size added to the configuration whose first render stayed at its key after its copy and removal failed, while the entry lists crop null", async () => {
    const w = await world();
    const inside = await w.open([THUMB]);
    expectOk(await inside.setFraming("m1", RIGHT_CROP));
    expectOk(await inside.generate("m1"));

    let down = true;
    let renderFails = false;
    const broken: Blobstore = {
      ...w.blobs,
      put: async (key, data, options) => (down && key.startsWith("site/") ? err(failure("TRANSIENT", "copy store unavailable")) : w.blobs.put(key, data, options)),
      remove: async (key) => (down && key.startsWith("media-variants/") ? err(failure("TRANSIENT", "variant store unavailable")) : w.blobs.remove(key)),
    };
    const renderer: Renderer = async (data, size, planned, options) => {
      if (renderFails) throw new Error("render failed");
      return render(data, size, planned, options);
    };
    const added = await w.open([THUMB, SQUARE], renderer, { blobs: broken });
    await added.generate("m1");
    await whenIdle(added);
    expect(w.blobs.blobs.has("media-variants/m1/square.webp")).toBe(true);

    down = false;
    renderFails = true;
    expectOk(await added.plan(["m1"]));
    for (let attempt = 0; attempt < CONFIG.maxAttempts; attempt += 1) await added.generate("m1");
    await whenIdle(added);
    expectOk(await added.syncPublic());
    expect((await attached(added)).get("square")).toMatchObject({ state: "failed", crop: null, bytes: 0, path: SQUARE_PATH });
    const served = expectOk(await added.read("m1", "square.webp"))!;
    expect(served.fallback).toBe(true);
    expect(await leftEdgeIsBlue(added, "square.webp")).toBe(false);
    expect(w.blobs.blobs.get("site/media/m1/variants/square.webp")!.data).toEqual(served.data);

    renderFails = false;
    expectOk(await added.setFraming("m1", LEFT_CROP));
    expectOk(await added.generate("m1"));
    expect((await attached(added)).get("square")).toMatchObject({ state: "done", crop: LEFT, path: SQUARE_PATH });
    for (const open of [inside, added]) await open.close();
  });

  it("leaves the sizes of an image that cannot be decoded failed with cannot decode when a write of the item landed late", async () => {
    const w = await world();
    w.media.add({ id: "m2", contentType: "image/jpeg", data: new Uint8Array([1, 2, 3]), filename: "broken.jpg", createdAt: 1000, width: 100, height: 50 });
    const images = await w.open([THUMB, SQUARE]);
    expectOk(await images.plan(["m2"]));
    const rowsOf = async (): Promise<Array<[string, string | null, number]>> => (expectOk(await images.variantsOf(["m2"])).get("m2") ?? []).map((row) => [row.state, row.error, row.attempts]);
    expect(await rowsOf()).toEqual([["failed", "cannot decode", 0], ["failed", "cannot decode", 0]]);

    expectOk(await w.db.updateMany<ItemLease>(ITEMS, { mediaId: "m2" }, { request: "late-write", redo: true }));
    await images.generate("m2");
    await whenIdle(images);
    expect(await rowsOf()).toEqual([["failed", "cannot decode", 0], ["failed", "cannot decode", 0]]);
    await images.close();
  });

  it("changes crop from null to the cut at the first render of a cover size added to the configuration, at the same plain path", async () => {
    const w = await world();
    const inside = await w.open([THUMB]);
    expectOk(await inside.setFraming("m1", RIGHT_CROP));
    expectOk(await inside.generate("m1"));
    const added = await w.open([THUMB, SQUARE]);
    expectOk(await added.plan(["m1"]));
    expect((await attached(added)).get("square")).toMatchObject({ state: "pending", crop: null, path: SQUARE_PATH });
    expectOk(await added.generate("m1"));
    expect((await attached(added)).get("square")).toMatchObject({ state: "done", crop: RIGHT, path: SQUARE_PATH });
    expect(await leftEdgeIsBlue(added, "square.webp")).toBe(true);
    for (const open of [inside, added]) await open.close();
  });
});

const PHOTO: Size = { name: "photo", width: 300, height: 200, fit: "cover", format: "webp", quality: 82 };
const TALL: Size = { name: "tall", width: 200, height: 300, fit: "cover", format: "webp", quality: 82 };
const TOP_FOCUS = { focus: { x: 0.5, y: 0, w: 0, h: 0 } };

async function photo(width: number, height: number, orientation?: number): Promise<Uint8Array> {
  const band = await sharp({ create: { width, height: 40, channels: 3, background: "#00ff00" } }).png().toBuffer();
  const pipeline = sharp({ create: { width, height, channels: 3, background: "#ff00ff" } }).composite([{ input: band, left: 0, top: 0 }]).jpeg();
  return new Uint8Array(await (orientation === undefined ? pipeline : pipeline.withMetadata({ orientation })).toBuffer());
}

function addPhotos(w: World, data: Uint8Array, ids: string[]): void {
  for (const id of ids) w.media.add({ id, contentType: "image/jpeg", data, filename: `${id}.jpg`, createdAt: 1000 });
}

async function ratiosOf(images: Images, id: string): Promise<Array<{ key: string; manual: boolean; crop: PixelCrop | null }>> {
  return expectOk(await images.framingsOf([id])).get(id)!.ratios.map(({ key, manual, crop }) => ({ key, manual, crop }));
}

async function renderedBytes(images: Images, id: string, file: string): Promise<Uint8Array> {
  return expectOk(await images.read(id, file))!.data;
}

describe("images/default lists a cut within a pixel of the centre as the centre", () => {
  it("lists the focus cut of a 1920 x 1281 original at its top or bottom edge as null for a 3:2 size and renders it as the centred cut", async () => {
    const w = await world();
    addPhotos(w, await photo(1920, 1281), ["top", "bottom", "plain"]);
    const images = await w.open([THUMB, PHOTO]);
    expectOk(await images.setFraming("top", TOP_FOCUS));
    expectOk(await images.setFraming("bottom", { focus: { x: 0.5, y: 1, w: 0, h: 0 } }));
    for (const id of ["top", "bottom", "plain"]) expectOk(await images.generate(id));
    const centred = await renderedBytes(images, "plain", "photo.webp");
    for (const id of ["top", "bottom"]) {
      expect(await ratiosOf(images, id), id).toEqual([{ key: "3:2", manual: false, crop: null }]);
      const variants = await attached(images, id);
      expect(variants.get("photo"), id).toMatchObject({ state: "done", crop: null, path: `/media/${id}/variants/photo.webp` });
      expect(variants.get("thumb"), id).toMatchObject({ state: "done", crop: null });
      expect(await renderedBytes(images, id, "photo.webp"), id).toEqual(centred);
    }
    await images.close();
  });

  it("keeps a focus cut two pixels off the centre as a crop", async () => {
    const w = await world();
    addPhotos(w, await photo(1920, 1284), ["top", "plain"]);
    const images = await w.open([PHOTO]);
    expectOk(await images.setFraming("top", TOP_FOCUS));
    for (const id of ["top", "plain"]) expectOk(await images.generate(id));
    const cut = { left: 0, top: 0, width: 1920, height: 1280 };
    expect(await ratiosOf(images, "top")).toEqual([{ key: "3:2", manual: false, crop: cut }]);
    expect((await attached(images, "top")).get("photo")).toMatchObject({ state: "done", crop: cut });
    expect(await renderedBytes(images, "top", "photo.webp")).not.toEqual(await renderedBytes(images, "plain", "photo.webp"));
    await images.close();
  });

  it("lists a focus cut within a pixel of the centre of an original with EXIF orientation 6 as null", async () => {
    const w = await world();
    addPhotos(w, await photo(1281, 1920, 6), ["top", "plain"]);
    const images = await w.open([PHOTO]);
    expectOk(await images.setFraming("top", TOP_FOCUS));
    for (const id of ["top", "plain"]) expectOk(await images.generate(id));
    const framed = expectOk(await images.framingsOf(["top"])).get("top")!;
    expect([framed.width, framed.height]).toEqual([1920, 1281]);
    expect(await ratiosOf(images, "top")).toEqual([{ key: "3:2", manual: false, crop: null }]);
    expect((await attached(images, "top")).get("photo")).toMatchObject({ state: "done", crop: null });
    expect(await renderedBytes(images, "top", "photo.webp")).toEqual(await renderedBytes(images, "plain", "photo.webp"));
    await images.close();
  });

  it("lists the focus cut of a 1281 x 1920 original at its left edge as null for a 2:3 size and renders it as the centred cut", async () => {
    const w = await world();
    addPhotos(w, await photo(1281, 1920), ["left", "plain"]);
    const images = await w.open([TALL]);
    expectOk(await images.setFraming("left", { focus: { x: 0, y: 0.5, w: 0, h: 0 } }));
    for (const id of ["left", "plain"]) expectOk(await images.generate(id));
    expect(await ratiosOf(images, "left")).toEqual([{ key: "2:3", manual: false, crop: null }]);
    expect((await attached(images, "left")).get("tall")).toMatchObject({ state: "done", crop: null });
    expect(await renderedBytes(images, "left", "tall.webp")).toEqual(await renderedBytes(images, "plain", "tall.webp"));
    await images.close();
  });

  it("keeps a smaller manual crop that shares the centred cut's top-left corner as a crop", async () => {
    const w = await world();
    addPhotos(w, await photo(1000, 600), ["manual", "plain"]);
    const images = await w.open([SQUARE]);
    expectOk(await images.setFraming("manual", { crops: { "1:1": { x: 0.2, y: 0, w: 0.3, h: 0.5 } } }));
    for (const id of ["manual", "plain"]) expectOk(await images.generate(id));
    const cut = { left: 200, top: 0, width: 300, height: 300 };
    expect(await ratiosOf(images, "manual")).toEqual([{ key: "1:1", manual: true, crop: cut }]);
    expect((await attached(images, "manual")).get("square")).toMatchObject({ state: "done", crop: cut });
    expect(await renderedBytes(images, "manual", "square.webp")).not.toEqual(await renderedBytes(images, "plain", "square.webp"));
    await images.close();
  });

  it("lists a manual crop within a pixel of the centre as null while the framing still names it manual", async () => {
    const w = await world();
    addPhotos(w, await photo(1920, 1281), ["manual", "plain"]);
    const images = await w.open([PHOTO]);
    expectOk(await images.setFraming("manual", { crops: { "3:2": { x: 0, y: 0, w: 1, h: 1280 / 1281 } } }));
    for (const id of ["manual", "plain"]) expectOk(await images.generate(id));
    expect(await ratiosOf(images, "manual")).toEqual([{ key: "3:2", manual: true, crop: null }]);
    expect((await attached(images, "manual")).get("photo")).toMatchObject({ state: "done", crop: null, path: "/media/manual/variants/photo.webp" });
    expect(await renderedBytes(images, "manual", "photo.webp")).toEqual(await renderedBytes(images, "plain", "photo.webp"));
    await images.close();
  });
});
