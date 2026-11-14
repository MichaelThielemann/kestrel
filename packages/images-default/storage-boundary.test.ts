import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { MEDIA } from "@michaelthielemann/kestrel-contracts/media";
import { PERSISTENCE, type Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createMediaDefault, type Config as MediaConfig, type Media } from "@michaelthielemann/kestrel-media-default/impl";
import type { Introspection, Manifest } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createContext, type Step } from "@michaelthielemann/kestrel/context";
import { failure } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import module, { configSchema } from "./module.ts";
import { DEFAULT_RENDER_TIMEOUT_MS, FRAMING, HIDDEN, ITEMS, JOBS, RETIRED, SIZES, VARIANTS, createImages, whenIdle, type Config, type Images } from "./impl.ts";
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

function ownCollectionsOnly(store: Persistence, reached: Set<string>): Persistence {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        const collection = String(args[0]);
        reached.add(collection);
        if (!collection.startsWith("images_")) throw new Error(`images-default reached the collection "${collection}"`);
        return Reflect.apply(value, target, args) as unknown;
      };
    },
  });
}

const quiet: Logger = { step() {}, info() {}, error() {} };
const THUMB: Size = { name: "thumb", width: 32, fit: "inside", format: "webp", quality: 82 };
const HERO: Size = { name: "hero", width: 48, fit: "inside", format: "original", quality: 82 };
const MEDIA_CONFIG: MediaConfig = { allowedTypes: ["*"], deniedTypes: [], maxBytes: 1_000_000, locales: [], prefix: "media/", publicPath: "/media", publicCopy: { prefix: "site/" }, uploadStaleAfterMs: 900000, anonymousList: "ids" };
const IMAGES_CONFIG: Config = { prefix: "media-variants/", publicPath: "/media", publicCopy: { prefix: "site/" }, chunk: 2, staleAfterMs: 60000, maxAttempts: 1, renderTimeoutMs: DEFAULT_RENDER_TIMEOUT_MS };
const renderer: Renderer = async (_data, size, planned) => {
  if (size.name === "card") throw new Error("this size never renders");
  return { data: new Uint8Array([7, size.name.length, planned.width]), width: planned.width, height: planned.height, format: planned.format, ext: planned.format, contentType: `image/${planned.format}` };
};

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

interface Library {
  jpeg: string;
  png: string;
  pdf: string;
  xml: string;
  gif: string;
}

async function upload(media: Media): Promise<Library> {
  const photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#446688" } }).jpeg().toBuffer();
  const drawing = await sharp({ create: { width: 40, height: 60, channels: 3, background: "#884466" } }).png().toBuffer();
  const add = async (filename: string, contentType: string, data: Uint8Array): Promise<string> => expectOk(await media.upload({ filename, contentType, data })).item.id;
  return {
    jpeg: await add("photo.jpg", "image/jpeg", photo),
    png: await add("drawing.png", "image/png", drawing),
    pdf: await add("paper.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.4 minimal")),
    xml: await add("diagram.bin", "image/foo+xml", new TextEncoder().encode("<foo/>")),
    gif: await add("anim.gif", "image/gif", new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0])),
  };
}

function idsOf(library: Library): string[] {
  return [library.jpeg, library.png, library.pdf, library.xml, library.gif];
}

async function readyIds(media: Media, library: Library): Promise<string[]> {
  const ready: string[] = [];
  for (const id of idsOf(library)) if (expectOk(await media.file(id)) !== null) ready.push(id);
  return ready.sort();
}

interface Env {
  store: FakePersistence;
  blobs: MemoryBlobs;
  media: Media;
}

type Opener = (env: Env) => (sizes: Size[]) => Promise<Images>;

function directly(handleFor: (store: FakePersistence) => Persistence): Opener {
  return (env) => {
    const db = handleFor(env.store);
    return (sizes) => createImages({ ...IMAGES_CONFIG, sizes }, { blobs: env.blobs, db, media: env.media, logger: quiet, render: renderer });
  };
}

const throughModuleSetup: Opener = (env) => async (sizes) => {
  const providers = new Map<unknown, unknown>([[BLOBSTORE, env.blobs], [PERSISTENCE, env.store], [MEDIA, env.media]]);
  const config = configSchema.parse({ prefix: "media-variants/", publicPath: "/media", publicCopy: { prefix: "site/" }, chunk: 2, maxAttempts: 1, sizes });
  const deps = {
    get<T>(contract: { name: string }): T {
      if (!providers.has(contract)) throw new Error(`unexpected contract ${contract.name}`);
      return boundaryCast<T>(providers.get(contract), "host");
    },
    find: () => undefined,
    logger: quiet,
    root: process.cwd(),
    eventTriggers: [],
  };
  return boundaryCast<Images>(await module.setup(config, deps), "host");
};

