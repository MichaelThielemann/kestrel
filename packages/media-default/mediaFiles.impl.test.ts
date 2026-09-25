import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { mediaContractTests } from "@michaelthielemann/kestrel-contracts/media.contract.test";
import type { Document } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { failure } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { COLLECTION, createMediaDefault, keyFor, type Config, type Media } from "./impl.ts";

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
const CONFIG: Config = { allowedTypes: ["*"], deniedTypes: [], maxBytes: 100_000, locales: [], prefix: "media/", publicPath: "/media", uploadStaleAfterMs: 900000, anonymousList: "ids" };
const WITH_COPY: Config = { ...CONFIG, publicCopy: { prefix: "site/" } };

mediaContractTests(async () => {
  const blobs = memoryBlobs();
  const db = createFakePersistence();
  const media = await createMediaDefault(CONFIG, blobs, db, quiet);
  return {
    media,
    reopen: () => createMediaDefault(CONFIG, blobs, db, quiet),
    seed: {
      async add(file) {
        return expectOk(await media.upload({ filename: file.filename, contentType: file.contentType, data: file.data }, file.folder ?? "")).item.id;
      },
      async pending(file) {
        const id = `pending-${file.filename.replace(/[^A-Za-z0-9]/g, "-")}`;
        const key = `media/${id}/${file.filename}`;
        expectOk(await db.createOne<Document>(COLLECTION, { id, filename: file.filename, folder: "", location: keyFor("", file.filename), contentType: file.contentType, size: file.data.byteLength, key, checksum: null, status: "uploading", createdAt: Date.now(), updatedAt: Date.now(), provenance: { origin: "unknown" }, width: null, height: null, alt: {}, title: {}, description: {}, svgSanitized: false }));
        expectOk(await blobs.put(key, file.data, { contentType: file.contentType }));
        return id;
      },
      async removing(id) {
        expectOk(await db.updateOne(COLLECTION, id, { status: "removing" }));
      },
      async remove(id) {
        expectOk(await media.remove(id));
      },
    },
  };
});

interface Sample {
  call: string;
  file: boolean;
  load: boolean;
  scanned: boolean;
  served: boolean;
}

async function sampleAt(media: Media, id: string, name: string, call: string): Promise<Sample> {
  const scan = expectOk(await media.scan({}, { limit: 500 }));
  return {
    call,
    file: expectOk(await media.file(id)) !== null,
    load: expectOk(await media.load(id)) !== null,
    scanned: scan.items.some((file) => file.id === id),
    served: expectOk(await media.serveFile(id, name)) !== null,
  };
}

function watchCalls(blobs: MemoryBlobs, db: FakePersistence, onCall: (call: string) => Promise<void>): () => void {
  let sampling = false;
  const restore: Array<() => void> = [];
  const wrap = (target: object, methods: readonly string[], label: string): void => {
    const mutable = boundaryCast<Record<string, (...args: unknown[]) => Promise<unknown>>>(target, "host");
    for (const method of methods) {
      const original = mutable[method]!;
      mutable[method] = async (...args: unknown[]) => {
        if (!sampling) {
          sampling = true;
          try {
            await onCall(`${label}.${method}(${String(args[0])})`);
          } finally {
            sampling = false;
          }
        }
        return original.apply(target, args);
      };
      restore.push(() => {
        mutable[method] = original;
      });
    }
  };
  wrap(blobs, ["put", "get", "remove", "list"], "blobs");
  wrap(db, ["findOne", "findMany", "count", "updateOne", "updateMany", "deleteOne", "deleteMany"], "db");
  return () => {
    for (const undo of restore) undo();
  };
}

