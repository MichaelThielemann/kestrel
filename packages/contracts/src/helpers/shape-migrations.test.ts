import { describe, expect, it } from "vitest";
import type { Blobstore } from "../blobstore.ts";
import { err, failure, isErr, ok, type Result } from "../errors.ts";
import type { Document, Persistence } from "../persistence.ts";
import { createFakePersistence } from "../testing/fakePersistence.ts";
import { expectErr, expectOk } from "../testing/result.ts";
import {
  OFFLINE_COMMAND,
  STORAGE_VERSIONS,
  STORAGE_VERSIONS_SCHEMA,
  blobOpsOf,
  compareVersions,
  guardStorage,
  orderStorages,
  runShapeMigrations,
  sha256Of,
  storageVersionOf,
  type MigrationContext,
  type ModuleStorage,
  type ShapeMigration,
} from "./shape-migrations.ts";

function memoryBlobs(): Blobstore & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    async put(key, data) { map.set(key, data); return ok(); },
    async get(key) { return ok(map.get(key) ?? null); },
    async remove(key) { map.delete(key); return ok(); },
    async move(from, to) { const data = map.get(from); if (data === undefined) return err(failure("NOT_FOUND", from)); map.set(to, data); map.delete(from); return ok(); },
    async list(prefix) { return ok([...map].filter(([k]) => k.startsWith(prefix)).map(([key, data]) => ({ key, size: data.byteLength }))); },
  };
}

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

interface Thing extends Document {
  key: string;
  moved: boolean | null;
}

async function seedThings(db: Persistence, blobs: Blobstore, n: number): Promise<void> {
  expectOk(await db.ensureCollection("things", { key: "string", moved: "boolean" }));
  for (let i = 0; i < n; i += 1) {
    const id = `t${String(i).padStart(2, "0")}`;
    expectOk(await db.createOne<Thing>("things", { id, key: `old/${id}`, moved: null }));
    expectOk(await blobs.put(`old/${id}`, new TextEncoder().encode(`bytes of ${id}`)));
  }
}

function moveThings(order: string[] = [], introducedIn = "6.0.0", id = "things:new-keys"): ShapeMigration {
  const unmoved = async (ctx: MigrationContext) => {
    expectOk(await ctx.db.ensureCollection("things", { key: "string", moved: "boolean" }));
    const rows = await ctx.db.findMany<Thing>("things", { moved: { eq: null } }, { sort: { id: "asc" }, limit: 1000 });
    return isErr(rows) ? rows : ok(rows.value.items);
  };
  return {
    id,
    introducedIn,
    kind: "auto",
    blobWrites: true,
    summary: "moves things to new keys",
    async detect(ctx) {
      order.push(`detect ${id}`);
      const rows = await unmoved(ctx);
      return isErr(rows) ? rows : ok({ pending: rows.value.length, sample: rows.value.map((r) => r.id) });
    },
    async plan(ctx) {
      const rows = await unmoved(ctx);
      return isErr(rows) ? rows : ok({ counts: { things: rows.value.length }, notes: [] });
    },
    async apply(ctx) {
      order.push(`apply ${id}`);
      const rows = await unmoved(ctx);
      if (isErr(rows)) return rows;
      for (const row of rows.value) {
        const copied = await ctx.blobOps.copy(row.key, `new/${row.id}`);
        if (isErr(copied)) return copied;
        const switched = await ctx.db.updateOne<Thing>("things", row.id, { key: `new/${row.id}`, moved: true });
        if (isErr(switched)) return switched;
      }
      return ok({ counts: { moved: rows.value.length }, notes: [] });
    },
  };
}

function rowOnly(order: string[], id: string, introducedIn: string, pending = 0): ShapeMigration {
  let left = pending;
  return {
    id,
    introducedIn,
    kind: "auto",
    blobWrites: false,
    summary: id,
    async detect() { order.push(`detect ${id}`); return ok({ pending: left, sample: [] }); },
    async plan() { return ok({ counts: {}, notes: [] }); },
    async apply() { order.push(`apply ${id}`); left = 0; return ok({ counts: {}, notes: [] }); },
  };
}

function storage(module: string, migrations: ShapeMigration[], dependsOn: string[] = []): ModuleStorage {
  return { module, version: "6.0.0", convertsFrom: "5.0.0", dependsOn, migrations };
}

async function stateOf(db: Persistence, blobs: ReturnType<typeof memoryBlobs>) {
  const rows = expectOk(await db.findMany<Thing>("things", {}, { sort: { id: "asc" }, limit: 1000 })).items;
  const version = expectOk(await storageVersionOf(db, "things/default"));
  return {
    rows: rows.map((r) => ({ id: r.id, key: r.key, moved: r.moved })),
    blobs: [...blobs.map].map(([key, data]) => [key, sha256Of(data)]).sort(),
    version: version === null ? null : { version: version.version, migrations: version.migrations },
  };
}

