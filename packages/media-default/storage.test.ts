import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBlobstoreFilesystem } from "@michaelthielemann/kestrel-blobstore-filesystem/impl";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { err, failure, ok } from "@michaelthielemann/kestrel-contracts/errors";
import { PERSISTENCE, type Document, type Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { guardStorage, runShapeMigrations, storageVersionOf } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createPersistenceSqlite } from "@michaelthielemann/kestrel-persistence-sqlite/impl";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import module, { configSchema } from "./module.ts";
import { COLLECTION, createMediaDefault, type Config, type MediaItem } from "./impl.ts";
import { ID_KEY_LAYOUT, MISSING_ORIGINAL, MODULE, STORAGE_VERSION, migrations, storage, type SvgSanitizer } from "./storage.ts";

const OLD_ITEMS_SCHEMA = {
  filename: "string", folder: "string", contentType: "string", size: "number", key: { type: "string", unique: true }, checksum: "string", status: "string", createdAt: "number", updatedAt: "number",
  provenance: "json", width: "number", height: "number", alt: "json", title: "json", description: "json",
} as const;

const CONFIG: Config = { allowedTypes: ["image/*", "application/pdf"], deniedTypes: [], maxBytes: 1_000_000, locales: [], prefix: "media/", publicPath: "/media", uploadStaleAfterMs: 900_000, anonymousList: "ids" };

const sha = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

interface OldItem {
  id: string;
  folder: string;
  filename: string;
  contentType: string;
  status?: string;
  blob?: string;
}

const OLD_ITEMS: OldItem[] = [
  { id: "a1", folder: "", filename: "Logo.PNG", contentType: "image/png", blob: "logo bytes" },
  { id: "b2", folder: "events/2024/summer", filename: "photo.jpg", contentType: "image/jpeg", blob: "summer photo" },
  { id: "c3", folder: "events/2023", filename: "photo.jpg", contentType: "image/jpeg", blob: "2023 photo" },
  { id: "d4", folder: "docs", filename: "report.pdf", contentType: "application/pdf" },
  { id: "e5", folder: "events/2023", filename: "photo.JPG", contentType: "image/jpeg", blob: "another 2023 photo" },
  { id: "f6", folder: "", filename: "broken.png", contentType: "image/png", status: "failed" },
];

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

class Crash extends Error {}

function counting<T extends object>(target: T, writes: readonly string[], counter: { writes: number; crashAt: number | null }): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        if (writes.includes(String(property))) {
          counter.writes += 1;
          if (counter.crashAt !== null && counter.writes === counter.crashAt) throw new Crash(`crash at write ${counter.writes}`);
        }
        return Reflect.apply(value, object, args) as unknown;
      };
    },
  });
}

const DB_WRITES = ["createOne", "createMany", "updateOne", "updateMany", "deleteOne", "deleteMany"];
const BLOB_WRITES = ["put", "remove", "move"];

async function oldStore(items: readonly OldItem[] = OLD_ITEMS, extras = true): Promise<{ db: Persistence; blobs: Blobstore }> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-media-storage-"));
  tempDirs.push(root);
  const db = createPersistenceSqlite({ file: ":memory:" });
  const blobs = createBlobstoreFilesystem({ root });
  expectOk(await db.ensureCollection(COLLECTION, OLD_ITEMS_SCHEMA));
  for (const item of items) {
    const key = `media/${item.folder === "" ? "" : `${item.folder}/`}${item.filename}`;
    const data = bytes(item.blob ?? `lost ${item.id}`);
    expectOk(await db.createOne(COLLECTION, { id: item.id, filename: item.filename, folder: item.folder, contentType: item.contentType, size: data.byteLength, key, checksum: sha(data), status: item.status ?? "ready", createdAt: 1, updatedAt: 1, provenance: { origin: "unknown" }, width: null, height: null, alt: {}, title: {}, description: {} }));
    if (item.blob !== undefined) expectOk(await blobs.put(key, data));
  }
  if (!extras) return { db, blobs };
  expectOk(await blobs.put("media/stray/left-behind.png", bytes("no row names me")));
  expectOk(await blobs.put("media/variants/b2/thumb.webp", bytes("a variant another module keeps under this prefix")));
  expectOk(await db.ensureCollection("revisions", { document: "string", data: "json" }));
  expectOk(await db.createOne("revisions", { id: "r1", document: "page-1", data: { hero: { media: "b2" }, gallery: ["c3", "e5"] } }));
  return { db, blobs };
}

const OLD_KEYS = ["media/Logo.PNG", "media/events/2024/summer/photo.jpg", "media/events/2023/photo.jpg", "media/events/2023/photo.JPG", "media/stray/left-behind.png"].sort();

async function migrate(db: Persistence, blobs: Blobstore, answers: Record<string, string> = {}) {
  return runShapeMigrations({ storages: [storage({ prefix: "media/" })], db, blobs, apply: true, blobWrites: true, answers, now: () => 5 });
}

async function rowsOf(db: Persistence): Promise<MediaItem[]> {
  return expectOk(await db.findMany<MediaItem>(COLLECTION, {}, { sort: { id: "asc" }, limit: 100 })).items;
}

async function snapshot(db: Persistence, blobs: Blobstore) {
  const rows = await rowsOf(db);
  const listed = expectOk(await blobs.list("media/"));
  const contents: Array<[string, string]> = [];
  for (const { key } of listed) contents.push([key, sha(expectOk(await blobs.get(key))!)]);
  const version = expectOk(await storageVersionOf(db, MODULE));
  return {
    rows: rows.map((r) => ({ id: r.id, key: r.key, filename: r.filename, location: r.location, status: r.status })),
    blobs: contents.sort(),
    legacy: expectOk(await db.findMany<Document>("media_legacy_keys", {}, { sort: { key: "asc" }, limit: 100 })).items.map((r) => [r.key, r.mediaId]),
    version: version === null ? null : [version.version, version.migrations],
  };
}

