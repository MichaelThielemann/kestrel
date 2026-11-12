import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Document, Filter, FindOptions } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { failure } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { COLLECTION, FOLDERS, createMediaDefault, type Config, type Media } from "./impl.ts";

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
const DAY = 86_400_000;
const CONFIG: Config = { allowedTypes: ["*"], deniedTypes: [], maxBytes: 1000, locales: ["de", "en"], defaultLocale: "de", prefix: "media/", publicPath: "/media", publicCopy: { prefix: "site/" }, uploadStaleAfterMs: 900000, anonymousList: "ids", trashRetentionDays: 30 };

interface Env {
  media: Media;
  blobs: MemoryBlobs;
  db: FakePersistence;
  clock: { now: number };
  reopen: () => Promise<Media>;
}

async function setup(overrides: Partial<Config> = {}): Promise<Env> {
  const blobs = memoryBlobs();
  const db = createFakePersistence();
  const clock = { now: 1_000 };
  const config = { ...CONFIG, ...overrides };
  const media = await createMediaDefault(config, blobs, db, quiet, () => clock.now);
  return { media, blobs, db, clock, reopen: () => createMediaDefault(config, blobs, db, quiet, () => clock.now) };
}

const bytes = (n: number): Uint8Array => new Uint8Array([n, n + 1, n + 2]);

async function put(media: Media, filename: string, folder = "", data: Uint8Array = bytes(filename.length)) {
  return expectOk(await media.upload({ filename, contentType: "image/png", data }, folder)).item;
}

const copyKeyOf = (id: string, name: string): string => `site/media/${id}/${name}`;

async function rowOf(db: FakePersistence, id: string): Promise<Record<string, unknown> | null> {
  return expectOk(await db.findOne<{ id: string }>(COLLECTION, { id }));
}