describe("shape-migrations: versions", () => {
  it("compares versions numerically and ignores a pre-release suffix", () => {
    expect(compareVersions("6.0.0", "6.0.0")).toBe(0);
    expect(compareVersions("5.10.0", "5.9.3")).toBe(1);
    expect(compareVersions("6.0.0-rc.1", "6.0.0")).toBe(0);
    expect(compareVersions("4.9.9", "5.0.0")).toBe(-1);
  });
});

describe("shape-migrations: order", () => {
  it("runs modules after the modules they depend on, and a module's migrations by the release that introduced them", async () => {
    const order: string[] = [];
    const db = createFakePersistence();
    const storages = [
      storage("b/images", [rowOnly(order, "b:second", "6.1.0", 1), rowOnly(order, "b:first", "6.0.0", 1)], ["z/media"]),
      storage("z/media", [rowOnly(order, "z:only", "6.0.0", 1)]),
      storage("a/other", [rowOnly(order, "a:only", "6.0.0", 1)]),
    ];
    expect(orderStorages(storages).map((s) => s.module)).toEqual(["a/other", "z/media", "b/images"]);
    expectOk(await runShapeMigrations({ storages, db, blobs: memoryBlobs(), apply: true, blobWrites: true }));
    expect(order.filter((o) => o.startsWith("apply"))).toEqual(["apply a:only", "apply z:only", "apply b:first", "apply b:second"]);
  });

  it("refuses modules that depend on each other in a cycle", () => {
    expect(() => orderStorages([storage("a", [], ["b"]), storage("b", [], ["a"])])).toThrow(/cycle/);
  });

  it("leaves a module's migrations pending while a module it depends on still waits", async () => {
    const order: string[] = [];
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    await seedThings(db, blobs, 2);
    const report = expectOk(await runShapeMigrations({
      storages: [storage("things/default", [moveThings(order)]), storage("images/x", [rowOnly(order, "images:slots", "6.0.0", 3)], ["things/default"])],
      db, blobs, apply: true, blobWrites: false,
    }));
    expect(report.modules.map((m) => [m.module, m.state, m.migrations[0]?.blocked])).toEqual([["things/default", "pending", "blob-writes"], ["images/x", "pending", "dependency-pending"]]);
    expect(order).not.toContain("apply images:slots");
  });
});

