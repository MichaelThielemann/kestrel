import { describe, expect, it } from "vitest";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { PERSISTENCE, type Document, type Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { guardStorage, runShapeMigrations, storageVersionOf } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createPersistenceSqlite } from "@michaelthielemann/kestrel-persistence-sqlite/impl";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import module, { configSchema } from "./module.ts";
import { RETIRED, VARIANTS } from "./impl.ts";
import { MODULE, STORAGE_VERSION, VARIANT_SLOTS, migrations, storage } from "./storage.ts";

const OLD_VARIANTS_SCHEMA = { mediaId: "string", size: "string", spec: "string", width: "number", height: "number", format: "string", key: "string", bytes: "number", state: "string", error: "json", attempts: "number", updatedAt: "number" } as const;
const OLD_RETIRED_SCHEMA = { mediaId: "string", file: "string", retiredAt: "number" } as const;

function noBlobs(): Blobstore {
  return {
    async put() { return ok(); },
    async get() { return ok(null); },
    async remove() { return ok(); },
    async move(from) { return err(failure("NOT_FOUND", from)); },
    async list() { return ok([]); },
  };
}

class Crash extends Error {}

function counting(target: Persistence, counter: { writes: number; crashAt: number | null }): Persistence {
  const writes = ["createOne", "createMany", "updateOne", "updateMany", "deleteOne", "deleteMany"];
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

function variant(id: string, mediaId: string | null, size: string | null, state: string, updatedAt: number) {
  return { id, mediaId, size, spec: "s", width: 1, height: 1, format: "webp", key: `media-variants/${mediaId ?? "x"}/${size ?? "x"}.webp`, bytes: 10, state, error: null, attempts: 0, updatedAt };
}

async function oldStore(): Promise<Persistence> {
  const db = createPersistenceSqlite({ file: ":memory:" });
  expectOk(await db.ensureCollection(VARIANTS, OLD_VARIANTS_SCHEMA));
  for (const row of [
    variant("v01", "m1", "thumb", "done", 10),
    variant("v02", "m1", "thumb", "done", 5),
    variant("v03", "m1", "thumb", "pending", 20),
    variant("v04", "m1", "hero", "pending", 1),
    variant("v05", "m2", "thumb", "error", 3),
    variant("v06", "m2", "thumb", "error", 4),
    variant("v07", "m3", "thumb", "done", 1),
    variant("v08", "m3", "hero", "done", 1),
    variant("v09", "m3", "card", "done", 1),
    variant("v10", "m4", null, "done", 1),
  ]) expectOk(await db.createOne(VARIANTS, row));
  expectOk(await db.ensureCollection(RETIRED, OLD_RETIRED_SCHEMA));
  expectOk(await db.createOne(RETIRED, { id: "r1", mediaId: "m1", file: "thumb.jpg", retiredAt: 1 }));
  expectOk(await db.createOne(RETIRED, { id: "r2", mediaId: "m1", file: "thumb.jpg", retiredAt: 2 }));
  expectOk(await db.createOne(RETIRED, { id: "r3", mediaId: "m2", file: null, retiredAt: 3 }));
  return db;
}

async function migrate(db: Persistence) {
  return runShapeMigrations({ storages: [storage()], db, blobs: noBlobs(), apply: true, blobWrites: false, now: () => 1 });
}

async function snapshot(db: Persistence) {
  const variants = expectOk(await db.findMany<Document>(VARIANTS, {}, { sort: { id: "asc" }, limit: 100 })).items.map((r) => [r.id, r.slot]);
  const retired = expectOk(await db.findMany<Document>(RETIRED, {}, { sort: { id: "asc" }, limit: 100 })).items.map((r) => [r.id, r.slot]);
  const version = expectOk(await storageVersionOf(db, MODULE));
  return { variants, retired, version: version === null ? null : [version.version, version.migrations] };
}

describe("images-default storage: slots for 5.x variant rows", () => {
  it("exports the migration as a row-only one that runs after media/default's", () => {
    expect(migrations.map((m) => [m.id, m.introducedIn, m.kind, m.blobWrites])).toEqual([[VARIANT_SLOTS, "6.0.0", "auto", false]]);
    expect(storage().dependsOn).toEqual(["media/default"]);
  });

  it("plans the slots and the dropped duplicates without writing", async () => {
    const db = await oldStore();
    const counter = { writes: 0, crashAt: null };
    const report = expectOk(await runShapeMigrations({ storages: [storage()], db: counting(db, counter), blobs: noBlobs(), apply: false, blobWrites: false }));
    const run = report.modules[0]!.migrations[0]!;
    expect(run.detected.pending).toBe(13);
    expect(run.plan?.counts).toEqual({ variants: 10, duplicateVariants: 3, unusableVariants: 1, retired: 3, unusableRetired: 1 });
    expect(counter.writes).toBe(0);
  });

  it("gives every slot one row, keeping the newest finished one, and reports the rest", async () => {
    const db = await oldStore();
    const report = expectOk(await migrate(db));
    expect(report.modules[0]!.state).toBe("migrated");
    expect((await snapshot(db)).variants).toEqual([["v01", "m1/thumb"], ["v04", "m1/hero"], ["v06", "m2/thumb"], ["v07", "m3/thumb"], ["v08", "m3/hero"], ["v09", "m3/card"]]);
    expect((await snapshot(db)).retired).toEqual([["r1", "m1/thumb.jpg"]]);
    const outcome = report.modules[0]!.migrations[0]!.outcome!;
    expect(outcome.counts).toEqual({ variantsSlotted: 6, variantsDropped: 4, retiredSlotted: 1, retiredDropped: 2 });
    expect(outcome.notes.map((n) => n.item).sort()).toEqual(["r2", "r3", "v02", "v03", "v05", "v10"]);
    expect(expectOk(await storageVersionOf(db, MODULE))).toMatchObject({ version: STORAGE_VERSION, migrations: [VARIANT_SLOTS] });
  });

  it("writes nothing on a second run", async () => {
    const db = await oldStore();
    expectOk(await migrate(db));
    const counter = { writes: 0, crashAt: null };
    expect(expectOk(await migrate(counting(db, counter))).modules[0]!.state).toBe("current");
    expect(counter.writes).toBe(0);
  });

  it("ends in the same state after an abort while dropping duplicates, while filling retired slots and before the version row", async () => {
    const reference = await oldStore();
    expectOk(await migrate(reference));
    const expected = await snapshot(reference);
    for (const crashAt of [2, 11, 14]) {
      const db = await oldStore();
      await expect(migrate(counting(db, { writes: 0, crashAt }))).rejects.toBeInstanceOf(Crash);
      expect(await snapshot(db)).not.toEqual(expected);
      expectOk(await migrate(db));
      expect(await snapshot(db)).toEqual(expected);
    }
  });
});

describe("images-default storage: the start-up guard", () => {
  function deps(db: Persistence) {
    return {
      get<T>(contract: { name: string }): T {
        if (contract === BLOBSTORE) return boundaryCast<T>(noBlobs(), "host");
        if (contract === PERSISTENCE) return boundaryCast<T>(db, "host");
        throw new Error(`unexpected contract ${contract.name}`);
      },
      find: () => undefined,
      logger: silentLogger,
      root: process.cwd(),
      eventTriggers: [],
    };
  }

  it("refuses unslotted rows in check mode, naming the migration and how to run it", async () => {
    const db = await oldStore();
    await expect(module.setup(configSchema.parse({}), deps(db))).rejects.toThrow(/images-default:variant-slots .*set storageMigrations: "apply"/);
    expect(expectOk(await db.count(VARIANTS, {}))).toBe(10);
  });

  it("runs the migration at start-up in apply mode", async () => {
    const db = await oldStore();
    expect(expectOk(await guardStorage(storage(), { db, blobs: noBlobs(), mode: "apply" })).state).toBe("migrated");
    expectErr(await guardStorage({ ...storage(), version: "5.9.0" }, { db, blobs: noBlobs(), mode: "check" }), "STORAGE_REFUSED");
  });

  it("defaults storageMigrations to check", () => {
    expect(configSchema.parse({}).storageMigrations).toBe("check");
  });
});