describe("media/default trash: the library no longer shows a trashed item", () => {
  it("drops it from get, list (plain, text query, kind, recursive), byIds, read, serveFile, folders, folderItems and the folder count", async () => {
    const { media, blobs } = await setup();
    const kept = await put(media, "kept.png", "photos/2024");
    const gone = await put(media, "gone.png", "photos/2024");
    const alone = await put(media, "alone.png", "solo");
    expect(expectOk(await media.trash([gone.id, alone.id]))).toEqual({ ids: [gone.id, alone.id], unchanged: [], skipped: [], versions: { [gone.id]: 1, [alone.id]: 1 } });

    expect(expectOk(await media.get(gone.id))).toBeNull();
    expect(expectOk(await media.list()).items.map((i) => i.id)).toEqual([kept.id]);
    expect(expectOk(await media.list()).total).toBe(1);
    expect(expectOk(await media.list({ q: "gone" })).total).toBe(0);
    expect(expectOk(await media.list({ mediaKind: "image" })).total).toBe(1);
    expect(expectOk(await media.list({ mediaKind: "other" })).total).toBe(0);
    expect(expectOk(await media.list({ folder: "photos", recursive: true })).items.map((i) => i.id)).toEqual([kept.id]);
    expect(expectOk(await media.byIds([gone.id, kept.id])).map((i) => i.id)).toEqual([kept.id]);
    expect(expectOk(await media.read(gone.id))).toBeNull();
    expect(expectOk(await media.serveFile(gone.id, gone.filename))).toBeNull();
    expect(expectOk(await media.folders())).toEqual([{ folder: "photos", count: 0 }, { folder: "photos/2024", count: 1 }, { folder: "solo", count: 0 }]);
    expect(expectOk(await media.folderItems("photos", true))).toEqual({ path: "photos", ids: [kept.id] });
    expect(expectOk(await media.folderItems("solo", false))).toEqual({ path: "solo", ids: [] });
    expect(expectOk(await media.createFolder("photos/2024"))).toEqual({ folder: "photos/2024", count: 1 });
    expect(blobs.blobs.has(copyKeyOf(gone.id, gone.filename))).toBe(false);
    expect(blobs.blobs.has(copyKeyOf(kept.id, kept.filename))).toBe(true);
    expect(blobs.blobs.has(gone.key)).toBe(true);
  });

  it("leaves it out of the export", async () => {
    const { media } = await setup();
    await put(media, "kept.png");
    const gone = await put(media, "gone.png");
    expectOk(await media.trash([gone.id]));
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "media-trash-export-"));
    try {
      expect(expectOk(await media.exportTo(dir)).written).toBe(1);
      expect(await readdir(dir)).toEqual(["kept.png"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps it available to media@1: file, files, load (with its bytes), scan and count", async () => {
    const { media } = await setup();
    const kept = await put(media, "kept.png");
    const gone = await put(media, "gone.png");
    expectOk(await media.trash([gone.id]));

    expect(expectOk(await media.file(gone.id))).toMatchObject({ id: gone.id, filename: "gone.png" });
    expect(expectOk(await media.files([gone.id, kept.id])).map((f) => f.id)).toEqual([gone.id, kept.id]);
    expect(expectOk(await media.load(gone.id))?.data).toEqual(bytes("gone.png".length));
    expect(expectOk(await media.scan({}, { limit: 10 })).items.map((f) => f.id).sort()).toEqual([gone.id, kept.id].sort());
    expect(expectOk(await media.count({}))).toBe(2);
    expect(expectOk(await media.count({ types: ["image/*"] }))).toBe(2);
    expect(expectOk(await media.count({ excludeTypes: ["video/*"] }))).toBe(2);
  });

  it("hands an already trashed id on in ids and names it unchanged, skips an unknown id, and removes the public copy again for a trashed one", async () => {
    const { media, blobs } = await setup();
    const item = await put(media, "a.png");
    expectOk(await media.trash([item.id]));
    expectOk(await blobs.put(copyKeyOf(item.id, item.filename), new Uint8Array([1]), { contentType: "image/png" }));
    expect(expectOk(await media.trash([item.id, "no-such-id"]))).toEqual({ ids: [item.id], unchanged: [item.id], skipped: [{ id: "no-such-id", reason: "not_found" }], versions: { [item.id]: 1 } });
    expect(blobs.blobs.has(copyKeyOf(item.id, item.filename))).toBe(false);
  });

  it("refuses update of a trashed item as not found", async () => {
    const { media } = await setup();
    const item = await put(media, "a.png");
    expectOk(await media.trash([item.id]));
    expect(expectOk(await media.update(item.id, { filename: "b.png", alt: "x" }))).toBeNull();
    expect(expectOk(await media.listTrash()).items).toMatchObject([{ id: item.id, filename: "a.png", alt: null }]);
  });
});

describe("media/default trash and restore repeated after a partial failure", () => {
  it("a repeated trash hands every id that is trashed on in ids, also those the failed run already moved", async () => {
    const { media, db } = await setup();
    const a = await put(media, "a.png");
    const b = await put(media, "b.png");
    const updateMany = db.updateMany.bind(db);
    let failed = false;
    db.updateMany = async (collection, filter, patch) => {
      if (!failed && collection === COLLECTION && (filter as Record<string, unknown>).id === b.id) {
        failed = true;
        return err(failure("TRANSIENT", "store busy"));
      }
      return updateMany(collection, filter, patch);
    };
    expectErr(await media.trash([a.id, b.id]), "TRANSIENT");
    expect((await rowOf(db, a.id))?.status).toBe("trashed");
    expect(expectOk(await media.trash([a.id, b.id]))).toEqual({ ids: [a.id, b.id], unchanged: [a.id], skipped: [], versions: { [a.id]: 1, [b.id]: 1 } });
  });

  it("a repeated restore hands every id that is ready on in ids, also those the failed run already brought back", async () => {
    const { media, db } = await setup();
    const a = await put(media, "a.png");
    const b = await put(media, "b.png");
    expectOk(await media.trash([a.id, b.id]));
    const updateMany = db.updateMany.bind(db);
    let failed = false;
    db.updateMany = async (collection, filter, patch) => {
      if (!failed && collection === COLLECTION && (filter as Record<string, unknown>).id === b.id) {
        failed = true;
        return err(failure("TRANSIENT", "store busy"));
      }
      return updateMany(collection, filter, patch);
    };
    expectErr(await media.restore([a.id, b.id]), "TRANSIENT");
    expect((await rowOf(db, a.id))?.status).toBe("ready");
    expect(expectOk(await media.restore([a.id, b.id]))).toEqual({ ids: [a.id, b.id], unchanged: [a.id], skipped: [], renamed: [], versions: { [a.id]: 2, [b.id]: 2 } });
  });

  it("a repeated trashFolder hands on the items it trashed, also when the folder is gone", async () => {
    const { media } = await setup();
    const a = await put(media, "a.png", "trip");
    const b = await put(media, "b.png", "trip/day1");
    expectOk(await media.trashFolder("trip"));
    expect(expectOk(await media.trashFolder("trip"))).toEqual({ path: "trip", ids: [a.id, b.id], unchanged: [a.id, b.id], versions: { [a.id]: 1, [b.id]: 1 } });
    expect(expectOk(await media.trashFolder("trip/day1"))).toEqual({ path: "trip/day1", ids: [b.id], unchanged: [b.id], versions: { [b.id]: 1 } });
  });

  it("a trashFolder repeated after a public copy could not be removed hands on the items the failed run trashed", async () => {
    const { media, blobs, db } = await setup();
    const a = await put(media, "a.png", "trip");
    const b = await put(media, "b.png", "trip");
    const c = await put(media, "c.png", "trip");
    const all = [a.id, b.id, c.id];
    const remove = blobs.remove.bind(blobs);
    let failed = false;
    blobs.remove = async (key) => {
      if (!failed && key === copyKeyOf(b.id, b.filename)) {
        failed = true;
        return err(failure("TRANSIENT", "store busy"));
      }
      return remove(key);
    };
    expectErr(await media.trashFolder("trip"), "TRANSIENT");
    const trashedBefore: string[] = [];
    for (const id of all) if ((await rowOf(db, id))?.status === "trashed") trashedBefore.push(id);
    expect(trashedBefore).toContain(b.id);
    const again = expectOk(await media.trashFolder("trip"));
    expect([...(again?.ids ?? [])].sort()).toEqual([...all].sort());
    expect([...(again?.unchanged ?? [])].sort()).toEqual([...trashedBefore].sort());
  });

  it("a trashFolder repeated after its folder rows could not be dropped hands on every item it trashed", async () => {
    const { media, db } = await setup();
    const a = await put(media, "a.png", "trip");
    const b = await put(media, "b.png", "trip/day1");
    const deleteMany = db.deleteMany.bind(db);
    let failed = false;
    db.deleteMany = async (collection, filter) => {
      if (!failed && collection === FOLDERS) {
        failed = true;
        return err(failure("TRANSIENT", "store busy"));
      }
      return deleteMany(collection, filter);
    };
    expectErr(await media.trashFolder("trip"), "TRANSIENT");
    expect(expectOk(await media.trashFolder("trip"))).toEqual({ path: "trip", ids: [a.id, b.id], unchanged: [a.id, b.id], versions: { [a.id]: 1, [b.id]: 1 } });
    expect(expectOk(await media.folders())).toEqual([]);
  });
});

describe("media/default writes that race a trash", () => {
  it("update of an item trashed while the update runs answers not found and leaves the name free", async () => {
    const { media, db } = await setup();
    const item = await put(media, "a.png", "box");
    const findOne = db.findOne.bind(db);
    let trashedMidway = false;
    db.findOne = async <T extends Document>(collection: string, filter: Filter) => {
      if (!trashedMidway && collection === COLLECTION && filter.location === "box/b.png") {
        trashedMidway = true;
        expectOk(await media.trash([item.id]));
      }
      return findOne<T>(collection, filter);
    };
    expect(expectOk(await media.update(item.id, { filename: "b.png" }))).toBeNull();
    expect(trashedMidway).toBe(true);
    expect(await rowOf(db, item.id)).toMatchObject({ status: "trashed", location: null, filename: "a.png" });
    expect((await put(media, "b.png", "box")).location).toBe("box/b.png");
  });

  it("renameFolder moves an item trashed while the rename runs without giving it a location", async () => {
    const { media, db } = await setup();
    const item = await put(media, "a.png", "old");
    const findOne = db.findOne.bind(db);
    let trashedMidway = false;
    db.findOne = async <T extends Document>(collection: string, filter: Filter) => {
      if (!trashedMidway && collection === COLLECTION && filter.location === "new/a.png") {
        trashedMidway = true;
        expectOk(await media.trash([item.id]));
      }
      return findOne<T>(collection, filter);
    };
    expectOk(await media.renameFolder("old", "new"));
    expect(trashedMidway).toBe(true);
    expect(await rowOf(db, item.id)).toMatchObject({ status: "trashed", location: null, folder: "new" });
    expect((await put(media, "a.png", "new")).location).toBe("new/a.png");
  });

  it("trash keeps the public copy of an item restored while its copy is removed", async () => {
    const { media, blobs } = await setup();
    const item = await put(media, "a.png");
    const key = copyKeyOf(item.id, item.filename);
    const remove = blobs.remove.bind(blobs);
    let restoredMidway = false;
    blobs.remove = async (removed) => {
      if (!restoredMidway && removed === key) {
        restoredMidway = true;
        expectOk(await media.restore([item.id]));
      }
      return remove(removed);
    };
    expectOk(await media.trash([item.id]));
    expect(restoredMidway).toBe(true);
    expect(expectOk(await media.get(item.id))).not.toBeNull();
    expect(blobs.blobs.has(key)).toBe(true);
  });
});

describe("media/default trash: the name is free at once", () => {
  it("accepts an upload of the same name into the same folder, and a later restore takes the next free name, keeping key and path", async () => {
    const { media, blobs } = await setup();
    const first = await put(media, "photo.png", "album", bytes(1));
    expectOk(await media.trash([first.id]));
    const second = await put(media, "photo.png", "album", bytes(9));
    expect(second.id).not.toBe(first.id);

    const restored = expectOk(await media.restore([first.id]));
    expect(restored).toEqual({ ids: [first.id], unchanged: [], skipped: [], renamed: [{ id: first.id, from: "photo.png", to: "photo-2.png" }], versions: { [first.id]: 2 } });
    const back = expectOk(await media.get(first.id));
    expect(back).toMatchObject({ filename: "photo-2.png", folder: "album", key: first.key, location: "album/photo-2.png" });
    expect(media.toPublicItem(back!).path).toBe(media.toPublicItem(first).path);
    expect(expectOk(await media.get(second.id))).toMatchObject({ filename: "photo.png", location: "album/photo.png" });
    expect(blobs.blobs.get(copyKeyOf(first.id, "photo.png"))?.data).toEqual(bytes(1));
  });

  it("counts on past every taken suffix", async () => {
    const { media } = await setup();
    const first = await put(media, "photo.png", "", bytes(1));
    expectOk(await media.trash([first.id]));
    await put(media, "photo.png", "", bytes(2));
    await put(media, "photo-2.png", "", bytes(3));
    expect(expectOk(await media.restore([first.id])).renamed).toEqual([{ id: first.id, from: "photo.png", to: "photo-3.png" }]);
  });
});

describe("media/default restore", () => {
  it("brings back the same id, key, path, texts and provenance, ready, with its public copy and its folder row", async () => {
    const { media, blobs, db } = await setup();
    const item = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: bytes(4) }, "deep/er", { origin: "ai", tool: "painter" })).item;
    expectOk(await media.update(item.id, { alt: "Ein Bild" }, "de"));
    expectOk(await media.update(item.id, { alt: "A picture" }, "en"));
    expectOk(await media.trash([item.id]));
    expect(expectOk(await db.count(FOLDERS, { path: "deep/er" }))).toBe(1);
    expectOk(await media.removeFolder("deep"));
    expect(expectOk(await db.count(FOLDERS, {}))).toBe(0);

    expect(expectOk(await media.restore([item.id]))).toEqual({ ids: [item.id], unchanged: [], skipped: [], renamed: [], versions: { [item.id]: 2 } });
    const back = expectOk(await media.get(item.id, "en"));
    expect(back).toMatchObject({ id: item.id, key: item.key, filename: "a.png", folder: "deep/er", location: "deep/er/a.png", status: "ready", alt: "A picture", provenance: { origin: "ai", tool: "painter" }, trashedAt: null });
    expect(expectOk(await media.get(item.id, "de"))?.alt).toBe("Ein Bild");
    expect(blobs.blobs.get(copyKeyOf(item.id, "a.png"))?.data).toEqual(bytes(4));
    expect(expectOk(await media.folders()).map((f) => f.folder)).toEqual(["deep", "deep/er"]);
    expect(expectOk(await db.count(FOLDERS, { path: "deep/er" }))).toBe(1);
  });

  it("is idempotent: a ready id is handed on in ids, named unchanged and gets its public copy back, an unknown id is skipped as not found", async () => {
    const { media, blobs } = await setup();
    const item = await put(media, "a.png");
    blobs.blobs.delete(copyKeyOf(item.id, item.filename));
    expect(expectOk(await media.restore([item.id, "no-such-id"]))).toEqual({ ids: [item.id], unchanged: [item.id], skipped: [{ id: "no-such-id", reason: "not_found" }], renamed: [], versions: { [item.id]: 0 } });
    expect(blobs.blobs.has(copyKeyOf(item.id, item.filename))).toBe(true);
  });

  it("retries with the next suffix when the store refuses the name it found free", async () => {
    const { media, db } = await setup();
    const item = await put(media, "a.png");
    expectOk(await media.trash([item.id]));
    const updateMany = db.updateMany.bind(db);
    let refused = false;
    db.updateMany = async (collection, filter, patch) => {
      if (!refused && collection === COLLECTION && (patch as Record<string, unknown>).status === "ready") {
        refused = true;
        return err(failure("CONFLICT", "taken meanwhile", { details: { collection, field: "location" } }));
      }
      return updateMany(collection, filter, patch);
    };
    expect(expectOk(await media.restore([item.id])).renamed).toEqual([{ id: item.id, from: "a.png", to: "a-2.png" }]);
    expect(expectOk(await media.get(item.id))?.location).toBe("a-2.png");
  });
});

