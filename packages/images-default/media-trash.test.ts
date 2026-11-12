import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createMediaDefault, type Config as MediaConfig } from "@michaelthielemann/kestrel-media-default/impl";
import type { Introspection, Manifest } from "@michaelthielemann/kestrel";
import { failure } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { DEFAULT_RENDER_TIMEOUT_MS, HIDDEN, VARIANTS, createImages, whenIdle, type Config } from "./impl.ts";
import type { Renderer } from "./generate.ts";

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

const quiet: Logger = { step() {}, info() {}, error() {} };
const MEDIA_CONFIG: MediaConfig = { allowedTypes: ["image/*"], deniedTypes: [], maxBytes: 1_000_000, locales: [], prefix: "media/", publicPath: "/media", publicCopy: { prefix: "site/" }, uploadStaleAfterMs: 900000, anonymousList: "ids", trashRetentionDays: 30 };
const IMAGES_CONFIG: Config = { prefix: "media-variants/", publicPath: "/media", publicCopy: { prefix: "site/" }, chunk: 2, staleAfterMs: 60000, maxAttempts: 1, renderTimeoutMs: DEFAULT_RENDER_TIMEOUT_MS, sizes: [{ name: "thumb", width: 32, fit: "inside", format: "webp", quality: 82 }] };
const renderer: Renderer = async (_data, size, planned) => ({ data: new Uint8Array([7, size.name.length, planned.width]), width: planned.width, height: planned.height, format: planned.format, ext: planned.format, contentType: `image/${planned.format}` });
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

describe("images/default with a media-default item in the trash", () => {
  it("keeps the item's variant rows and private variants hidden across a restart of both and images.syncPublic, and serves them again after restore", async () => {
    const store = createFakePersistence();
    const blobs = memoryBlobs();
    const media = await createMediaDefault(MEDIA_CONFIG, blobs, store, quiet);
    const images = await createImages(IMAGES_CONFIG, { blobs, db: store, media, logger: quiet, render: renderer });
    const photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#446688" } }).jpeg().toBuffer();
    const item = expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: photo })).item;
    expect(expectOk(await images.generate(item.id)).map((row) => row.state)).toEqual(["done"]);
    const privateVariant = `media-variants/${item.id}/thumb.webp`;
    expect(blobs.blobs.has(privateVariant)).toBe(true);
    const publicVariant = `site/media/${item.id}/variants/thumb.webp`;
    expect(blobs.blobs.has(publicVariant)).toBe(true);

    const trashed = expectOk(await media.trash([item.id]));
    expect(trashed.ids).toEqual([item.id]);
    expectOk(await images.hide(trashed.ids));
    await images.close();

    const restartedMedia = await createMediaDefault(MEDIA_CONFIG, blobs, store, quiet);
    const restarted = await createImages(IMAGES_CONFIG, { blobs, db: store, media: restartedMedia, logger: quiet, render: renderer });
    restarted.attach(introspection);
    await whenIdle(restarted);
    expectOk(await restarted.syncPublic());
    await whenIdle(restarted);

    expect(expectOk(await store.findMany<{ id: string; size: string; state: string }>(VARIANTS, { mediaId: item.id })).items.map((row) => [row.size, row.state])).toEqual([["thumb", "done"]]);
    expect(blobs.blobs.has(privateVariant)).toBe(true);
    expect(blobs.blobs.has(item.key)).toBe(true);
    expect(expectOk(await restarted.exists(item.id))).toBe(true);
    expect(blobs.blobs.has(publicVariant)).toBe(false);
    expect(expectOk(await restarted.read(item.id, "thumb.webp"))).toBeNull();

    const restored = expectOk(await restartedMedia.restore([item.id]));
    expect(restored.ids).toEqual([item.id]);
    expectOk(await restarted.show(restored.ids));
    expect(expectOk(await restarted.read(item.id, "thumb.webp"))).toMatchObject({ variant: "done", fallback: false });
    expect(blobs.blobs.has(publicVariant)).toBe(true);
    expect(blobs.blobs.has(`site/media/${item.id}/${item.filename}`)).toBe(true);
    await restarted.close();
  });

  it("drops the variants once the item is purged and images-default starts again", async () => {
    const store = createFakePersistence();
    const blobs = memoryBlobs();
    const media = await createMediaDefault(MEDIA_CONFIG, blobs, store, quiet);
    const images = await createImages(IMAGES_CONFIG, { blobs, db: store, media, logger: quiet, render: renderer });
    const photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#884466" } }).jpeg().toBuffer();
    const item = expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: photo })).item;
    expectOk(await images.generate(item.id));
    expectOk(await images.hide(expectOk(await media.trash([item.id])).ids));
    expect(expectOk(await media.purge([item.id])).ids).toEqual([item.id]);
    await images.close();

    const restarted = await createImages(IMAGES_CONFIG, { blobs, db: store, media, logger: quiet, render: renderer });
    restarted.attach(introspection);
    await whenIdle(restarted);
    await restarted.close();

    expect(expectOk(await store.count(VARIANTS, { mediaId: item.id }))).toBe(0);
    expect(expectOk(await store.count(HIDDEN, { mediaId: item.id }))).toBe(0);
    expect([...blobs.blobs.keys()].filter((key) => key.includes(item.id))).toEqual([]);
  });
});
