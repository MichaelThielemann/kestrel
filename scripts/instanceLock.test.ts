import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BLOBSTORE, type Blobstore } from "../packages/contracts/src/blobstore.ts";
import { boot, checkBoot, type BootInput, type Kestrel } from "../packages/core/src/boot.ts";
import { boundaryCast } from "../packages/core/src/cast.ts";
import { defineModule, type ModuleDefinition } from "../packages/core/src/defineModule.ts";
import { definePipeline } from "../packages/core/src/definePipeline.ts";
import { failure, isKestrelBootError } from "../packages/core/src/errors.ts";
import { instanceLockFile } from "../packages/core/src/instanceLock.ts";
import { silentLogger } from "../packages/core/src/logger.ts";
import { err, ok } from "../packages/core/src/result.ts";
import backupBlobstore from "../packages/backup-blobstore/module.ts";
import blobstoreFilesystem from "../packages/blobstore-filesystem/module.ts";
import persistenceSqlite from "../packages/persistence-sqlite/module.ts";
import replicationSqlite from "../packages/replication-sqlite/module.ts";
import { sandboxBootInput } from "../packages/upgrade/src/sandbox.ts";
import { copyProject, MINIMAL, runCli } from "../packages/cli/test/harness.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "fixtures", "upgrade", "5.8.1");

const dirs: string[] = [];
const booted: Kestrel[] = [];
afterEach(async () => {
  for (const kestrel of booted.splice(0)) await kestrel.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-lock-boot-")));
  dirs.push(dir);
  return dir;
}

function lockFileOf(file: string): string {
  const path = instanceLockFile(file);
  if (path === undefined) throw new Error(`${file} names no lock file`);
  return path;
}

function holdForeignLock(file: string): string {
  const now = new Date().toISOString();
  const content = JSON.stringify({ instanceId: randomUUID(), pid: 4242, pidNamespace: "pid:[4026530001]", processStart: "1", clockStart: 1, bootId: randomUUID(), host: "other-host", startedAt: now, heartbeatAt: now, ttlMs: 60_000, threads: { [randomUUID()]: now } });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(lockFileOf(file), content);
  return content;
}

function checksums(paths: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(paths.map((path) => [path, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null]));
}

function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected boot to fail");
    },
    (error: unknown) => error,
  );
}

function tree(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? tree(join(dir, entry.name), base) : [join(dir, entry.name).slice(base.length + 1)]));
}

interface RecordingBlobs {
  module: ModuleDefinition;
  blobs: Map<string, Uint8Array>;
  puts: Array<{ key: string; locked: boolean }>;
}

function recordingBlobstore(lockFile: string): RecordingBlobs {
  const blobs = new Map<string, Uint8Array>();
  const puts: Array<{ key: string; locked: boolean }> = [];
  const store: Blobstore = {
    async put(key, data) {
      puts.push({ key, locked: existsSync(lockFile) });
      blobs.set(key, new Uint8Array(data));
      return ok();
    },
    async get(key) {
      return ok(blobs.get(key) ?? null);
    },
    async remove(key) {
      blobs.delete(key);
      return ok();
    },
    async move(from, to) {
      const blob = blobs.get(from);
      if (!blob) return err(failure("NOT_FOUND", `${from} not found`));
      blobs.set(to, blob);
      blobs.delete(from);
      return ok();
    },
    async list(prefix) {
      return ok([...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, size: blobs.get(key)?.byteLength ?? 0 })));
    },
  };
  const module = defineModule({ name: "blobstore/recording", provides: [BLOBSTORE], requires: [], configSchema: z.object({}).strict(), setup: async (): Promise<Blobstore> => store });
  return { module, blobs, puts };
}

function storageInput(blobs: ModuleDefinition, blobsConfig: Record<string, unknown>, replication: Record<string, unknown>, persistence: Record<string, unknown>, root: string): BootInput {
  return {
    config: {
      modules: [
        { use: "./blobs", config: blobsConfig },
        { use: "@michaelthielemann/kestrel-replication-sqlite", config: replication },
        { use: "@michaelthielemann/kestrel-persistence-sqlite", config: persistence },
      ],
      triggers: [],
      http: null,
    },
    modules: [blobs, replicationSqlite, persistenceSqlite],
    pipelines: [definePipeline({ name: "sync", steps: ["replication.sync"] })],
    logger: silentLogger,
    root,
  };
}

function rowCount(file: string, table: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return boundaryCast<{ n: number }>(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get(), "host").n;
  } finally {
    db.close();
  }
}