async function removeMany(images: Images, ids: string[]): Promise<void> {
  const steps = boundaryCast<{ removeMany: Step }>(module.steps!(images), "host");
  expectOk(await steps.removeMany({ ...createContext({ trigger: { kind: "http", name: "t" } }), result: { ids } }));
}

async function runLifecycle(opener: Opener, cardRenders: boolean): Promise<void> {
  const store = createFakePersistence();
  const blobs = memoryBlobs();
  const media = await createMediaDefault(MEDIA_CONFIG, blobs, store, quiet);
  const library = await upload(media);
  const all = idsOf(library);
  const open = opener({ store, blobs, media });

  const first = await open([THUMB, HERO]);
  first.attach(introspection);
  await whenIdle(first);
  expectOk(await first.plan(all));
  expect(expectOk(await first.generate(library.png)).map((row) => row.state)).toEqual(["done", "done"]);
  const byItem = expectOk(await first.variantsOf(all));
  expect(Object.fromEntries(all.map((id) => [id, (byItem.get(id) ?? []).map((row) => row.size).sort()]))).toEqual({ [library.jpeg]: ["hero", "thumb"], [library.png]: ["hero", "thumb"], [library.pdf]: [], [library.xml]: [], [library.gif]: [] });
  const counts = expectOk(await first.variantCounts(all));
  expect(counts.get(library.jpeg)).toEqual({ done: 2, pending: 0, error: 0, failed: 0 });
  expect(counts.get(library.gif)).toEqual({ done: 0, pending: 0, error: 0, failed: 0 });
  expect(expectOk(await first.read(library.jpeg, "thumb.webp"))).toMatchObject({ variant: "done", fallback: false });
  expect(expectOk(await first.read(library.pdf, "thumb.webp"))).toBeNull();

  expectOk(await first.register([{ name: "card", width: 40 }]));
  await whenIdle(first);
  expect(expectOk(await first.read(library.jpeg, "card.webp"))).toMatchObject(cardRenders ? { variant: "done", fallback: false } : { variant: "original", fallback: true, contentType: "image/jpeg" });
  expect(expectOk(await first.retryFailed()).variants).toBe(cardRenders ? 0 : 2);
  await whenIdle(first);
  expect(expectOk(await first.retryFailed(library.jpeg)).variants).toBe(cardRenders ? 0 : 1);
  const midway = expectOk(await first.status());
  expect(midway.job).toMatchObject({ state: "done", total: 2 });
  expect(midway.failed.variants).toBe(cardRenders ? 0 : 2);
  await first.close();
  expect(await readyIds(media, library)).toEqual([...all].sort());

  const second = await open([THUMB]);
  second.attach(introspection);
  await whenIdle(second);
  expect(expectOk(await second.prune(["hero", "card"]))).toEqual({ sizes: 2, variants: 4 });
  expect(expectOk(await second.read(library.jpeg, "hero.jpg"))).toMatchObject({ variant: "original" });
  expectOk(await second.resume());
  await whenIdle(second);
  expect(expectOk(await second.syncPublic())).toMatchObject({ missing: 0 });
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "images-boundary-"));
  try {
    expect(expectOk(await second.exportTo(dir)).written).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(["drawing.png.thumb.webp", "photo.jpg.thumb.webp"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(expectOk(await second.status()).sizes.map((size) => [size.name, size.variants.done])).toEqual([["thumb", 2]]);
  expect(expectOk(await second.exists(library.png))).toBe(true);
  expect(expectOk(await second.exists(library.pdf))).toBe(true);

  expectOk(await media.remove(library.png));
  expect(expectOk(await second.exists(library.png))).toBe(false);
  await removeMany(second, [library.png]);
  expectOk(await second.syncPublic());
  await whenIdle(second);
  await second.close();

  expect(await readyIds(media, library)).toEqual([library.jpeg, library.pdf, library.xml, library.gif].sort());
  expect([...blobs.blobs.keys()].filter((key) => key.includes(library.png))).toEqual([]);
  expect(expectOk(await store.count(VARIANTS, { mediaId: library.png }))).toBe(0);
  for (const id of [library.pdf, library.xml, library.gif]) {
    expect(expectOk(await store.count(VARIANTS, { mediaId: id })), id).toBe(0);
    expect([...blobs.blobs.keys()].filter((key) => key.includes(`/${id}/variants/`)), id).toEqual([]);
  }
  expect(expectOk(await store.findMany<{ id: string; size: string; state: string }>(VARIANTS, { mediaId: library.jpeg })).items.map((row) => [row.size, row.state])).toEqual([["thumb", "done"]]);
}

describe("images/default: storage boundary", { timeout: 60_000 }, () => {
  it("reaches no collection but its own through a full lifecycle while media-default's collection holds ready items", async () => {
    const reached = new Set<string>();
    await runLifecycle(directly((store) => ownCollectionsOnly(store, reached)), false);
    expect([...reached].sort()).toEqual([FRAMING, HIDDEN, ITEMS, JOBS, RETIRED, SIZES, VARIANTS].sort());
  });

  it("runs the same lifecycle through the module's own setup on the store that holds media-default's collection, guarded only by the handle setup hands it", async () => {
    await runLifecycle(throughModuleSetup, true);
  });
});

describe("images/default: an interrupted media delete without publicCopy", () => {
  it("leaves nothing of the item after the next start: media-default finishes its row and blob, images-default removes its rows and private variants", async () => {
    const store = createFakePersistence();
    const blobs = memoryBlobs();
    const mediaConfig: MediaConfig = { ...MEDIA_CONFIG, publicCopy: undefined };
    const imagesConfig: Config = { prefix: "media-variants/", publicPath: "/media", chunk: 2, staleAfterMs: 60000, maxAttempts: 1, renderTimeoutMs: DEFAULT_RENDER_TIMEOUT_MS, sizes: [THUMB] };
    const media = await createMediaDefault(mediaConfig, blobs, store, quiet);
    const images = await createImages(imagesConfig, { blobs, db: store, media, logger: quiet, render: renderer });
    const photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#446688" } }).jpeg().toBuffer();
    const item = expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: photo })).item;
    const kept = expectOk(await media.upload({ filename: "kept.jpg", contentType: "image/jpeg", data: photo })).item;
    for (const id of [item.id, kept.id]) expect(expectOk(await images.generate(id)).map((row) => row.state)).toEqual(["done"]);
    const remove = blobs.remove.bind(blobs);
    blobs.remove = async () => err(failure("TRANSIENT", "store down"));
    expect((await media.remove(item.id)).ok).toBe(false);
    blobs.remove = remove;
    await images.close();

    const restarted = await createMediaDefault(mediaConfig, blobs, store, quiet);
    const reopened = await createImages(imagesConfig, { blobs, db: store, media: restarted, logger: quiet, render: renderer });
    reopened.attach(introspection);
    await whenIdle(reopened);
    await reopened.close();

    expect([...blobs.blobs.keys()].filter((key) => key.includes(item.id))).toEqual([]);
    expect(expectOk(await store.count(VARIANTS, { mediaId: item.id }))).toBe(0);
    expect(expectOk(await store.count(VARIANTS, { mediaId: kept.id }))).toBe(1);
    expect(blobs.blobs.has(`media-variants/${kept.id}/thumb.webp`)).toBe(true);
  });
});

