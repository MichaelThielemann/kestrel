import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { failure } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { createMediaDefault, type Config } from "./impl.ts";
import { exifOrientation } from "./stripMetadata.ts";

const enc = new TextEncoder();
const bytes = (...parts: Array<number[] | string>): Uint8Array => Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...enc.encode(p)] : p)));
const segment = (marker: number, payload: Uint8Array): number[] => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const gpsExif = (orientation: number): Uint8Array =>
  bytes("Exif\0\0MM\0*", [0, 0, 0, 8, 0, 2, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0x26, 0, 0, 0, 0], "GPSLatitude-52.5200N");

function jpeg(orientation = 1): Uint8Array {
  const sof = bytes([8, 0, 48, 0, 64, 1, 1, 0x11, 0]);
  const sos = bytes([1, 1, 0, 0, 63, 0]);
  return bytes([0xff, 0xd8], segment(0xe1, gpsExif(orientation)), segment(0xc0, sof), segment(0xda, sos), [0x12, 0x34], [0xff, 0xd9]);
}

function fakeBlobstore(): Blobstore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    async put(key, data) { blobs.set(key, data); return ok(); },
    async get(key) { return ok(blobs.get(key) ?? null); },
    async remove(key) { blobs.delete(key); return ok(); },
    async move(from, to) { const b = blobs.get(from); if (!b) return err(failure("NOT_FOUND", from)); blobs.set(to, b); blobs.delete(from); return ok(); },
    async list(prefix) { return ok([...blobs].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.byteLength }))); },
  };
}

const CONFIG: Config = { allowedTypes: ["image/*"], deniedTypes: [], maxBytes: 4096, locales: [], prefix: "media/", publicPath: "/media", uploadStaleAfterMs: 900000, anonymousList: "ids" };
const containsGps = (data: Uint8Array): boolean => Buffer.from(data).includes("GPSLatitude");

async function setup(config: Config = CONFIG) {
  const store = fakeBlobstore();
  const warnings: string[] = [];
  const logger: Logger = { step() {}, info() {}, error() {}, warn: (m) => warnings.push(m) };
  const media = await createMediaDefault(config, store, createFakePersistence(), logger, () => 7);
  return { media, blobs: store.blobs, warnings };
}