describe("media/default restore around other writes", () => {
  it("keeps its name when only a failed upload holds it", async () => {
    const { media, blobs, db } = await setup();
    const item = await put(media, "a.png", "box");
    expectOk(await media.trash([item.id]));
    const putBlob = blobs.put.bind(blobs);
    blobs.put = async (key, data, options) => (key.startsWith("media/") ? err(failure("TRANSIENT", "store down")) : putBlob(key, data, options));
    expectErr(await media.upload({ filename: "a.png", contentType: "image/png", data: bytes(8) }, "box"), "TRANSIENT");
    blobs.put = putBlob;
    expect(expectOk(await db.count(COLLECTION, { location: "box/a.png", status: "failed" }))).toBe(1);

    expect(expectOk(await media.restore([item.id]))).toEqual({ ids: [item.id], unchanged: [], skipped: [], renamed: [], versions: { [item.id]: 2 } });
    expect(expectOk(await media.get(item.id))).toMatchObject({ filename: "a.png", location: "box/a.png" });
    expect(expectOk(await media.list({ folder: "box" })).items.map((i) => i.id)).toEqual([item.id]);
  });

  it("follows a folder rename that runs while it looks for a free name", async () => {
    const { media, db } = await setup();
    const item = await put(media, "a.png", "old");
    const neighbour = await put(media, "b.png", "old");
    expectOk(await media.trash([item.id]));
    const findOne = db.findOne.bind(db);
    let renamedMidway = false;
    db.findOne = async <T extends Document>(collection: string, filter: Filter) => {
      if (!renamedMidway && collection === COLLECTION && filter.location === "old/a.png") {
        renamedMidway = true;
        expectOk(await media.renameFolder("old", "new"));
      }
      return findOne<T>(collection, filter);
    };
    expect(expectOk(await media.restore([item.id])).ids).toEqual([item.id]);
    expect(renamedMidway).toBe(true);
    expect(await rowOf(db, item.id)).toMatchObject({ status: "ready", folder: "new", location: "new/a.png", filename: "a.png" });
    expect(expectOk(await media.list({ folder: "new" })).items.map((i) => i.id).sort()).toEqual([item.id, neighbour.id].sort());
    expect(expectOk(await media.list({ folder: "old" })).total).toBe(0);
  });
});