describe("shape-migrations: the run loop", () => {
  it("applies, verifies and only then writes the version row", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    await seedThings(db, blobs, 3);
    const report = expectOk(await runShapeMigrations({ storages: [storage("things/default", [moveThings()])], db, blobs, apply: true, blobWrites: true, now: () => 42 }));
    expect(report.modules[0]).toMatchObject({ state: "migrated", stored: null, version: "6.0.0", migrations: [{ id: "things:new-keys", state: "applied", detected: { pending: 3 }, outcome: { counts: { moved: 3 } } }] });
    const state = await stateOf(db, blobs);
    expect(state.version).toEqual({ version: "6.0.0", migrations: ["things:new-keys"] });
    expect(state.rows.every((r) => r.key === `new/${r.id}`)).toBe(true);
    expect([...blobs.map.keys()].filter((k) => k.startsWith("old/"))).toHaveLength(3);
  });

  it("writes no version row when verify still finds the old form", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    await seedThings(db, blobs, 1);
    const lazy: ShapeMigration = { ...moveThings(), apply: async () => ok({ counts: {}, notes: [] }) };
    const failed = expectErr(await runShapeMigrations({ storages: [storage("things/default", [lazy])], db, blobs, apply: true, blobWrites: true }), "STORAGE_MIGRATION_FAILED");
    expect(failed.message).toMatch(/things:new-keys left 1 item\(s\) in the old form/);
    expect(expectOk(await storageVersionOf(db, "things/default"))).toBeNull();
  });

  it("writes nothing on a second run", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    await seedThings(db, blobs, 3);
    const storages = [storage("things/default", [moveThings()])];
    expectOk(await runShapeMigrations({ storages, db, blobs, apply: true, blobWrites: true }));
    const counter = { writes: 0, crashAt: null };
    const second = expectOk(await runShapeMigrations({ storages, db: counting(db, DB_WRITES, counter), blobs: counting(blobs, BLOB_WRITES, counter), apply: true, blobWrites: true }));
    expect(second.modules[0]!.state).toBe("current");
    expect(counter.writes).toBe(0);
  });

  it("plans without writing when apply is off", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    await seedThings(db, blobs, 2);
    const counter = { writes: 0, crashAt: null };
    const report = expectOk(await runShapeMigrations({ storages: [storage("things/default", [moveThings()])], db: counting(db, DB_WRITES, counter), blobs: counting(blobs, BLOB_WRITES, counter), apply: false, blobWrites: true }));
    expect(report.modules[0]).toMatchObject({ state: "pending", migrations: [{ state: "pending", blocked: "plan-only", plan: { counts: { things: 2 } } }] });
    expect(counter.writes).toBe(0);
  });

  it("records the version row on data that needs no migration when asked to", async () => {
    const db = createFakePersistence();
    const report = expectOk(await runShapeMigrations({ storages: [storage("things/default", [moveThings()])], db, blobs: memoryBlobs(), apply: false, blobWrites: false, recordWhenCurrent: true }));
    expect(report.modules[0]!.state).toBe("recorded");
    expect(expectOk(await storageVersionOf(db, "things/default"))).toMatchObject({ version: "6.0.0", migrations: ["things:new-keys"] });
  });

  it("writes no version row when apply is off and nothing is pending", async () => {
    const db = createFakePersistence();
    const counter = { writes: 0, crashAt: null };
    const report = expectOk(await runShapeMigrations({ storages: [storage("things/default", [moveThings()])], db: counting(db, DB_WRITES, counter), blobs: memoryBlobs(), apply: false, blobWrites: true }));
    expect(report.modules[0]).toMatchObject({ state: "unrecorded", stored: null, migrations: [{ id: "things:new-keys", state: "not-needed" }] });
    expect(counter.writes).toBe(0);
    expect(expectOk(await storageVersionOf(db, "things/default"))).toBeNull();
  });

  it("records the version row through the start-up guard in check mode on data that needs no migration", async () => {
    const db = createFakePersistence();
    expect(expectOk(await guardStorage(storage("things/default", [moveThings()]), { db, blobs: memoryBlobs(), mode: "check" })).state).toBe("recorded");
    expect(expectOk(await storageVersionOf(db, "things/default"))).toMatchObject({ version: "6.0.0" });
  });

  it("runs only the migrations introduced after the stored version", async () => {
    const order: string[] = [];
    const db = createFakePersistence();
    expectOk(await db.ensureCollection(STORAGE_VERSIONS, STORAGE_VERSIONS_SCHEMA));
    expectOk(await db.createOne(STORAGE_VERSIONS, { module: "m/x", version: "6.0.0", migrations: ["m:a"], updatedAt: 1 }));
    const report = expectOk(await runShapeMigrations({ storages: [{ module: "m/x", version: "6.1.0", convertsFrom: "5.0.0", migrations: [rowOnly(order, "m:a", "6.0.0", 1), rowOnly(order, "m:b", "6.1.0", 1)] }], db, blobs: memoryBlobs(), apply: true, blobWrites: false }));
    expect(order).toEqual(["detect m:b", "apply m:b", "detect m:b"]);
    expect(report.modules[0]!.state).toBe("migrated");
    expect(expectOk(await storageVersionOf(db, "m/x"))).toMatchObject({ version: "6.1.0", migrations: ["m:a", "m:b"] });
  });

  it("refuses data older than the module converts and names the major to update through first", async () => {
    const db = createFakePersistence();
    expectOk(await db.ensureCollection(STORAGE_VERSIONS, STORAGE_VERSIONS_SCHEMA));
    expectOk(await db.createOne(STORAGE_VERSIONS, { module: "things/default", version: "4.2.0", migrations: [], updatedAt: 1 }));
    const refused = expectErr(await guardStorage(storage("things/default", [moveThings()]), { db, blobs: memoryBlobs(), mode: "apply" }), "STORAGE_REFUSED");
    expect(refused.message).toMatch(/storage version 4\.2\.0, older than this release converts; update through 5\.x first/);
  });

  it("refuses data written by a newer release", async () => {
    const db = createFakePersistence();
    expectOk(await db.ensureCollection(STORAGE_VERSIONS, STORAGE_VERSIONS_SCHEMA));
    expectOk(await db.createOne(STORAGE_VERSIONS, { module: "things/default", version: "7.0.0", migrations: [], updatedAt: 1 }));
    const refused = expectErr(await guardStorage(storage("things/default", [moveThings()]), { db, blobs: memoryBlobs(), mode: "check" }), "STORAGE_REFUSED");
    expect(refused.message).toMatch(/storage version 7\.0\.0, newer than 6\.0\.0/);
  });

  it("fails when the version collection holds rows it did not write", async () => {
    const db = createFakePersistence();
    expectOk(await db.ensureCollection(STORAGE_VERSIONS, { name: "string" }));
    expectOk(await db.createOne(STORAGE_VERSIONS, { name: "someone else's row" }));
    const failed = expectErr(await runShapeMigrations({ storages: [], db, blobs: memoryBlobs(), apply: true, blobWrites: true }), "STORAGE_MIGRATION_FAILED");
    expect(failed.message).toMatch(/another component uses this collection name/);
  });

  it("fails instead of throwing when a version row holds a version of another form", async () => {
    const db = createFakePersistence();
    expectOk(await db.ensureCollection(STORAGE_VERSIONS, STORAGE_VERSIONS_SCHEMA));
    expectOk(await db.createOne(STORAGE_VERSIONS, { module: "things/default", version: "6.0", migrations: [], updatedAt: 1 }));
    const storages = [storage("things/default", [moveThings()])];
    expect(expectErr(await runShapeMigrations({ storages, db, blobs: memoryBlobs(), apply: true, blobWrites: true }), "STORAGE_MIGRATION_FAILED").message).toMatch(/not a storage version row; another component uses this collection name/);
    expectErr(await guardStorage(storages[0]!, { db, blobs: memoryBlobs(), mode: "check" }), "STORAGE_MIGRATION_FAILED");
  });
});