describe("instance lock across the storage modules of one boot", () => {
  it("refuses a boot on a file another process holds, naming its host and PID, before any module changes a file", async () => {
    const dir = freshDir();
    const file = join(dir, "data", "kestrel.db");
    mkdirSync(dirname(file), { recursive: true });
    const app = new DatabaseSync(file);
    app.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id TEXT PRIMARY KEY)");
    app.prepare("INSERT INTO t (id) VALUES ('kept')").run();
    writeFileSync(`${file}.restore`, "staged");
    const held = holdForeignLock(file);
    const files = [file, `${file}-wal`, `${file}-shm`, `${file}.restore`, lockFileOf(file)];
    const before = checksums(files);
    const recording = recordingBlobstore(lockFileOf(file));

    const error = await failureOf(boot(storageInput(recording.module, {}, { file }, { file }, dir)));

    expect(isKestrelBootError(error)).toBe(true);
    expect(error).toMatchObject({ code: "instance-locked", module: "replication/sqlite" });
    expect(String(error)).toContain('host "other-host", pid 4242');
    expect(checksums(files)).toEqual(before);
    expect(readFileSync(lockFileOf(file), "utf8")).toBe(held);
    app.close();
  });

  it("shares one lock between replication and persistence and gives it up only after the teardown seal", async () => {
    const dir = freshDir();
    const file = join(dir, "kestrel.db");
    const recording = recordingBlobstore(lockFileOf(file));
    const kestrel = await boot(storageInput(recording.module, {}, { file }, { file }, dir));
    expect(existsSync(lockFileOf(file))).toBe(true);
    const app = new DatabaseSync(file);
    app.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    app.prepare("INSERT INTO t (id) VALUES ('late')").run();
    app.close();

    await kestrel.stop();

    const sealed = recording.puts.filter((put) => put.key.endsWith("/sealed.json"));
    expect(sealed).toHaveLength(1);
    expect(recording.puts.every((put) => put.locked)).toBe(true);
    expect(existsSync(lockFileOf(file))).toBe(false);
    expect([...recording.blobs.keys()].filter((key) => key.includes(".instance"))).toEqual([]);
  });

  it("rejects allowConcurrentProcesses set on one module of a file and not on another as a configuration error, leaving no lock behind", async () => {
    for (const [replication, persistence, failing] of [
      [{}, { allowConcurrentProcesses: true }, "persistence/sqlite"],
      [{ allowConcurrentProcesses: true }, {}, "persistence/sqlite"],
    ] as const) {
      const dir = freshDir();
      const file = join(dir, "kestrel.db");
      const recording = recordingBlobstore(lockFileOf(file));

      const error = await failureOf(boot(storageInput(recording.module, {}, { file, ...replication }, { file, ...persistence }, dir)));

      expect(error).toMatchObject({ code: "invalid-module-config", module: failing });
      expect(String(error)).toContain("replication/sqlite");
      expect(String(error)).toContain("set allowConcurrentProcesses alike on every module that names the file");
      expect(existsSync(lockFileOf(file))).toBe(false);
    }
  });

  it("boots with allowConcurrentProcesses on every module of a file beside another process's lock", async () => {
    const dir = freshDir();
    const file = join(dir, "kestrel.db");
    const held = holdForeignLock(file);
    const recording = recordingBlobstore(lockFileOf(file));

    const kestrel = await boot(storageInput(recording.module, {}, { file, allowConcurrentProcesses: true }, { file, allowConcurrentProcesses: true }, dir));
    await kestrel.stop();

    expect(readFileSync(lockFileOf(file), "utf8")).toBe(held);
  });
});