function reading(blobs: Blobstore, reads: string[]): Blobstore {
  return {
    put: (key, data, options) => blobs.put(key, data, options),
    get: (key) => {
      reads.push(key);
      return blobs.get(key);
    },
    remove: (key) => blobs.remove(key),
    move: (from, to) => blobs.move(from, to),
    list: (prefix) => blobs.list(prefix),
  };
}

const unreachable: Blobstore = {
  put: async () => err(failure("TRANSIENT", "blob store unreachable")),
  get: async () => err(failure("TRANSIENT", "blob store unreachable")),
  remove: async () => err(failure("TRANSIENT", "blob store unreachable")),
  move: async () => err(failure("TRANSIENT", "blob store unreachable")),
  list: async () => err(failure("TRANSIENT", "blob store unreachable")),
};

function deps(db: Persistence, blobs: Blobstore) {
  return {
    get<T>(contract: { name: string }): T {
      if (contract === BLOBSTORE) return boundaryCast<T>(blobs, "host");
      if (contract === PERSISTENCE) return boundaryCast<T>(db, "host");
      throw new Error(`unexpected contract ${contract.name}`);
    },
    find: () => undefined,
    logger: silentLogger,
    root: process.cwd(),
    eventTriggers: [],
  };
}

describe("media-default storage: converting 5.x items to the id key layout", () => {
  it("exports the migration with its id, release and blob writes", () => {
    expect(migrations.map((m) => [m.id, m.introducedIn, m.kind, m.blobWrites])).toEqual([[ID_KEY_LAYOUT, "6.0.0", "auto", true]]);
    expect(storage().version).toBe(STORAGE_VERSION);
  });

  it("detects every item outside the layout and plans without writing", async () => {
    const { db, blobs } = await oldStore();
    const counter = { writes: 0, crashAt: null };
    const report = expectOk(await runShapeMigrations({ storages: [storage()], db: counting(db, DB_WRITES, counter), blobs: counting(blobs, BLOB_WRITES, counter), apply: false, blobWrites: true }));
    const run = report.modules[0]!.migrations[0]!;
    expect(run.detected.pending).toBe(6);
    expect(run.plan?.counts).toMatchObject({ items: 6, copies: 4, renamed: 1, missingOriginals: 2 });
    expect(counter.writes).toBe(0);
  });

  it("copies each original to <prefix><id>/<name>, checks it against the row, fills in a unique location and keeps the old blob", async () => {
    const { db, blobs } = await oldStore();
    const report = expectOk(await migrate(db, blobs));
    expect(report.modules[0]).toMatchObject({ state: "migrated", version: STORAGE_VERSION });
    const rows = await rowsOf(db);
    expect(rows.map((r) => [r.id, r.key, r.location, r.filename])).toEqual([
      ["a1", "media/a1/Logo.png", "Logo.png", "Logo.png"],
      ["b2", "media/b2/photo.jpg", "events/2024/summer/photo.jpg", "photo.jpg"],
      ["c3", "media/c3/photo.jpg", "events/2023/photo.jpg", "photo.jpg"],
      ["d4", "media/d4/report.pdf", "docs/report.pdf", "report.pdf"],
      ["e5", "media/e5/photo-2.jpg", "events/2023/photo-2.jpg", "photo-2.jpg"],
      ["f6", "media/f6/broken.png", "broken.png", "broken.png"],
    ]);
    for (const row of rows.filter((r) => r.id !== "d4" && r.id !== "f6")) {
      expect(sha(expectOk(await blobs.get(row.key))!)).toBe(row.checksum);
    }
    for (const key of OLD_KEYS) expect(expectOk(await blobs.get(key))).not.toBeNull();
    const outcome = report.modules[0]!.migrations[0]!.outcome!;
    expect(outcome.counts).toMatchObject({ copied: 4, missingOriginals: 2, trashed: 0, legacyKeys: 7 });
    expect(outcome.notes.map((n) => n.item).sort()).toEqual(["d4", "f6"]);
    expect(expectOk(await storageVersionOf(db, MODULE))).toMatchObject({ version: STORAGE_VERSION, migrations: [ID_KEY_LAYOUT] });
  });

  it("leaves other collections, such as revisions that name the items, untouched", async () => {
    const { db, blobs } = await oldStore();
    expectOk(await migrate(db, blobs));
    expect(expectOk(await db.findOne("revisions", { id: "r1" }))).toEqual({ id: "r1", document: "page-1", data: { hero: { media: "b2" }, gallery: ["c3", "e5"] } });
  });

  it("lets 6.x start on the converted data; reconcile reports the old keys apart and neither reconcile nor reconcileDelete removes them", async () => {
    const { db, blobs } = await oldStore();
    expectOk(await migrate(db, blobs));
    const media = await createMediaDefault(CONFIG, blobs, db, silentLogger);
    expect(expectOk(await media.reconcile())).toEqual({ blobsWithoutRow: [], rowsWithoutBlob: ["media/d4/report.pdf", "media/f6/broken.png"], legacyKeys: OLD_KEYS });
    expect(expectOk(await media.reconcile({ delete: true })).legacyKeys).toEqual(OLD_KEYS);
    for (const key of OLD_KEYS) expect(expectOk(await blobs.get(key))).not.toBeNull();
    const served = expectOk(await media.serveFile("e5", "photo-2.jpg"));
    expect(new TextDecoder().decode(served!.data)).toBe("another 2023 photo");
  });

  it("starts through the module once the version row is written", async () => {
    const { db, blobs } = await oldStore();
    expectOk(await migrate(db, blobs));
    await expect(module.setup(configSchema.parse({}), deps(db, blobs))).resolves.toBeDefined();
  });

  it("plans and writes nothing on a second run", async () => {
    const { db, blobs } = await oldStore();
    expectOk(await migrate(db, blobs));
    const counter = { writes: 0, crashAt: null };
    const again = expectOk(await runShapeMigrations({ storages: [storage()], db: counting(db, DB_WRITES, counter), blobs: counting(blobs, BLOB_WRITES, counter), apply: true, blobWrites: true }));
    expect(again.modules[0]!.state).toBe("current");
    expect(counter.writes).toBe(0);
  });

  it("ends in the same state after an abort during the copies, during the row switches and before the version row", async () => {
    const reference = await oldStore();
    expectOk(await migrate(reference.db, reference.blobs));
    const expected = await snapshot(reference.db, reference.blobs);
    for (const crashAt of [8, 13, 18]) {
      const { db, blobs } = await oldStore();
      const counter = { writes: 0, crashAt };
      await expect(migrate(counting(db, DB_WRITES, counter), counting(blobs, BLOB_WRITES, counter))).rejects.toBeInstanceOf(Crash);
      const before = await snapshot(db, blobs);
      expect(before).not.toEqual(expected);
      expectOk(await migrate(db, blobs));
      expect(await snapshot(db, blobs)).toEqual(expected);
    }
  });

  it("records the 5.x key of an item whose original is missing, so a blob put back there survives reconcileDelete", async () => {
    const { db, blobs } = await oldStore();
    expectOk(await migrate(db, blobs));
    const legacy = expectOk(await db.findMany<Document>("media_legacy_keys", {}, { sort: { key: "asc" }, limit: 100 })).items;
    expect(legacy.filter((r) => r.mediaId === "d4" || r.mediaId === "f6").map((r) => [r.key, r.mediaId])).toEqual([["media/broken.png", "f6"], ["media/docs/report.pdf", "d4"]]);
    expectOk(await blobs.put("media/docs/report.pdf", bytes("the report, put back from a backup")));
    const media = await createMediaDefault(CONFIG, blobs, db, silentLogger);
    const reconciled = expectOk(await media.reconcile({ delete: true }));
    expect(reconciled.blobsWithoutRow).toEqual([]);
    expect(reconciled.legacyKeys).toContain("media/docs/report.pdf");
    expect(expectOk(await blobs.get("media/docs/report.pdf"))).not.toBeNull();
  });

  it("names an item after its trashed neighbour gave up the name, also after an abort at any write", async () => {
    const items: OldItem[] = [
      { id: "m1", folder: "x", filename: "a.jpg", contentType: "image/jpeg" },
      { id: "m2", folder: "x", filename: "a.jpeg", contentType: "image/jpeg", blob: "the neighbour" },
    ];
    const answers = { [MISSING_ORIGINAL.id]: "trash" };
    const reference = await oldStore(items, false);
    const plan = expectOk(await runShapeMigrations({ storages: [storage()], db: reference.db, blobs: reference.blobs, apply: false, blobWrites: true, answers })).modules[0]!.migrations[0]!.plan!;
    expect(plan.counts).toMatchObject({ items: 2, copies: 1, renamed: 0, missingOriginals: 1, trashed: 1 });
    const counter = { writes: 0, crashAt: null };
    expectOk(await migrate(counting(reference.db, DB_WRITES, counter), counting(reference.blobs, BLOB_WRITES, counter), answers));
    const expected = await snapshot(reference.db, reference.blobs);
    expect(expected.rows).toEqual([
      { id: "m1", key: "media/m1/a.jpg", filename: "a.jpg", location: null, status: "trashed" },
      { id: "m2", key: "media/m2/a.jpg", filename: "a.jpg", location: "x/a.jpg", status: "ready" },
    ]);
    for (let crashAt = 1; crashAt <= counter.writes; crashAt += 1) {
      const { db, blobs } = await oldStore(items, false);
      const crashing = { writes: 0, crashAt };
      await expect(migrate(counting(db, DB_WRITES, crashing), counting(blobs, BLOB_WRITES, crashing), answers)).rejects.toBeInstanceOf(Crash);
      expectOk(await migrate(db, blobs, answers));
      expect(await snapshot(db, blobs)).toEqual(expected);
    }
  });

  it("reports each SVG that becomes a .bin download, in the plan and in the outcome", async () => {
    const items: OldItem[] = [
      { id: "s1", folder: "brand", filename: "logo.svg", contentType: "image/svg+xml", blob: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>" },
      { id: "p1", folder: "brand", filename: "photo.png", contentType: "image/png", blob: "png bytes" },
    ];
    const { db, blobs } = await oldStore(items, false);
    const plan = expectOk(await runShapeMigrations({ storages: [storage()], db, blobs, apply: false, blobWrites: true })).modules[0]!.migrations[0]!.plan!;
    expect(plan.counts).toMatchObject({ svgDemoted: 1 });
    expect(plan.notes.map((n) => n.item)).toEqual(["s1"]);
    expect(plan.notes[0]!.reason).toMatch(/logo-svg\.bin.*application\/octet-stream.*sanitize\.svg/);
    const outcome = expectOk(await migrate(db, blobs)).modules[0]!.migrations[0]!.outcome!;
    expect(outcome.counts).toMatchObject({ svgDemoted: 1 });
    expect(outcome.notes.map((n) => n.item)).toEqual(["s1"]);
    expect((await rowsOf(db)).map((r) => [r.id, r.key])).toEqual([["p1", "media/p1/photo.png"], ["s1", "media/s1/logo-svg.bin"]]);
  });

  it("reports each item of a type it does not publish as itself that becomes a .bin download, in the plan and in the outcome", async () => {
    const items: OldItem[] = [
      { id: "t1", folder: "anim", filename: "spin.apng", contentType: "image/apng", blob: "apng bytes" },
      { id: "t2", folder: "", filename: "photo.jpg", contentType: "image/jpg", blob: "jpg bytes" },
      { id: "t3", folder: "", filename: "ok.jpg", contentType: "image/jpeg", blob: "jpeg bytes" },
      { id: "t4", folder: "", filename: "blob.bin", contentType: "application/octet-stream", blob: "raw bytes" },
    ];
    const { db, blobs } = await oldStore(items, false);
    const plan = expectOk(await runShapeMigrations({ storages: [storage()], db, blobs, apply: false, blobWrites: true })).modules[0]!.migrations[0]!.plan!;
    expect(plan.counts).toMatchObject({ items: 4, typeDemoted: 2, svgDemoted: 0 });
    expect(plan.notes.map((n) => n.item)).toEqual(["t1", "t2"]);
    expect(plan.notes[0]!.reason).toMatch(/image\/apng.*spin-apng\.bin.*application\/octet-stream/);
    const outcome = expectOk(await migrate(db, blobs)).modules[0]!.migrations[0]!.outcome!;
    expect(outcome.counts).toMatchObject({ typeDemoted: 2, svgDemoted: 0 });
    expect(outcome.notes.map((n) => n.item)).toEqual(["t1", "t2"]);
    expect((await rowsOf(db)).map((r) => [r.id, r.key])).toEqual([["t1", "media/t1/spin-apng.bin"], ["t2", "media/t2/photo-jpg.bin"], ["t3", "media/t3/ok.jpg"], ["t4", "media/t4/blob-bin.bin"]]);
  });

  it("plans on data that needs nothing without writing the version row", async () => {
    const { db, blobs } = await oldStore([], false);
    const counter = { writes: 0, crashAt: null };
    const report = expectOk(await runShapeMigrations({ storages: [storage()], db: counting(db, DB_WRITES, counter), blobs: counting(blobs, BLOB_WRITES, counter), apply: false, blobWrites: true }));
    expect(report.modules[0]!.state).toBe("unrecorded");
    expect(counter.writes).toBe(0);
    expect(expectOk(await storageVersionOf(db, MODULE))).toBeNull();
  });

  it("moves an item whose original is missing to the trash when asked to", async () => {
    const { db, blobs } = await oldStore();
    expectOk(await migrate(db, blobs, { [MISSING_ORIGINAL.id]: "trash" }));
    const d4 = (await rowsOf(db)).find((r) => r.id === "d4")!;
    expect(d4).toMatchObject({ status: "trashed", location: null, trashedAt: 5, trashVersion: 1, key: "media/d4/report.pdf" });
  });

  it("plans by listing the blob store, without reading a blob", async () => {
    const { db, blobs } = await oldStore();
    for (const answers of [{}, { [MISSING_ORIGINAL.id]: "trash" }]) {
      const reads: string[] = [];
      const report = expectOk(await runShapeMigrations({ storages: [storage()], db, blobs: reading(blobs, reads), apply: false, blobWrites: true, answers }));
      expect(report.modules[0]!.migrations[0]!.plan?.counts).toMatchObject({ items: 6, copies: 4, missingOriginals: 2 });
      expect(reads).toEqual([]);
    }
  });

  it("moves an item whose original is missing to the trash when asked to, also while a variant of it lies under the same prefix", async () => {
    const { db, blobs } = await oldStore([{ id: "d4", folder: "docs", filename: "report.pdf", contentType: "application/pdf" }], false);
    expectOk(await blobs.put("media/d4/thumb.webp", bytes("a variant stored under the media prefix")));
    const answers = { [MISSING_ORIGINAL.id]: "trash" };
    const plan = expectOk(await runShapeMigrations({ storages: [storage()], db, blobs, apply: false, blobWrites: true, answers })).modules[0]!.migrations[0]!.plan!;
    expect(plan.counts).toMatchObject({ items: 1, missingOriginals: 1, trashed: 1 });
    const outcome = expectOk(await migrate(db, blobs, answers)).modules[0]!.migrations[0]!.outcome!;
    expect(outcome.counts).toMatchObject({ trashed: 1 });
    expect((await rowsOf(db))[0]).toMatchObject({ id: "d4", status: "trashed", location: null });
  });

  it("keeps an item whose original is gone but whose copy already lies at its new key, also when asked to trash", async () => {
    const { db, blobs } = await oldStore([{ id: "d4", folder: "docs", filename: "report.pdf", contentType: "application/pdf" }], false);
    expectOk(await blobs.put("media/d4/report.pdf", bytes("the copy an earlier run wrote")));
    expectOk(await migrate(db, blobs, { [MISSING_ORIGINAL.id]: "trash" }));
    expect((await rowsOf(db))[0]).toMatchObject({ id: "d4", status: "ready", key: "media/d4/report.pdf", location: "docs/report.pdf" });
  });

  it("records the size and sha256 of the copy at the new key when the original is gone, and plans the same missing originals it reports", async () => {
    const { db, blobs } = await oldStore([{ id: "d4", folder: "docs", filename: "report.pdf", contentType: "application/pdf" }], false);
    const copy = bytes("the copy an earlier run wrote");
    expectOk(await blobs.put("media/d4/report.pdf", copy));
    const plan = expectOk(await runShapeMigrations({ storages: [storage()], db, blobs, apply: false, blobWrites: true })).modules[0]!.migrations[0]!.plan!;
    const outcome = expectOk(await migrate(db, blobs)).modules[0]!.migrations[0]!.outcome!;
    expect([plan.counts.missingOriginals, plan.counts.copies]).toEqual([0, 0]);
    expect([outcome.counts.missingOriginals, outcome.counts.copied]).toEqual([0, 0]);
    expect(outcome.notes.map((n) => [n.item, n.reason])).toEqual([["d4", "the bytes at media/d4/report.pdf differ from the item's recorded size or checksum, and its original media/docs/report.pdf is gone; the item records those of media/d4/report.pdf"]]);
    const row = (await rowsOf(db))[0]!;
    expect([row.key, row.size, row.checksum]).toEqual(["media/d4/report.pdf", copy.byteLength, sha(copy)]);
  });

  it("keeps a name that was unique in its 5.x folder and gives the suffix to the item whose name collided", async () => {
    const items: OldItem[] = [
      { id: "a", folder: "x", filename: "photo.jpg", contentType: "image/jpeg", blob: "first photo" },
      { id: "b", folder: "x", filename: "photo.JPG", contentType: "image/jpeg", blob: "second photo" },
      { id: "c", folder: "x", filename: "photo-2.jpg", contentType: "image/jpeg", blob: "third photo" },
    ];
    const reference = await oldStore(items, false);
    const counter = { writes: 0, crashAt: null };
    expectOk(await migrate(counting(reference.db, DB_WRITES, counter), counting(reference.blobs, BLOB_WRITES, counter)));
    const expected = await snapshot(reference.db, reference.blobs);
    expect(expected.rows.map((r) => [r.id, r.key, r.location])).toEqual([
      ["a", "media/a/photo.jpg", "x/photo.jpg"],
      ["b", "media/b/photo-3.jpg", "x/photo-3.jpg"],
      ["c", "media/c/photo-2.jpg", "x/photo-2.jpg"],
    ]);
    for (let crashAt = 1; crashAt <= counter.writes; crashAt += 1) {
      const { db, blobs } = await oldStore(items, false);
      const crashing = { writes: 0, crashAt };
      await expect(migrate(counting(db, DB_WRITES, crashing), counting(blobs, BLOB_WRITES, crashing))).rejects.toBeInstanceOf(Crash);
      expectOk(await migrate(db, blobs));
      expect(await snapshot(db, blobs)).toEqual(expected);
    }
  });

  it("fails on a copy whose bytes differ from the original, keeps the 5.x key, and converts on a run whose copies are right", async () => {
    const { db, blobs } = await oldStore([{ id: "b2", folder: "events", filename: "photo.jpg", contentType: "image/jpeg", blob: "summer photo" }], false);
    for (const written of [bytes("summer"), bytes("winter photo")]) {
      const blobOps = {
        copy: async (_from: string, to: string) => blobs.put(to, written),
        head: async (key: string) => {
          const data = expectOk(await blobs.get(key));
          return ok(data === null ? null : { size: data.byteLength, sha256: sha(data) });
        },
      };
      const failed = expectErr(await runShapeMigrations({ storages: [storage()], db, blobs, blobOps, apply: true, blobWrites: true }), "STORAGE_MIGRATION_FAILED");
      expect(failed.message).toContain("the copy of media/events/photo.jpg at media/b2/photo.jpg does not match the original");
      expect((await rowsOf(db))[0]!.key).toBe("media/events/photo.jpg");
      expect(expectOk(await storageVersionOf(db, MODULE))).toBeNull();
    }
    expectOk(await migrate(db, blobs));
    const row = (await rowsOf(db))[0]!;
    expect(row.key).toBe("media/b2/photo.jpg");
    expect(sha(expectOk(await blobs.get(row.key))!)).toBe(sha(bytes("summer photo")));
  });

  it("records the size and sha256 of the bytes it copied when they differ from the 5.x row, so syncPublic writes the public copy once", async () => {
    const { db, blobs } = await oldStore([{ id: "a1", folder: "", filename: "Logo.png", contentType: "image/png", blob: "short" }], false);
    const actual = bytes("bytes that were replaced outside the library");
    expectOk(await blobs.put("media/Logo.png", actual));
    const outcome = expectOk(await migrate(db, blobs)).modules[0]!.migrations[0]!.outcome!;
    expect(outcome.notes.map((n) => [n.item, n.reason])).toEqual([["a1", "the bytes at media/Logo.png differ from the item's recorded size or checksum; the item records those of the copy"]]);
    const row = (await rowsOf(db))[0]!;
    expect([row.key, row.size, row.checksum]).toEqual(["media/a1/Logo.png", actual.byteLength, sha(actual)]);
    expect(sha(expectOk(await blobs.get(row.key))!)).toBe(sha(actual));
    const media = await createMediaDefault({ ...CONFIG, publicCopy: { prefix: "site/" } }, blobs, db, silentLogger);
    expect(expectOk(await media.syncPublic()).written).toBe(1);
    expect(expectOk(await media.syncPublic()).written).toBe(0);
  });

  it("finds nothing to convert in a 6.x store whose purge stopped after marking an item removing, also next to an item of the same name", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-media-storage-"));
    tempDirs.push(root);
    const db = createPersistenceSqlite({ file: ":memory:" });
    const blobs = createBlobstoreFilesystem({ root });
    const media = await createMediaDefault(CONFIG, blobs, db, silentLogger);
    const first = expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: bytes("first") }, "x")).item;
    expectOk(await media.trash([first.id]));
    expectOk(await media.upload({ filename: "a.png", contentType: "image/png", data: bytes("second") }, "x"));
    expectOk(await db.updateOne(COLLECTION, first.id, { status: "removing" }));
    const planned = expectOk(await runShapeMigrations({ storages: [storage()], db, blobs, apply: false, blobWrites: true }));
    expect(planned.modules[0]!.migrations.map((m) => [m.id, m.state])).toEqual([[ID_KEY_LAYOUT, "not-needed"]]);
    await expect(module.setup(configSchema.parse({}), deps(db, blobs))).resolves.toBeDefined();
    expect(expectOk(await storageVersionOf(db, MODULE))).toMatchObject({ version: STORAGE_VERSION });
  });

  it("refuses an answer outside the question's choices", async () => {
    const { db, blobs } = await oldStore();
    expectErr(await migrate(db, blobs, { [MISSING_ORIGINAL.id]: "delete" }), "STORAGE_REFUSED");
  });
});

const DIRTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>';
const CLEAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';

function stubSanitizer(calls: string[] = []): SvgSanitizer {
  return async (file) => {
    calls.push(file.filename);
    const text = new TextDecoder().decode(file.data);
    if (!text.includes("<svg")) return err("no svg root element");
    return ok(bytes(text.replace(/<script>.*?<\/script>/g, "")));
  };
}

async function migrateSanitizing(db: Persistence, blobs: Blobstore, sanitizeSvg: SvgSanitizer, answers: Record<string, string> = {}) {
  return runShapeMigrations({ storages: [storage({ prefix: "media/" }, { sanitizeSvg })], db, blobs, apply: true, blobWrites: true, answers, now: () => 5 });
}

const SVG_ITEMS: OldItem[] = [
  { id: "s1", folder: "brand", filename: "logo.svg", contentType: "image/svg+xml", blob: DIRTY_SVG },
  { id: "s2", folder: "brand", filename: "broken.svg", contentType: "image/svg+xml", blob: "not markup at all" },
  { id: "p1", folder: "brand", filename: "photo.png", contentType: "image/png", blob: "png bytes" },
];

describe("media-default storage: 5.x SVGs with a sanitizer", () => {
  it("stores each 5.x SVG the sanitizer cleans as an image under its .svg name, with the cleaned bytes and the same id, and keeps the original", async () => {
    const { db, blobs } = await oldStore([SVG_ITEMS[0]!, SVG_ITEMS[2]!], false);
    const plan = expectOk(await runShapeMigrations({ storages: [storage({}, { sanitizeSvg: stubSanitizer() })], db, blobs, apply: false, blobWrites: true })).modules[0]!.migrations[0]!.plan!;
    expect(plan.counts).toMatchObject({ items: 2, svgSanitized: 1, svgDemoted: 0 });
    expect(plan.notes).toEqual([]);
    const outcome = expectOk(await migrateSanitizing(db, blobs, stubSanitizer())).modules[0]!.migrations[0]!.outcome!;
    expect(outcome.counts).toMatchObject({ svgSanitized: 1, svgDemoted: 0 });
    expect(outcome.notes).toEqual([]);
    const row = (await rowsOf(db)).find((r) => r.id === "s1")!;
    expect(row).toMatchObject({ key: "media/s1/logo.svg", filename: "logo.svg", location: "brand/logo.svg", contentType: "image/svg+xml", svgSanitized: true, size: bytes(CLEAN_SVG).byteLength, checksum: sha(bytes(CLEAN_SVG)) });
    expect(new TextDecoder().decode(expectOk(await blobs.get("media/s1/logo.svg"))!)).toBe(CLEAN_SVG);
    expect(new TextDecoder().decode(expectOk(await blobs.get("media/brand/logo.svg"))!)).toBe(DIRTY_SVG);
    const media = await createMediaDefault({ ...CONFIG, publicCopy: { prefix: "site/" } }, blobs, db, silentLogger);
    const served = expectOk(await media.serveFile("s1", "logo.svg"))!;
    expect(new TextDecoder().decode(served.data)).toBe(CLEAN_SVG);
    expect(served.item.svgSanitized).toBe(true);
    expectOk(await media.syncPublic());
    const published = expectOk(await blobs.list("site/")).map((b) => b.key);
    expect(published).toEqual(["site/media/p1/photo.png", "site/media/s1/logo.svg"]);
    expect(new TextDecoder().decode(expectOk(await blobs.get("site/media/s1/logo.svg"))!)).toBe(CLEAN_SVG);
  });

  it("gives a cleaned SVG the time of the run as updatedAt, so exportTo writes it again over a 5.x export of the same size", async () => {
    const SAME_SIZE = '<svg xmlns="http://www.w3.org/2000/svg"><rect onload="x" width="1"/></svg>';
    const { db, blobs } = await oldStore([{ id: "s4", folder: "brand", filename: "mark.svg", contentType: "image/svg+xml", blob: SAME_SIZE }, SVG_ITEMS[2]!], false);
    const exported = await mkdtemp(join(tmpdir(), "kestrel-media-export-"));
    tempDirs.push(exported);
    await mkdir(join(exported, "brand"), { recursive: true });
    await writeFile(join(exported, "brand", "mark.svg"), SAME_SIZE);
    await utimes(join(exported, "brand", "mark.svg"), 0.001, 0.001);
    const sameLength: SvgSanitizer = async (file) => ok(bytes(new TextDecoder().decode(file.data).replace('onload="x"', 'class="x" ')));
    expectOk(await migrateSanitizing(db, blobs, sameLength));
    const rows = await rowsOf(db);
    expect(rows.map((r) => [r.id, r.updatedAt])).toEqual([["p1", 1], ["s4", 5]]);
    const media = await createMediaDefault(CONFIG, blobs, db, silentLogger);
    expect(expectOk(await media.exportTo(exported))).toMatchObject({ written: 2, skipped: 0 });
    expect(await readFile(join(exported, "brand", "mark.svg"), "utf8")).not.toContain("onload");
  });

  it("demotes an SVG the sanitizer refuses to a .bin download and names its file and the reason, in the plan and in the outcome", async () => {
    const { db, blobs } = await oldStore(SVG_ITEMS, false);
    const plan = expectOk(await runShapeMigrations({ storages: [storage({}, { sanitizeSvg: stubSanitizer() })], db, blobs, apply: false, blobWrites: true })).modules[0]!.migrations[0]!.plan!;
    expect(plan.counts).toMatchObject({ svgSanitized: 1, svgDemoted: 1 });
    expect(plan.notes.map((n) => n.item)).toEqual(["s2"]);
    expect(plan.notes[0]!.reason).toMatch(/media\/brand\/broken\.svg.*no svg root element.*broken-svg\.bin.*application\/octet-stream/);
    const outcome = expectOk(await migrateSanitizing(db, blobs, stubSanitizer())).modules[0]!.migrations[0]!.outcome!;
    expect(outcome.counts).toMatchObject({ svgSanitized: 1, svgDemoted: 1 });
    expect(outcome.notes.map((n) => [n.item, n.reason])).toEqual([["s2", plan.notes[0]!.reason]]);
    const rows = await rowsOf(db);
    expect(rows.map((r) => [r.id, r.key, r.svgSanitized === true])).toEqual([["p1", "media/p1/photo.png", false], ["s1", "media/s1/logo.svg", true], ["s2", "media/s2/broken-svg.bin", false]]);
    expect(new TextDecoder().decode(expectOk(await blobs.get("media/s2/broken-svg.bin"))!)).toBe("not markup at all");
  });

  it("demotes an SVG whose original is missing and names it", async () => {
    const { db, blobs } = await oldStore([{ id: "s3", folder: "", filename: "gone.svg", contentType: "image/svg+xml" }], false);
    const outcome = expectOk(await migrateSanitizing(db, blobs, stubSanitizer(), { [MISSING_ORIGINAL.id]: "keep" })).modules[0]!.migrations[0]!.outcome!;
    expect(outcome.counts).toMatchObject({ svgSanitized: 0, svgDemoted: 1, missingOriginals: 1 });
    expect(outcome.notes.find((n) => n.reason.includes("application/octet-stream"))?.reason).toContain("media/gone.svg");
    const row = (await rowsOf(db))[0]!;
    expect([row.key, row.svgSanitized === true]).toEqual(["media/s3/gone-svg.bin", false]);
  });

  it("keeps an SVG whose original is missing a download when the only SVG in its id folder is the 5.x file of another item, and leaves that file to its owner", async () => {
    for (const other of ["a0", "t6"]) {
      const { db, blobs } = await oldStore([{ id: "s5", folder: "", filename: "badge.svg", contentType: "image/svg+xml" }, { id: other, folder: "s5", filename: "badge.svg", contentType: "image/png", blob: DIRTY_SVG }], false);
      const plan = expectOk(await runShapeMigrations({ storages: [storage({}, { sanitizeSvg: stubSanitizer() })], db, blobs, apply: false, blobWrites: true, answers: { [MISSING_ORIGINAL.id]: "keep" } })).modules[0]!.migrations[0]!.plan!;
      expect(plan.counts, other).toMatchObject({ svgSanitized: 0, svgDemoted: 1, missingOriginals: 1 });
      const outcome = expectOk(await migrateSanitizing(db, blobs, stubSanitizer(), { [MISSING_ORIGINAL.id]: "keep" })).modules[0]!.migrations[0]!.outcome!;
      expect(outcome.counts, other).toMatchObject({ svgSanitized: 0, svgDemoted: 1, missingOriginals: 1 });
      const rows = await rowsOf(db);
      const svg = rows.find((r) => r.id === "s5")!;
      expect([svg.key, svg.svgSanitized === true], other).toEqual(["media/s5/badge-svg.bin", false]);
      expect(rows.find((r) => r.id === other)!.key, other).toBe(`media/${other}/badge.png`);
      const media = await createMediaDefault({ ...CONFIG, publicCopy: { prefix: "site/" } }, blobs, db, silentLogger);
      expectOk(await media.syncPublic());
      const published = expectOk(await blobs.list("site/")).map((b) => b.key);
      expect(published.filter((key) => key.endsWith(".svg")), other).toEqual([]);
    }
  });

  it("keeps an SVG whose original is missing an image from a cleaned copy in its id folder only when the sanitizer leaves that copy as it is", async () => {
    for (const [copy, expected] of [[CLEAN_SVG, { key: "media/s7/logo.svg", svgSanitized: true, checksum: sha(bytes(CLEAN_SVG)) }], [DIRTY_SVG, { key: "media/s7/logo-svg.bin", svgSanitized: false }]] as const) {
      const { db, blobs } = await oldStore([{ id: "s7", folder: "brand", filename: "logo.svg", contentType: "image/svg+xml" }], false);
      expectOk(await blobs.put("media/s7/logo.svg", bytes(copy)));
      const plan = expectOk(await runShapeMigrations({ storages: [storage({}, { sanitizeSvg: stubSanitizer() })], db, blobs, apply: false, blobWrites: true, answers: { [MISSING_ORIGINAL.id]: "keep" } })).modules[0]!.migrations[0]!.plan!;
      const sanitized = expected.svgSanitized ? 1 : 0;
      expect(plan.counts, copy).toMatchObject({ svgSanitized: sanitized, svgDemoted: 1 - sanitized, missingOriginals: 1 - sanitized });
      const outcome = expectOk(await migrateSanitizing(db, blobs, stubSanitizer(), { [MISSING_ORIGINAL.id]: "keep" })).modules[0]!.migrations[0]!.outcome!;
      expect(outcome.counts, copy).toMatchObject({ svgSanitized: sanitized, svgDemoted: 1 - sanitized, missingOriginals: 1 - sanitized });
      const row = (await rowsOf(db))[0]!;
      expect({ key: row.key, svgSanitized: row.svgSanitized === true, ...(expected.svgSanitized ? { checksum: row.checksum } : {}) }, copy).toEqual(expected);
      if (!expected.svgSanitized) expect(outcome.notes.some((n) => n.item === "s7" && n.reason.endsWith("is missing")), copy).toBe(true);
    }
  });

  it("calls the sanitizer for no item and writes nothing on a second run", async () => {
    const { db, blobs } = await oldStore(SVG_ITEMS, false);
    expectOk(await migrateSanitizing(db, blobs, stubSanitizer()));
    const calls: string[] = [];
    const counter = { writes: 0, crashAt: null };
    const again = expectOk(await runShapeMigrations({ storages: [storage({}, { sanitizeSvg: stubSanitizer(calls) })], db: counting(db, DB_WRITES, counter), blobs: counting(blobs, BLOB_WRITES, counter), apply: true, blobWrites: true }));
    expect(again.modules[0]!.state).toBe("current");
    expect(calls).toEqual([]);
    expect(counter.writes).toBe(0);
  });

  it("ends in the same state after an abort at any write", async () => {
    const reference = await oldStore(SVG_ITEMS, false);
    const counter = { writes: 0, crashAt: null };
    expectOk(await migrateSanitizing(counting(reference.db, DB_WRITES, counter), counting(reference.blobs, BLOB_WRITES, counter), stubSanitizer()));
    const expected = await snapshot(reference.db, reference.blobs);
    for (let crashAt = 1; crashAt <= counter.writes; crashAt += 1) {
      const { db, blobs } = await oldStore(SVG_ITEMS, false);
      const crashing = { writes: 0, crashAt };
      await expect(migrateSanitizing(counting(db, DB_WRITES, crashing), counting(blobs, BLOB_WRITES, crashing), stubSanitizer())).rejects.toBeInstanceOf(Crash);
      expectOk(await migrateSanitizing(db, blobs, stubSanitizer()));
      expect(await snapshot(db, blobs)).toEqual(expected);
    }
  });

  it("fails on a sanitized copy whose written bytes differ and keeps the 5.x key", async () => {
    const { db, blobs } = await oldStore([SVG_ITEMS[0]!], false);
    const tampering: Blobstore = { ...reading(blobs, []), put: (key, data, options) => blobs.put(key, key.startsWith("media/s1/") ? bytes("something else") : data, options) };
    const failed = expectErr(await migrateSanitizing(db, tampering, stubSanitizer()), "STORAGE_MIGRATION_FAILED");
    expect(failed.message).toContain("media/s1/logo.svg");
    expect((await rowsOf(db))[0]!.key).toBe("media/brand/logo.svg");
  });
});