describe("media/default listTrash", () => {
  it("lists trashed items newest first with trashedAt and expiresAt, searchable and paged, and nothing else", async () => {
    const { media, clock } = await setup();
    await put(media, "live.png");
    const older = await put(media, "older.png", "x");
    const newer = await put(media, "newer.png");
    clock.now = 5_000;
    expectOk(await media.trash([older.id]));
    clock.now = 9_000;
    expectOk(await media.trash([newer.id]));

    const all = expectOk(await media.listTrash());
    expect(all.total).toBe(2);
    expect(all.items.map((i) => [i.id, i.folder, i.trashedAt, i.expiresAt])).toEqual([[newer.id, "", 9_000, 9_000 + 30 * DAY], [older.id, "x", 5_000, 5_000 + 30 * DAY]]);
    expect(expectOk(await media.listTrash({ q: "old" })).items.map((i) => i.id)).toEqual([older.id]);
    expect(expectOk(await media.listTrash({ limit: 1, offset: 1 }))).toMatchObject({ total: 2, items: [{ id: older.id }] });
  });
});

describe("media/default search for names with an underscore", () => {
  it("finds them in the library and in the trash, and only them", async () => {
    const { media } = await setup();
    const underscore = await put(media, "my_file.png");
    await put(media, "myxfile.png");
    await put(media, "myfile.png");
    expect(expectOk(await media.list({ q: "my_file" })).items.map((i) => i.id)).toEqual([underscore.id]);
    expect(expectOk(await media.list({ q: "_" })).items.map((i) => i.id)).toEqual([underscore.id]);
    expectOk(await media.trash([underscore.id]));
    await put(media, "my_file.png", "", bytes(7));
    const again = expectOk(await media.list({ q: "my_file" })).items;
    expect(again.map((i) => i.id)).not.toContain(underscore.id);
    expect(again).toHaveLength(1);
    expect(expectOk(await media.listTrash({ q: "my_file" })).items.map((i) => i.id)).toEqual([underscore.id]);
    expect(expectOk(await media.listTrash({ q: "_" })).items.map((i) => i.id)).toEqual([underscore.id]);
  });
});