describe("media.upload removes image metadata", () => {
  it("stores a JPEG without its GPS position and records the stored size and dimensions", async () => {
    const { media, blobs } = await setup();
    const source = jpeg();
    const { item } = expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: source }));
    const stored = [...blobs.values()];
    expect(stored).toHaveLength(1);
    expect(containsGps(stored[0]!)).toBe(false);
    expect(item.size).toBe(stored[0]!.byteLength);
    expect(item.size).toBeLessThan(source.byteLength);
    expect({ width: item.width, height: item.height }).toEqual({ width: 64, height: 48 });
  });

  it("keeps the orientation of a rotated photo", async () => {
    const { media, blobs } = await setup();
    expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: jpeg(6) }));
    expect(exifOrientation([...blobs.values()][0]!)).toBe(6);
  });

  it("writes the public copy without the metadata as well", async () => {
    const { media, blobs } = await setup({ ...CONFIG, publicCopy: { prefix: "site/" } });
    expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: jpeg() }));
    expect([...blobs.keys()].filter((k) => k.startsWith("site/"))).toHaveLength(1);
    for (const data of blobs.values()) expect(containsGps(data)).toBe(false);
  });

  it("answers the same bytes uploaded again as the item that is already there", async () => {
    const { media } = await setup();
    const first = expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: jpeg() }));
    const again = expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: jpeg() }));
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.item.id).toBe(first.item.id);
  });

  it("answers a file stored with its metadata as the existing item once stripping is on", async () => {
    const store = fakeBlobstore();
    const persistence = createFakePersistence();
    const logger: Logger = { step() {}, info() {}, error() {}, warn() {} };
    const before = await createMediaDefault({ ...CONFIG, stripImageMetadata: false }, store, persistence, logger, () => 7);
    const after = await createMediaDefault(CONFIG, store, persistence, logger, () => 7);
    const first = expectOk(await before.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: jpeg() }));
    const again = expectOk(await after.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: jpeg() }));
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.item.id).toBe(first.item.id);
    expect(store.blobs.size).toBe(1);
  });

  it("answers a file stored without its metadata as the existing item once stripping is off", async () => {
    const store = fakeBlobstore();
    const persistence = createFakePersistence();
    const logger: Logger = { step() {}, info() {}, error() {}, warn() {} };
    const stripping = await createMediaDefault(CONFIG, store, persistence, logger, () => 7);
    const sending = await createMediaDefault({ ...CONFIG, stripImageMetadata: false }, store, persistence, logger, () => 7);
    const first = expectOk(await stripping.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: jpeg() }));
    const again = expectOk(await sending.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: jpeg() }));
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.item.id).toBe(first.item.id);
    expect(store.blobs.size).toBe(1);
  });

  it("still rejects different bytes at an occupied location", async () => {
    const { media } = await setup();
    expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: jpeg(1) }));
    const other = await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: jpeg(1).slice(0, -3) });
    expect(other.ok).toBe(false);
  });

  it("rejects a file that differs only in its metadata when stripping is off and the stored copy was stripped", async () => {
    const store = fakeBlobstore();
    const persistence = createFakePersistence();
    const logger: Logger = { step() {}, info() {}, error() {}, warn() {} };
    const stripping = await createMediaDefault(CONFIG, store, persistence, logger, () => 7);
    const sending = await createMediaDefault({ ...CONFIG, stripImageMetadata: false }, store, persistence, logger, () => 7);
    expectOk(await stripping.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: jpeg() }));
    const sentWithOtherMetadata = bytes([0xff, 0xd8], segment(0xfe, bytes("Credit-B")), [...jpeg().subarray(2)]);
    const result = await sending.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: sentWithOtherMetadata });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
    expect(store.blobs.size).toBe(1);
  });

  it("answers a file that differs only in its metadata as the existing item while stripping is on", async () => {
    const { media, blobs } = await setup();
    const first = expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: jpeg() }));
    const sentWithOtherMetadata = bytes([0xff, 0xd8], segment(0xfe, bytes("Credit-B")), [...jpeg().subarray(2)]);
    const again = expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: sentWithOtherMetadata }));
    expect(again.created).toBe(false);
    expect(again.item.id).toBe(first.item.id);
    expect(blobs.size).toBe(1);
  });

  it("stores the bytes as sent when stripImageMetadata is false", async () => {
    const { media, blobs } = await setup({ ...CONFIG, stripImageMetadata: false });
    const source = jpeg();
    const { item } = expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: source }));
    expect(Array.from([...blobs.values()][0]!)).toEqual(Array.from(source));
    expect(item.size).toBe(source.byteLength);
  });

  it("stores a JPEG that cannot be walked as sent and warns", async () => {
    const { media, blobs, warnings } = await setup();
    const broken = bytes([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff], "Exif\0\0GPSLatitude");
    expectOk(await media.upload({ filename: "broken.jpg", contentType: "image/jpeg", data: broken }));
    expect(Array.from([...blobs.values()][0]!)).toEqual(Array.from(broken));
    expect(warnings.some((w) => w.includes("could not remove the metadata"))).toBe(true);
  });

  it("stores a JPEG with a stray byte between two segments without its GPS position", async () => {
    const { media, blobs, warnings } = await setup();
    const source = jpeg();
    const sof = source.findIndex((b, i) => b === 0xff && source[i + 1] === 0xc0);
    const withStray = bytes([...source.subarray(0, sof)], [0x00], [...source.subarray(sof)]);
    expectOk(await media.upload({ filename: "photo.jpg", contentType: "image/jpeg", data: withStray }));
    expect(containsGps([...blobs.values()][0]!)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("removes the metadata of a raster image whose declared type is not an image type", async () => {
    const { media, blobs } = await setup({ ...CONFIG, allowedTypes: ["*"] });
    const { item } = expectOk(await media.upload({ filename: "photo.jpg", contentType: "application/octet-stream", data: jpeg() }));
    expect(item.contentType).toBe("application/octet-stream");
    expect(containsGps([...blobs.values()][0]!)).toBe(false);
    expect(item.size).toBe([...blobs.values()][0]!.byteLength);
  });

  it("leaves files that are not rasters alone", async () => {
    const { media, blobs } = await setup({ ...CONFIG, allowedTypes: ["*"] });
    const pdf = bytes("%PDF-1.7\nGPSLatitude");
    expectOk(await media.upload({ filename: "doc.pdf", contentType: "application/pdf", data: pdf }));
    expect(Array.from([...blobs.values()][0]!)).toEqual(Array.from(pdf));
  });
});