describe("media-default storage: the start-up guard", () => {
  it("refuses 5.x data in check mode, naming the migration and the command", async () => {
    const { db, blobs } = await oldStore();
    await expect(module.setup(configSchema.parse({}), deps(db, blobs))).rejects.toThrow(/media-default:id-key-layout .*kestrel upgrade migrate --db <file> --blobs-dir <dir>/);
  });

  it("refuses 5.x data without reading a blob, also while the blob store answers only errors", async () => {
    const { db, blobs } = await oldStore();
    for (const storageMigrations of ["check", "apply"] as const) {
      const reads: string[] = [];
      await expect(module.setup(configSchema.parse({ storageMigrations }), deps(db, reading(blobs, reads)))).rejects.toThrow(/media-default:id-key-layout .*kestrel upgrade migrate/);
      expect(reads).toEqual([]);
      await expect(module.setup(configSchema.parse({ storageMigrations }), deps(db, unreachable))).rejects.toThrow(/media-default:id-key-layout .*kestrel upgrade migrate/);
    }
  });

  it("never runs the conversion at start-up, also with storageMigrations: apply", async () => {
    const { db, blobs } = await oldStore();
    await expect(module.setup(configSchema.parse({ storageMigrations: "apply" }), deps(db, blobs))).rejects.toThrow(/writes blobs never runs at start-up/);
    expect((await rowsOf(db)).every((r) => !r.key.startsWith(`media/${r.id}/`))).toBe(true);
    expect(expectOk(await blobs.list("media/")).map((b) => b.key).sort()).toEqual([...OLD_KEYS, "media/variants/b2/thumb.webp"].sort());
  });

  it("records the version row on a fresh store and starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-media-storage-"));
    tempDirs.push(root);
    const db = createPersistenceSqlite({ file: ":memory:" });
    const blobs = createBlobstoreFilesystem({ root });
    expectOk(await guardStorage(storage(), { db, blobs, mode: "check" }));
    expect(expectOk(await storageVersionOf(db, MODULE))).toMatchObject({ version: STORAGE_VERSION, migrations: [ID_KEY_LAYOUT] });
    await expect(module.setup(configSchema.parse({}), deps(db, blobs))).resolves.toBeDefined();
  });

  it("defaults storageMigrations to check", () => {
    expect(configSchema.parse({}).storageMigrations).toBe("check");
  });
});