describe("media/default search ignores case", () => {
  it("finds a name whatever the case of the query, in the library, a recursive folder list and the trash", async () => {
    const { media } = await setup();
    const photo = await put(media, "photo.png", "album/2024");
    await put(media, "other.png", "album/2024");
    expect(expectOk(await media.list({ q: "Photo" })).items.map((i) => i.id)).toEqual([photo.id]);
    expect(expectOk(await media.list({ q: "PHOTO.PNG" })).items.map((i) => i.id)).toEqual([photo.id]);
    expect(expectOk(await media.list({ folder: "album", recursive: true, q: "Photo" })).items.map((i) => i.id)).toEqual([photo.id]);
    expectOk(await media.trash([photo.id]));
    expect(expectOk(await media.listTrash({ q: "pHoTo" })).items.map((i) => i.id)).toEqual([photo.id]);
  });

  it("prefilters the store with the whole query as the pattern", async () => {
    const { media, db } = await setup();
    await put(media, "my_file.png");
    const findMany = db.findMany.bind(db);
    const patterns: unknown[] = [];
    db.findMany = async <T extends Document>(collection: string, filter: Filter, options?: FindOptions) => {
      if (collection === COLLECTION && filter.filename !== undefined) patterns.push(filter.filename);
      return findMany<T>(collection, filter, options);
    };
    expectOk(await media.list({ q: "my_file" }));
    expectOk(await media.listTrash({ q: "my_file" }));
    expect(patterns).toEqual([{ like: "%my_file%" }, { like: "%my_file%" }]);
  });
});