describe("media/default: a delete ends readiness before it removes a byte", () => {
  it("from its first write on, before every further store call of media.remove, the item is invisible to file, load, scan and media.serve", async () => {
    const blobs = memoryBlobs();
    const db = createFakePersistence();
    const media = await createMediaDefault(WITH_COPY, blobs, db, quiet);
    const item = expectOk(await media.upload({ filename: "photo.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) })).item;
    const name = item.key.slice(item.key.lastIndexOf("/") + 1);
    const samples: Sample[] = [];
    const stop = watchCalls(blobs, db, async (call) => {
      samples.push(await sampleAt(media, item.id, name, call));
    });
    expectOk(await media.remove(item.id));
    stop();
    const firstWrite = samples.findIndex((sample) => sample.call.startsWith("db.update"));
    const firstRemoval = samples.findIndex((sample) => sample.call.startsWith("blobs.remove"));
    expect(firstWrite).toBeGreaterThanOrEqual(0);
    expect(firstRemoval).toBeGreaterThan(firstWrite);
    expect(samples[firstWrite]).toMatchObject({ file: true, load: true, scanned: true, served: true });
    for (const sample of samples.slice(firstWrite + 1)) expect(sample, sample.call).toMatchObject({ file: false, load: false, scanned: false, served: false });
    for (const sample of samples) expect(!sample.file || sample.load, `${sample.call}: a ready file whose bytes load answers null`).toBe(true);
  });

  it("a delete that fails midway leaves the item invisible, and repeating it finishes it", async () => {
    const blobs = memoryBlobs();
    const db = createFakePersistence();
    const media = await createMediaDefault(WITH_COPY, blobs, db, quiet);
    const item = expectOk(await media.upload({ filename: "photo.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) })).item;
    const remove = blobs.remove.bind(blobs);
    blobs.remove = async () => err(failure("TRANSIENT", "store down"));
    expectErr(await media.remove(item.id), "TRANSIENT");
    blobs.remove = remove;
    expect(expectOk(await media.file(item.id))).toBeNull();
    expect(expectOk(await media.get(item.id))).toBeNull();
    expect(expectOk(await media.read(item.id))).toBeNull();
    expect(expectOk(await media.count({}))).toBe(0);
    expect(blobs.blobs.has(item.key)).toBe(true);
    expectOk(await media.remove(item.id));
    expect(expectOk(await db.count(COLLECTION, {}))).toBe(0);
    expect([...blobs.blobs.keys()]).toEqual([]);
  });

  it("an upload to the same location finishes an interrupted delete", async () => {
    const blobs = memoryBlobs();
    const db = createFakePersistence();
    const media = await createMediaDefault(WITH_COPY, blobs, db, quiet);
    const first = expectOk(await media.upload({ filename: "photo.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) })).item;
    const remove = blobs.remove.bind(blobs);
    blobs.remove = async () => err(failure("TRANSIENT", "store down"));
    expectErr(await media.remove(first.id), "TRANSIENT");
    blobs.remove = remove;
    const again = expectOk(await media.upload({ filename: "photo.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) }));
    expect(again.created).toBe(true);
    expect(again.item.id).not.toBe(first.id);
    expect(expectOk(await db.findOne(COLLECTION, { id: first.id }))).toBeNull();
    expect([...blobs.blobs.keys()].filter((key) => key.includes(first.id))).toEqual([]);
    expect(expectOk(await media.file(again.item.id))).not.toBeNull();
  });

  it("media.syncPublic finishes an interrupted delete, copy, blob and row", async () => {
    const blobs = memoryBlobs();
    const db = createFakePersistence();
    const media = await createMediaDefault(WITH_COPY, blobs, db, quiet);
    const kept = expectOk(await media.upload({ filename: "kept.png", contentType: "image/png", data: new Uint8Array([4]) })).item;
    const item = expectOk(await media.upload({ filename: "photo.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) })).item;
    const remove = blobs.remove.bind(blobs);
    blobs.remove = async () => err(failure("TRANSIENT", "store down"));
    expectErr(await media.remove(item.id), "TRANSIENT");
    blobs.remove = remove;
    const synced = expectOk(await media.syncPublic());
    expect(synced.removed).toBe(1);
    expect(expectOk(await db.findOne(COLLECTION, { id: item.id }))).toBeNull();
    expect([...blobs.blobs.keys()].filter((key) => key.includes(item.id))).toEqual([]);
    expect(expectOk(await media.file(kept.id))).not.toBeNull();
  });

  it("media.serve and media.download answer nothing, instead of failing, when the bytes go while they read the item", async () => {
    const blobs = memoryBlobs();
    const db = createFakePersistence();
    const media = await createMediaDefault(WITH_COPY, blobs, db, quiet);
    const item = expectOk(await media.upload({ filename: "photo.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) })).item;
    const name = item.key.slice(item.key.lastIndexOf("/") + 1);
    const get = blobs.get.bind(blobs);
    let armed = true;
    blobs.get = async (key) => {
      if (armed && key === item.key) {
        armed = false;
        expectOk(await media.remove(item.id));
      }
      return get(key);
    };
    expect(expectOk(await media.serveFile(item.id, name))).toBeNull();
    const second = expectOk(await media.upload({ filename: "other.png", contentType: "image/png", data: new Uint8Array([5]) })).item;
    armed = true;
    blobs.get = async (key) => {
      if (armed && key === second.key) {
        armed = false;
        expectOk(await media.remove(second.id));
      }
      return get(key);
    };
    expect(expectOk(await media.read(second.id))).toBeNull();
  });

  it("load answers null without logging when the bytes go because a delete began, and logs a ready file whose bytes are lost", async () => {
    const blobs = memoryBlobs();
    const db = createFakePersistence();
    const errors: Array<{ message: string; fields: unknown }> = [];
    const logger: Logger = { step() {}, info() {}, error: (message, fields) => errors.push({ message, fields }) };
    const media = await createMediaDefault(CONFIG, blobs, db, logger);
    const leaving = expectOk(await media.upload({ filename: "leaving.png", contentType: "image/png", data: new Uint8Array([1]) })).item;
    const get = blobs.get.bind(blobs);
    blobs.get = async (key) => {
      if (key === leaving.key) expectOk(await media.remove(leaving.id));
      return get(key);
    };
    expect(expectOk(await media.load(leaving.id))).toBeNull();
    expect(errors).toEqual([]);
    blobs.get = get;
    const lost = expectOk(await media.upload({ filename: "lost.png", contentType: "image/png", data: new Uint8Array([2]) })).item;
    blobs.blobs.delete(lost.key);
    expect(expectOk(await media.file(lost.id))).not.toBeNull();
    expect(expectOk(await media.load(lost.id))).toBeNull();
    expect(errors).toEqual([{ message: `media/default: the stored bytes of ready item ${lost.id} are missing`, fields: { id: lost.id, key: lost.key } }]);
  });
});

describe("media/default: media@1 answers", () => {
  it("publishes a file with the type media.serve sends, and describes its stored dimensions", async () => {
    const blobs = memoryBlobs();
    const media = await createMediaDefault(CONFIG, blobs, createFakePersistence(), quiet);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
    const image = expectOk(await media.upload({ filename: "dot.png", contentType: "image/png", data: png })).item;
    const svg = expectOk(await media.upload({ filename: "logo.svg", contentType: "image/svg+xml", data: new TextEncoder().encode("<svg/>") })).item;
    expect(expectOk(await media.file(image.id))).toMatchObject({ contentType: "image/png", publishedType: "image/png", width: 3, height: 2, size: png.byteLength, folder: "", filename: image.filename, createdAt: image.createdAt });
    expect(expectOk(await media.file(svg.id))).toMatchObject({ contentType: "image/svg+xml", publishedType: "application/octet-stream" });
  });

  it("answers a failed upload as not ready", async () => {
    const blobs = memoryBlobs();
    const db = createFakePersistence();
    const media = await createMediaDefault(CONFIG, blobs, db, quiet);
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: new Uint8Array([1]) })).item;
    expectOk(await db.updateOne(COLLECTION, item.id, { status: "failed" }));
    expect(expectOk(await media.file(item.id))).toBeNull();
    expect(expectOk(await media.files([item.id]))).toEqual([]);
    expect(expectOk(await media.count({ types: ["image/png"] }))).toBe(0);
  });

  it("passes a TRANSIENT store failure through as TRANSIENT", async () => {
    const db = createFakePersistence();
    const media = await createMediaDefault(CONFIG, memoryBlobs(), db, quiet);
    db.failNext("TRANSIENT");
    expectErr(await media.file("x"), "TRANSIENT");
    db.failNext("TRANSIENT");
    expectErr(await media.scan({}, { limit: 10 }), "TRANSIENT");
    db.failNext("TRANSIENT");
    expectErr(await media.count({ excludeTypes: ["image/gif"] }), "TRANSIENT");
  });
});
