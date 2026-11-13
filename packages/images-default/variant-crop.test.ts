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
import { DEFAULT_RENDER_TIMEOUT_MS, ITEMS, VARIANTS, createImages, whenIdle, type Config, type Images, type ItemLease, type Variant } from "./impl.ts";
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

async function attached(images: Images): Promise<Map<string, AttachedVariant>> {
  const steps = boundaryCast<{ attach: Step }>(module.steps!(images), "host");
  const description = boundaryCast<{ extendsItems: Record<string, unknown> }>(module.describe!(images).attach, "host");
  const single = expectOk(await steps.attach(ctx({ result: { id: "m1", contentType: "image/jpeg" } })));
  expect(validateSchema(description.extendsItems, single.result)).toEqual([]);
  const list = expectOk(await steps.attach(ctx({ result: { items: [{ id: "m1", contentType: "image/jpeg" }] } })));
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