describe("media/default purge", () => {
  it("removes only trashed ids: copy, blob, then row; media@1 then answers null", async () => {
    const { media, blobs, db } = await setup();
    const live = await put(media, "live.png");
    const gone = await put(media, "gone.png");
    expectOk(await media.trash([gone.id]));
    expect(expectOk(await media.purge([gone.id, live.id, "no-such-id"]))).toEqual({ ids: [gone.id], skipped: [{ id: live.id, reason: "not_trashed" }, { id: "no-such-id", reason: "not_found" }] });
    expect(await rowOf(db, gone.id)).toBeNull();
    expect([...blobs.blobs.keys()].filter((key) => key.includes(gone.id))).toEqual([]);
    expect(expectOk(await media.file(gone.id))).toBeNull();
    expect(expectOk(await media.load(gone.id))).toBeNull();
    expect(expectOk(await media.get(live.id))).not.toBeNull();
  });

  it("ends readiness before it removes any byte, and a purge that stopped halfway is finished at the next start", async () => {
    const { media, blobs, db, reopen } = await setup();
    const gone = await put(media, "gone.png");
    expectOk(await media.trash([gone.id]));
    const remove = blobs.remove.bind(blobs);
    blobs.remove = async (key) => (key === gone.key ? err(failure("TRANSIENT", "store down")) : remove(key));
    expectErr(await media.purge([gone.id]), "TRANSIENT");
    expect((await rowOf(db, gone.id))?.status).toBe("removing");
    expect(expectOk(await media.file(gone.id))).toBeNull();
    blobs.remove = remove;
    await reopen();
    expect(await rowOf(db, gone.id)).toBeNull();
    expect(blobs.blobs.has(gone.key)).toBe(false);
  });

  it("a purge that stopped halfway is selected and finished by a repeated purge", async () => {
    const { media, blobs, db } = await setup();
    const gone = await put(media, "gone.png");
    expectOk(await media.trash([gone.id]));
    const remove = blobs.remove.bind(blobs);
    blobs.remove = async (key) => (key === gone.key ? err(failure("TRANSIENT", "store down")) : remove(key));
    expectErr(await media.purge([gone.id]), "TRANSIENT");
    blobs.remove = remove;
    expect(expectOk(await media.selectTrash([gone.id]))).toEqual({ ids: [gone.id], skipped: [] });
    expect(expectOk(await media.purge([gone.id]))).toEqual({ ids: [gone.id], skipped: [] });
    expect(await rowOf(db, gone.id)).toBeNull();
    expect([...blobs.blobs.keys()].filter((key) => key.includes(gone.id))).toEqual([]);
  });

  it("does not purge an item restored before its turn", async () => {
    const { media } = await setup();
    const item = await put(media, "a.png");
    expectOk(await media.trash([item.id]));
    expectOk(await media.restore([item.id]));
    expect(expectOk(await media.purge([item.id]))).toEqual({ ids: [], skipped: [{ id: item.id, reason: "not_trashed" }] });
    expect(expectOk(await media.get(item.id))).not.toBeNull();
  });

  it("trashIds selects every trashed id, or only those whose retention has run out", async () => {
    const { media, clock } = await setup({ trashRetentionDays: 2 });
    await put(media, "live.png");
    const early = await put(media, "early.png");
    const late = await put(media, "late.png");
    clock.now = 1 * DAY;
    expectOk(await media.trash([early.id]));
    clock.now = 2 * DAY;
    expectOk(await media.trash([late.id]));

    expect(expectOk(await media.trashIds()).sort()).toEqual([early.id, late.id].sort());
    clock.now = 3 * DAY - 1;
    expect(expectOk(await media.trashIds({ expired: true }))).toEqual([]);
    clock.now = 3 * DAY;
    expect(expectOk(await media.trashIds({ expired: true }))).toEqual([early.id]);
    expect(expectOk(await media.purge(expectOk(await media.trashIds({ expired: true }))))).toEqual({ ids: [early.id], skipped: [] });
    expect(expectOk(await media.trashIds())).toEqual([late.id]);
  });
});