describe("images/default and media-default storing under the same prefix", () => {
  it("a deleting media.reconcile keeps every private variant and removes only a key whose id no item has", async () => {
    const store = createFakePersistence();
    const blobs = memoryBlobs();
    const media = await createMediaDefault({ ...MEDIA_CONFIG, publicCopy: undefined, prefix: "media/" }, blobs, store, quiet);
    const images = await createImages({ prefix: "media/", publicPath: "/media", chunk: 2, staleAfterMs: 60000, maxAttempts: 1, renderTimeoutMs: DEFAULT_RENDER_TIMEOUT_MS, sizes: [THUMB] }, { blobs, db: store, media, logger: quiet, render: renderer });
    const photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#446688" } }).jpeg().toBuffer();
    const item = expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: photo })).item;
    expect(expectOk(await images.generate(item.id)).map((row) => row.state)).toEqual(["done"]);
    expect(blobs.blobs.has(`media/${item.id}/thumb.webp`)).toBe(true);
    expectOk(await blobs.put("media/no-such-item/orphan.png", new Uint8Array([1]), { contentType: "image/png" }));

    expect(expectOk(await media.reconcile({ delete: true }))).toEqual({ blobsWithoutRow: ["media/no-such-item/orphan.png"], rowsWithoutBlob: [], legacyKeys: [] });
    expect(blobs.blobs.has(`media/${item.id}/thumb.webp`)).toBe(true);
    expect(blobs.blobs.has(item.key)).toBe(true);
    expect(blobs.blobs.has("media/no-such-item/orphan.png")).toBe(false);
    expect(expectOk(await images.read(item.id, "thumb.webp"))).toMatchObject({ variant: "done" });
    await images.close();
  });
});