describe("the 5.8.1 upgrade fixture restored into an empty directory", () => {
  it("rebuilds the database from the replica, boots with the lock beside it and reads every row, while the lock stays out of the replica", async () => {
    const manifest = boundaryCast<{ collections: Record<string, number> }>(JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")), "json");
    const work = freshDir();
    const blobRoot = join(work, "blobs");
    cpSync(join(FIXTURE, "blobs", "replica"), join(blobRoot, "replica"), { recursive: true });
    const data = join(work, "data");
    const file = join(data, "kestrel.db");

    const kestrel = await boot(storageInput(blobstoreFilesystem, { root: blobRoot }, { file }, { file }, work));
    booted.push(kestrel);

    expect(readdirSync(data).sort()).toEqual(expect.arrayContaining(["kestrel.db", "kestrel.db.instance"]));
    for (const [collection, rows] of Object.entries(manifest.collections)) expect([collection, rowCount(file, collection)]).toEqual([collection, rows]);
    expect((await kestrel.run("sync", { trigger: { kind: "event", name: "test" } })).status).toBe(200);

    booted.splice(0);
    await kestrel.stop();
    expect(existsSync(lockFileOf(file))).toBe(false);
    expect(tree(blobRoot).filter((key) => key.includes(".instance"))).toEqual([]);
    expect(tree(blobRoot).some((key) => key.endsWith("/sealed.json"))).toBe(true);
  });

  it("restores the database from the backup, boots with the lock beside it and reads every row", async () => {
    const manifest = boundaryCast<{ collections: Record<string, number> }>(JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")), "json");
    const work = freshDir();
    const blobRoot = join(work, "blobs");
    cpSync(join(FIXTURE, "blobs", "backups"), join(blobRoot, "backups"), { recursive: true });
    const file = join(work, "data", "kestrel.db");
    const input: BootInput = {
      config: {
        modules: [
          { use: "./blobs", config: { root: blobRoot } },
          { use: "@michaelthielemann/kestrel-backup-blobstore", config: { file, key: "backups/kestrel.db" } },
          { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file } },
        ],
        triggers: [],
        http: null,
      },
      modules: [blobstoreFilesystem, backupBlobstore, persistenceSqlite],
      pipelines: [],
      logger: silentLogger,
      root: work,
    };

    const kestrel = await boot(input);
    booted.push(kestrel);

    expect(existsSync(lockFileOf(file))).toBe(true);
    for (const [collection, rows] of Object.entries(manifest.collections)) expect([collection, rowCount(file, collection)]).toEqual([collection, rows]);
    booted.splice(0);
    await kestrel.stop();
    expect(existsSync(lockFileOf(file))).toBe(false);
  });
});

describe("boot checks and the instance lock", () => {
  it("leaves no lock at the real path once checkBoot with every setup returns, also when a later module fails", async () => {
    const dir = freshDir();
    const file = join(dir, "kestrel.db");
    const recording = recordingBlobstore(lockFileOf(file));

    const passed = await checkBoot(storageInput(recording.module, {}, { file }, { file }, dir), { setup: "all" });
    expect(passed.errors).toEqual([]);
    expect(existsSync(lockFileOf(file))).toBe(false);

    const failed = await checkBoot(storageInput(recording.module, {}, { file }, { file, acquireTimeoutMs: 100 }, dir), { setup: "all" });
    expect(failed.errors.map((problem) => problem.code)).toEqual(["invalid-module-config"]);
    expect(existsSync(lockFileOf(file))).toBe(false);
  });

  it("reports instance-locked from checkBoot with every setup while another process holds the real path, and changes no file there", async () => {
    const dir = freshDir();
    const file = join(dir, "kestrel.db");
    const held = holdForeignLock(file);
    const recording = recordingBlobstore(lockFileOf(file));

    const check = await checkBoot(storageInput(recording.module, {}, { file }, { file }, dir), { setup: "all" });

    expect(check.errors.map((problem) => problem.code)).toContain("instance-locked");
    expect(readdirSync(dir)).toEqual(["kestrel.db.instance"]);
    expect(readFileSync(lockFileOf(file), "utf8")).toBe(held);
  });

  it("runs the storage modules of a sandboxed check against the scratch directory even when the check consents to them", async () => {
    const dir = freshDir();
    const scratch = freshDir();
    mkdirSync(join(scratch, "sandbox"));
    const file = join(dir, "kestrel.db");
    const held = holdForeignLock(file);
    const recording = recordingBlobstore(lockFileOf(file));
    const input = storageInput(recording.module, {}, { file }, { file }, dir);
    const box = sandboxBootInput(input, { dir: scratch, consent: ["@michaelthielemann/kestrel-replication-sqlite", "@michaelthielemann/kestrel-persistence-sqlite"] });

    const check = await checkBoot(box.input, { setup: box.setup });

    expect(check.errors).toEqual([]);
    expect(readdirSync(dir)).toEqual(["kestrel.db.instance"]);
    expect(readFileSync(lockFileOf(file), "utf8")).toBe(held);
    expect(existsSync(lockFileOf(join(scratch, "sandbox", "kestrel.db")))).toBe(false);
  });

  it("checks a project with kestrel check --run-setup while another process holds its database, without touching that database", async () => {
    const project = copyProject(MINIMAL, "lock-check");
    dirs.push(project);
    const file = join(project, "data", "kestrel.db");
    const held = holdForeignLock(file);

    const result = await runCli(["check", "--json", "--root", project, "--run-setup", "@michaelthielemann/kestrel-persistence-sqlite", "--run-setup", "@michaelthielemann/kestrel-replication-sqlite"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("instance-locked");
    expect(readdirSync(join(project, "data"))).toEqual(["kestrel.db.instance"]);
    expect(readFileSync(lockFileOf(file), "utf8")).toBe(held);
  });
});