describe("media/default folders around trashed items", () => {
  it("renameFolder moves the folder of a trashed item without giving it a location, even where the target name is taken", async () => {
    const { media } = await setup();
    const trashed = await put(media, "a.png", "old", bytes(1));
    const live = await put(media, "b.png", "old");
    expectOk(await media.trash([trashed.id]));
    await put(media, "a.png", "old", bytes(2));
    expect(expectOk(await media.renameFolder("old", "new"))).toEqual({ folder: "new", moved: 2 });
    expect(expectOk(await media.get(live.id))?.location).toBe("new/b.png");
    const restored = expectOk(await media.restore([trashed.id]));
    expect(restored.renamed).toEqual([{ id: trashed.id, from: "a.png", to: "a-2.png" }]);
    expect(expectOk(await media.get(trashed.id))).toMatchObject({ folder: "new", location: "new/a-2.png" });
  });

  it("renameFolder of a folder that only trashed items name answers not found", async () => {
    const { media } = await setup();
    const item = await put(media, "a.png", "only");
    expectOk(await media.trash([item.id]));
    expectOk(await media.removeFolder("only"));
    expect(expectOk(await media.renameFolder("only", "else"))).toBeNull();
  });

  it("removeFolder deletes the live items for good and leaves trashed ones in the trash", async () => {
    const { media } = await setup();
    const trashed = await put(media, "a.png", "box");
    const live = await put(media, "b.png", "box/inner");
    expectOk(await media.trash([trashed.id]));
    expect(expectOk(await media.removeFolder("box"))).toEqual({ ok: true, removed: 1, ids: [live.id] });
    expect(expectOk(await media.file(live.id))).toBeNull();
    expect(expectOk(await media.listTrash()).items.map((i) => i.id)).toEqual([trashed.id]);
    expect(expectOk(await media.file(trashed.id))).not.toBeNull();
  });

  it("trashFolder trashes every ready item of the subtree, drops its folder rows, and restore brings the folders back", async () => {
    const { media, db, clock } = await setup();
    const a = await put(media, "a.png", "trip");
    const b = await put(media, "b.png", "trip/day1");
    expectOk(await media.createFolder("trip/empty"));
    const other = await put(media, "c.png", "tripping");
    clock.now = 4_000;
    const trashed = expectOk(await media.trashFolder("trip"));
    expect(trashed).toEqual({ path: "trip", ids: [a.id, b.id], unchanged: [], versions: { [a.id]: 1, [b.id]: 1 } });
    expect(expectOk(await media.folders()).map((f) => f.folder)).toEqual(["tripping"]);
    expect(expectOk(await db.count(FOLDERS, { path: { like: "trip/%" } }))).toBe(0);
    expect(expectOk(await media.listTrash()).items.map((i) => [i.id, i.trashedAt]).sort()).toEqual([[a.id, 4_000], [b.id, 4_000]].sort());
    expect(expectOk(await media.get(other.id))).not.toBeNull();

    expectOk(await media.restore([b.id]));
    expect(expectOk(await media.folders()).map((f) => f.folder)).toEqual(["trip", "trip/day1", "tripping"]);
    expect(expectOk(await media.trashFolder("nowhere"))).toBeNull();
  });
});