describe("shape-migrations: interrupted runs", () => {
  async function finalStateAfterCrashAt(crashAt: number | null) {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    await seedThings(db, blobs, 4);
    const storages = [storage("things/default", [moveThings()])];
    const counter = { writes: 0, crashAt };
    const first = runShapeMigrations({ storages, db: counting(db, DB_WRITES, counter), blobs: counting(blobs, BLOB_WRITES, counter), apply: true, blobWrites: true, now: () => 1 });
    if (crashAt === null) expectOk(await first);
    else await expect(first).rejects.toBeInstanceOf(Crash);
    expectOk(await runShapeMigrations({ storages, db, blobs, apply: true, blobWrites: true, now: () => 1 }));
    return stateOf(db, blobs);
  }

  it("ends in the same state after an abort during the blob copies, between row switches, and before the version row", async () => {
    const uninterrupted = await finalStateAfterCrashAt(null);
    expect(await finalStateAfterCrashAt(1)).toEqual(uninterrupted);
    expect(await finalStateAfterCrashAt(4)).toEqual(uninterrupted);
    expect(await finalStateAfterCrashAt(9)).toEqual(uninterrupted);
  });
});

describe("shape-migrations: the start-up guard", () => {
  it("refuses in check mode and names the migration and the command", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    await seedThings(db, blobs, 2);
    const refused = expectErr(await guardStorage(storage("things/default", [moveThings()]), { db, blobs, mode: "check" }), "STORAGE_REFUSED");
    expect(refused.message).toContain("things:new-keys");
    expect(refused.message).toContain(OFFLINE_COMMAND);
    expect(refused.message).toContain("kestrel update");
  });

  it("never runs a migration that writes blobs, also in apply mode", async () => {
    const db = createFakePersistence();
    const blobs = memoryBlobs();
    await seedThings(db, blobs, 2);
    const before = [...blobs.map.keys()];
    const refused = expectErr(await guardStorage(storage("things/default", [moveThings()]), { db, blobs, mode: "apply" }), "STORAGE_REFUSED");
    expect(refused.message).toMatch(/never runs at start-up/);
    expect([...blobs.map.keys()]).toEqual(before);
    expect(expectOk(await storageVersionOf(db, "things/default"))).toBeNull();
  });

  it("runs a migration without blob writes in apply mode, and refuses it in check mode", async () => {
    const order: string[] = [];
    const db = createFakePersistence();
    const checked = expectErr(await guardStorage(storage("rows/default", [rowOnly(order, "rows:fill", "6.0.0", 2)]), { db, blobs: memoryBlobs(), mode: "check" }), "STORAGE_REFUSED");
    expect(checked.message).toMatch(/rows:fill .*set storageMigrations: "apply"/);
    const applied = expectOk(await guardStorage(storage("rows/default", [rowOnly(order, "rows:fill", "6.0.0", 2)]), { db, blobs: memoryBlobs(), mode: "apply" }));
    expect(applied.state).toBe("migrated");
  });
});

describe("shape-migrations: blob operations over blobstore@1", () => {
  it("copies by reading and writing, and heads with size and sha256", async () => {
    const blobs = memoryBlobs();
    const ops = blobOpsOf(blobs);
    expectOk(await blobs.put("a", new Uint8Array([1, 2, 3])));
    expectOk(await ops.copy("a", "b"));
    expect(expectOk(await ops.head("b"))).toEqual({ size: 3, sha256: sha256Of(new Uint8Array([1, 2, 3])) });
    expect(expectOk(await ops.head("missing"))).toBeNull();
    const missing: Result<void, unknown> = await ops.copy("missing", "c");
    expect(missing.ok).toBe(false);
    expect(blobs.map.has("a")).toBe(true);
  });
});
