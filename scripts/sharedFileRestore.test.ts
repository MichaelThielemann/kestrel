import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it, expect } from "vitest";
import { BLOBSTORE, type Blobstore } from "../packages/contracts/src/blobstore.ts";
import { boundaryCast } from "../packages/core/src/cast.ts";
import type { Contract } from "../packages/core/src/defineContract.ts";
import type { Deps } from "../packages/core/src/defineModule.ts";
import { failure } from "../packages/core/src/errors.ts";
import { silentLogger } from "../packages/core/src/logger.ts";
import { err, ok } from "../packages/core/src/result.ts";
import backupBlobstore, { configSchema as backupConfigSchema } from "../packages/backup-blobstore/module.ts";
import type { Backup } from "../packages/backup-blobstore/impl.ts";
import replicationSqlite, { configSchema as replicationConfigSchema } from "../packages/replication-sqlite/module.ts";
import type { Replication } from "../packages/replication-sqlite/impl.ts";
import { fileBirthMs, freshnessOf } from "../packages/replication-sqlite/restoreFreshness.ts";

function fakeBlobs(): Blobstore & { blobs: Map<string, Uint8Array>; calls: string[] } {
  const blobs = new Map<string, Uint8Array>();
  const calls: string[] = [];
  return {
    blobs,
    calls,
    async put(key, data) {
      calls.push(`put:${key}`);
      blobs.set(key, new Uint8Array(data));
      return ok();
    },
    async get(key) {
      calls.push(`get:${key}`);
      return ok(blobs.get(key) ?? null);
    },
    async remove(key) {
      blobs.delete(key);
      return ok();
    },
    async move(from, to) {
      const b = blobs.get(from);
      if (!b) return err(failure("NOT_FOUND", `${from} not found`));
      blobs.set(to, b);
      blobs.delete(from);
      return ok();
    },
    async list(prefix) {
      return ok([...blobs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: blobs.get(key)?.byteLength ?? 0 })));
    },
  };
}

function deps(blobs: Blobstore, root: string, bootStartedAt: number): Deps {
  return {
    get<T>(contract: Contract<T>): T {
      if (contract.name !== BLOBSTORE.name) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(blobs, "host");
    },
    find: <T>(): T | undefined => undefined,
    logger: silentLogger,
    root,
    bootStartedAt,
    eventTriggers: [],
  };
}

function emptySqliteDb(): Uint8Array {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-shared-seed-"));
  const file = join(dir, "seed.db");
  const db = new DatabaseSync(file);
  db.close();
  const bytes = readFileSync(file);
  rmSync(dir, { recursive: true, force: true });
  return new Uint8Array(bytes);
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("replication-sqlite and backup-blobstore configured on the same file", () => {
  for (const order of ["replication-first", "backup-first"] as const) {
    it(`boots cleanly on a fresh disk with a restore point for both, exactly one restore happening (${order})`, async () => {
      const bootStartedAt = Date.now();
      const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-shared-"));
      dirs.push(dir);
      const file = join(dir, "kestrel.db");
      const blobs = fakeBlobs();
      const seed = emptySqliteDb();
      blobs.blobs.set("replica/gen/20260101T000000Z/snapshot.db", seed);
      blobs.blobs.set("backups/db", seed);

      const replicationConfig = replicationConfigSchema.parse({ file, prefix: "replica/" });
      const backupConfig = backupConfigSchema.parse({ file, key: "backups/db" });

      const run = async (): Promise<[Replication | Backup, Replication | Backup]> => {
        if (order === "replication-first") {
          const r = boundaryCast<Replication>(await replicationSqlite.setup(replicationConfig, deps(blobs, dir, bootStartedAt)), "host");
          const b = boundaryCast<Backup>(await backupBlobstore.setup(backupConfig, deps(blobs, dir, bootStartedAt)), "host");
          return [r, b];
        }
        const b = boundaryCast<Backup>(await backupBlobstore.setup(backupConfig, deps(blobs, dir, bootStartedAt)), "host");
        const r = boundaryCast<Replication>(await replicationSqlite.setup(replicationConfig, deps(blobs, dir, bootStartedAt)), "host");
        return [b, r];
      };

      const [first] = await run();
      expect(existsSync(file)).toBe(true);
      expect(blobs.calls.filter((c) => c.startsWith("get:"))).toHaveLength(1);
      if ("close" in first) first.close();
    });
  }

  it("still fails when the file turned up fresh this boot without either module having restored it", async () => {
    const bootStartedAt = Date.now();
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-shared-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.close();
    if (freshnessOf(fileBirthMs(file), bootStartedAt) !== "fresh") return;

    const blobs = fakeBlobs();
    blobs.blobs.set("backups/db", emptySqliteDb());
    const backupConfig = backupConfigSchema.parse({ file, key: "backups/db" });

    await expect(backupBlobstore.setup(backupConfig, deps(blobs, dir, bootStartedAt))).rejects.toThrow(/was created during this start-up while the backup holds a restore point/);
  });
});