describe("media/default trashFolder with items that are not ready", () => {
  it("deletes failed and abandoned uploads in the subtree, so the folder is gone", async () => {
    const { media, db, blobs, clock } = await setup();
    const ready = await put(media, "a.png", "shoot");
    const failed = await put(media, "b.png", "shoot");
    const abandoned = await put(media, "c.png", "shoot/day1");
    expectOk(await db.updateMany(COLLECTION, { id: failed.id }, { status: "failed" }));
    expectOk(await db.updateMany(COLLECTION, { id: abandoned.id }, { status: "uploading", updatedAt: clock.now }));
    clock.now += CONFIG.uploadStaleAfterMs;
    expect(expectOk(await media.trashFolder("shoot"))).toEqual({ path: "shoot", ids: [ready.id], unchanged: [], versions: { [ready.id]: 1 } });
    expect(await rowOf(db, failed.id)).toBeNull();
    expect(await rowOf(db, abandoned.id)).toBeNull();
    expect(blobs.blobs.has(failed.key)).toBe(false);
    expect(expectOk(await media.folders())).toEqual([]);
    expect(expectOk(await media.folderItems("shoot", true))).toBeNull();
  });

  it("leaves an upload that is still under way, so its folder stays listed", async () => {
    const { media, db, clock } = await setup();
    await put(media, "a.png", "shoot");
    const running = await put(media, "b.png", "shoot");
    expectOk(await db.updateMany(COLLECTION, { id: running.id }, { status: "uploading", updatedAt: clock.now }));
    expectOk(await media.trashFolder("shoot"));
    expect((await rowOf(db, running.id))?.status).toBe("uploading");
    expect(expectOk(await media.folders())).toEqual([{ folder: "shoot", count: 1 }]);
  });
});

describe("media/default syncPublic with trashed items", () => {
  it("removes the public copy of a trashed item and writes none for it", async () => {
    const { media, blobs } = await setup();
    const item = await put(media, "a.png");
    expectOk(await media.trash([item.id]));
    expectOk(await blobs.put(copyKeyOf(item.id, item.filename), bytes(1), { contentType: "image/png" }));
    expect(expectOk(await media.syncPublic())).toEqual({ written: 0, removed: 1, missing: 0 });
    expect(blobs.blobs.has(copyKeyOf(item.id, item.filename))).toBe(false);
    expect(expectOk(await media.syncPublic())).toEqual({ written: 0, removed: 0, missing: 0 });
  });

  it("keeps the copy of an item restored while the run is under way", async () => {
    const { media, blobs, db } = await setup();
    const item = await put(media, "a.png");
    const key = copyKeyOf(item.id, item.filename);
    expectOk(await media.trash([item.id]));
    expectOk(await blobs.put(key, bytes(1), { contentType: "image/png" }));
    const findMany = db.findMany.bind(db);
    let restoredMidway = false;
    db.findMany = async <T extends Document>(collection: string, filter: Filter, options?: FindOptions) => {
      const page = await findMany<T>(collection, filter, options);
      if (!restoredMidway && collection === COLLECTION && options?.sort?.id === "asc") {
        restoredMidway = true;
        expectOk(await media.restore([item.id]));
      }
      return page;
    };
    const remove = blobs.remove.bind(blobs);
    const removedDuringSync: string[] = [];
    blobs.remove = async (removed) => {
      removedDuringSync.push(removed);
      return remove(removed);
    };
    expectOk(await media.syncPublic());
    expect(restoredMidway).toBe(true);
    expect(removedDuringSync).not.toContain(key);
    expect(blobs.blobs.has(key)).toBe(true);
  });
});

describe("media/default syncPublic racing a restore", () => {
  it("writes the copy back when the item is restored while its stale copy is removed", async () => {
    const { media, blobs } = await setup();
    const item = await put(media, "a.png");
    const key = copyKeyOf(item.id, item.filename);
    expectOk(await media.trash([item.id]));
    expectOk(await blobs.put(key, bytes(1), { contentType: "image/png" }));
    const remove = blobs.remove.bind(blobs);
    let restoredMidway = false;
    blobs.remove = async (removed) => {
      if (!restoredMidway && removed === key) {
        restoredMidway = true;
        expectOk(await media.restore([item.id]));
      }
      return remove(removed);
    };
    expectOk(await media.syncPublic());
    expect(restoredMidway).toBe(true);
    expect(blobs.blobs.get(key)?.data).toEqual(bytes("a.png".length));
  });
});

describe("media/default trash across a restart", () => {
  it("a trashed row stays trashed and keeps its bytes; it is not taken for an interrupted delete", async () => {
    const { media, blobs, db, reopen } = await setup();
    const item = await put(media, "a.png");
    expectOk(await media.trash([item.id]));
    const restarted = await reopen();
    expect((await rowOf(db, item.id))?.status).toBe("trashed");
    expect(blobs.blobs.has(item.key)).toBe(true);
    expect(expectOk(await restarted.file(item.id))).not.toBeNull();
    expect(expectOk(await restarted.listTrash()).total).toBe(1);
    expect(expectOk(await restarted.restore([item.id])).ids).toEqual([item.id]);
  });
});
