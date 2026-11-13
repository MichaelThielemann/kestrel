import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import { createFakeMedia, type FakeMedia } from "@michaelthielemann/kestrel-contracts/testing/fakeMedia";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createContext, type Context, type Step } from "@michaelthielemann/kestrel/context";
import { failure } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { validateSchema } from "@michaelthielemann/kestrel/schema";
import module from "./module.ts";
import { DEFAULT_RENDER_TIMEOUT_MS, createImages, type Config, type Images } from "./impl.ts";
import { cropToken, parseCrop } from "./framing.ts";
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
  open(sizes?: Size[], render?: Renderer): Promise<Images>;
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
    open: (sizes = SIZES, render = recording) => createImages({ ...CONFIG, sizes }, { blobs, db, media, logger: quiet, render, events }, () => 1000),
  };
}

const CORNER_FOCUS = { focus: { x: 0, y: 0, w: 0.1, h: 0.1 } };

describe("images/default setFraming and attach steps", () => {
  interface Steps {
    setFraming: Step;
    attach: Step;
  }

  function ctx(patch: Partial<Context>): Context {
    return { ...createContext({ trigger: { kind: "http", name: "t" } }), ...patch };
  }

  it("setFraming reads params.id and the payload and answers { id, framing }", async () => {
    const w = await world();
    const images = await w.open();
    const steps = boundaryCast<Steps>(module.steps!(images), "host");
    const description = boundaryCast<{ input: Record<string, unknown>; output: Record<string, unknown> }>(module.describe!(images).setFraming, "host");
    const done = expectOk(await steps.setFraming(ctx({ params: { id: "m1" }, payload: CORNER_FOCUS, body: CORNER_FOCUS })));
    expect(done.result).toEqual({ id: "m1", framing: { focus: CORNER_FOCUS.focus, crops: {} } });
    expect(validateSchema(description.output, done.result)).toEqual([]);
    expect(validateSchema(description.input, CORNER_FOCUS)).toEqual([]);
    expect(validateSchema(description.input, { focus: null, crops: { "1:1": { x: 0, y: 0, w: 0.6, h: 1 } } })).toEqual([]);
    expect(validateSchema(description.input, { other: 1 })).not.toEqual([]);

    const invalid = await steps.setFraming(ctx({ params: { id: "m1" }, payload: { focus: { x: 3 } } }));
    expectErr(invalid, "VALIDATION");
    expectErr(await steps.setFraming(ctx({ params: { id: "nope" }, payload: CORNER_FOCUS })), "NOT_FOUND");
    expectErr(await steps.setFraming(ctx({ payload: CORNER_FOCUS })), "VALIDATION");
    await images.close();
  });

  it("attach adds focus and framing with one entry per cover ratio, for an item and a list", async () => {
    const w = await world();
    const images = await w.open();
    expectOk(await images.setFraming("m1", { focus: { x: 0, y: 0, w: 0.5, h: 0.2 }, crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } } }));
    expectOk(await images.generate("m1"));
    const steps = boundaryCast<Steps>(module.steps!(images), "host");
    const description = boundaryCast<{ extendsItems: Record<string, unknown> }>(module.describe!(images).attach, "host");

    const single = expectOk(await steps.attach(ctx({ result: { id: "m1", contentType: "image/jpeg" } })));
    const item = boundaryCast<{ focus: unknown; framing: { ratios: unknown[] }; variants: Array<{ size: string; path: string }> }>(single.result, "host");
    expect(item.focus).toEqual({ x: 0, y: 0, w: 0.5, h: 0.2 });
    expect(item.framing).toEqual({
      focus: { x: 0, y: 0, w: 0.5, h: 0.2 },
      crops: { "1:1": { x: 0.4, y: 0, w: 0.6, h: 1 } },
      width: 1000,
      height: 600,
      ratios: [
        { key: "16:9", sizes: ["wide-small", "wide-large"], manual: false, fits: true, crop: { left: 0, top: 0, width: 1000, height: 563 } },
        { key: "1:1", sizes: ["square"], manual: true, fits: false, crop: { left: 400, top: 0, width: 600, height: 600 } },
      ],
    });
    const square = item.variants.find((v) => v.size === "square")!;
    expect(square.path).toBe(`/media/m1/variants/square.webp?v=${cropToken(parseCrop("400,0,600,600")!)}`);
    expect(validateSchema(description.extendsItems, single.result)).toEqual([]);

    const list = expectOk(await steps.attach(ctx({ result: { items: [{ id: "m1", contentType: "image/jpeg" }, { id: "doc", contentType: "application/pdf" }] } })));
    const items = boundaryCast<{ items: Array<Record<string, unknown>> }>(list.result, "host").items;
    expect(items[0]).toMatchObject({ focus: { x: 0, y: 0, w: 0.5, h: 0.2 } });
    expect(items[1]).toMatchObject({ focus: null, framing: { focus: null, crops: {}, width: null, height: null, ratios: [] } });
    for (const entry of items) expect(validateSchema(description.extendsItems, entry)).toEqual([]);
    await images.close();
  });
});
