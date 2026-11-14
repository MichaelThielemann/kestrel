import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Step } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { acquireInstanceLock, instanceLockFile, type InstanceLock } from "@michaelthielemann/kestrel/instanceLock";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import type { Backup } from "./impl.ts";
import module, { configSchema } from "./module.ts";

function fakeBlobstore(): Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> } {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    blobs,
    async put(key, data, options) {
      blobs.set(key, { data, contentType: options?.contentType ?? "application/octet-stream" });
      return ok();
    },
    async get(key) {
      return ok(blobs.get(key)?.data ?? null);
    },
    async remove(key) {
      blobs.delete(key);
      return ok();
    },
    async move(from, to) {
      const b = blobs.get(from);
      if (!b) throw new Error(`${from} not found`);
      blobs.set(to, b);
      blobs.delete(from);
      return ok();
    },
    async list(prefix) {
      return ok([...blobs].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.data.byteLength })));
    },
  };
}

function moduleDeps(blobs: Blobstore, root: string, bootStartedAt?: number): Deps {
  return {
    ...(bootStartedAt === undefined ? {} : { bootStartedAt }),
    get<T>(contract: Contract<T>): T {
      if (contract.name !== BLOBSTORE.name) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(blobs, "host");
    },
    find: <T>(): T | undefined => undefined,
    logger: silentLogger,
    root,
    eventTriggers: [],
  };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function boot(): Promise<Backup> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-mod-"));
  dirs.push(dir);
  const file = join(dir, "kestrel.db");
  await writeFile(file, "hello");
  const blobs = fakeBlobstore();
  const config = configSchema.parse({ file, key: "backups/db", restoreOnStart: false, versions: 2 });
  return boundaryCast<Backup>(await module.setup(config, moduleDeps(blobs, dir)), "host");
}

describe("backup/blobstore module via runPipeline", () => {
  it("run backs up the file and reports key and size", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "run", steps: ["backup.run"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ key: "backups/db", size: 5 });
  });

  it("listVersions lists the versions written by run", async () => {
    const instance = await boot();
    const run = definePipeline({ name: "run", steps: ["backup.run"] });
    await runPipeline(run, {}, { modules: [{ module, instance }] });
    const pipeline = definePipeline({ name: "listVersions", steps: ["backup.listVersions"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(boundaryCast<{ versions: string[] }>(result.result, "host").versions.length).toBe(1);
  });

  it("restore stages the latest version to be applied on the next start", async () => {
    const instance = await boot();
    const run = definePipeline({ name: "run", steps: ["backup.run"] });
    await runPipeline(run, {}, { modules: [{ module, instance }] });
    const pipeline = definePipeline({ name: "restore", steps: ["backup.restore"] });
    const result = await runPipeline(pipeline, { body: {} }, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ key: "backups/db", pending: true, appliedOnRestart: true });
  });

  it("restore rejects a non-string key as VALIDATION before the step runs", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "restore-invalid", steps: ["backup.restore"] });
    const result = await runPipeline(pipeline, { body: { key: 123 } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
  });

  it("restore rejects an unknown body key as VALIDATION", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "restore-extra-key", steps: ["backup.restore"] });
    const result = await runPipeline(pipeline, { body: { key: "backups/db", nope: true } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
  });
});

function writeResult(result: unknown): Step {
  return async (ctx) => ok({ ...ctx, result });
}

describe("backup/blobstore checkRestored", () => {
  async function restoredAt(instance: Backup): Promise<unknown> {
    const run = await runPipeline(definePipeline({ name: "checkRestored", steps: ["backup.checkRestored"] }), {}, { modules: [{ module, instance }] });
    expect(run.status).toBe(200);
    return boundaryCast<Record<string, unknown>>(run.result, "host")._databaseRestoredAt;
  }

  it("answers the start of the boot that restored the file, from a prepared restore or a missing file, in that boot and every later one", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-restored-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    const blobs = fakeBlobstore();
    blobs.blobs.set("backups/db", { data: new TextEncoder().encode("hello"), contentType: "application/octet-stream" });
    const config = configSchema.parse({ file, key: "backups/db" });
    const start = async (): Promise<{ instance: Backup; bootStartedAt: number }> => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const bootStartedAt = Date.now();
      return { instance: boundaryCast<Backup>(await module.setup(config, moduleDeps(blobs, dir, bootStartedAt)), "host"), bootStartedAt };
    };
    const missing = await start();
    expect(await restoredAt(missing.instance)).toBe(missing.bootStartedAt);
    const kept = await start();
    expect(await restoredAt(kept.instance)).toBe(missing.bootStartedAt);
    expect((await kept.instance.prepareRestore()).ok).toBe(true);
    const restoring = await start();
    expect(await restoredAt(restoring.instance)).toBe(restoring.bootStartedAt);
    expect(await restoredAt((await start()).instance)).toBe(restoring.bootStartedAt);
  });

  it("answers null for a file no restore wrote", async () => {
    expect(await restoredAt(await boot())).toBeNull();
  });

  it("leaves a restore whose record could not be written to the next start", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-unrecorded-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    const blobs = fakeBlobstore();
    blobs.blobs.set("backups/db", { data: new TextEncoder().encode("hello"), contentType: "application/octet-stream" });
    const config = configSchema.parse({ file, key: "backups/db" });
    const unblockRecord = async (): Promise<void> => {
      await rm(`${file}.restored-at`, { recursive: true, force: true });
    };
    const blockRecord = async (): Promise<void> => {
      await unblockRecord();
      await mkdir(join(`${file}.restored-at`, "blocked"), { recursive: true });
    };

    await blockRecord();
    await expect(module.setup(config, moduleDeps(blobs, dir, Date.now()))).rejects.toThrow();
    expect(existsSync(file)).toBe(false);
    await unblockRecord();
    const rebuilt = Date.now() + 1;
    const afterRebuild = boundaryCast<Backup>(await module.setup(config, moduleDeps(blobs, dir, rebuilt)), "host");
    expect(await restoredAt(afterRebuild)).toBe(rebuilt);

    expect((await afterRebuild.prepareRestore()).ok).toBe(true);
    await blockRecord();
    await expect(module.setup(config, moduleDeps(blobs, dir, rebuilt + 1))).rejects.toThrow();
    expect(existsSync(`${file}.restore-marker`)).toBe(true);
    await unblockRecord();
    const applied = rebuilt + 2;
    expect(await restoredAt(boundaryCast<Backup>(await module.setup(config, moduleDeps(blobs, dir, applied)), "host"))).toBe(applied);
  });

  it("keeps the other members of the result", async () => {
    const instance = await boot();
    const run = await runPipeline(definePipeline({ name: "checkRestored", steps: ["test.earlier", "backup.checkRestored"] }), {}, { modules: [{ module, instance }], steps: { "test.earlier": writeResult({ kept: 1 }) }, writes: { "test.earlier": ["result"] } });
    expect(run.result).toEqual({ kept: 1, _databaseRestoredAt: null });
  });
});

function lockFileOf(file: string): string {
  const path = instanceLockFile(file);
  if (path === undefined) throw new Error(`${file} names no lock file`);
  return path;
}

function holdForeignLock(file: string): string {
  const now = new Date().toISOString();
  const content = JSON.stringify({ instanceId: randomUUID(), pid: 4242, pidNamespace: "pid:[4026530001]", processStart: "1", clockStart: 1, bootId: randomUUID(), host: "other-host", startedAt: now, heartbeatAt: now, ttlMs: 60_000, threads: { [randomUUID()]: now } });
  writeFileSync(lockFileOf(file), content);
  return content;
}

function checksums(paths: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(paths.map((path) => [path, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null]));
}

function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected setup to fail");
    },
    (error: unknown) => error,
  );
}

function readsOf(blobs: Blobstore): Blobstore & { keys: string[] } {
  const keys: string[] = [];
  return {
    ...blobs,
    keys,
    async get(key) {
      keys.push(key);
      return blobs.get(key);
    },
    async list(prefix) {
      keys.push(`${prefix}*`);
      return blobs.list(prefix);
    },
  };
}

describe("backup/blobstore instance lock", () => {
  const shares: InstanceLock[] = [];
  afterEach(() => {
    for (const share of shares.splice(0)) share.release();
  });

  async function freshDir(): Promise<string> {
    const dir = realpathSync(await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-lock-")));
    dirs.push(dir);
    return dir;
  }

  it("refuses a file another process holds before it applies a pending restore, leaving every file next to the database unchanged", async () => {
    const dir = await freshDir();
    const file = join(dir, "kestrel.db");
    for (const [suffix, content] of [["", "live"], ["-wal", "wal"], ["-shm", "shm"], [".restore-pending", "staged"], [".restore-marker", "backups/db"], [".restored-at", "{}"]] as const) await writeFile(`${file}${suffix}`, content);
    holdForeignLock(file);
    const files = ["", "-wal", "-shm", ".restore-pending", ".restore-marker", ".restored-at"].map((suffix) => `${file}${suffix}`);
    const before = checksums(files);
    const blobs = readsOf(fakeBlobstore());

    const error = await failureOf(module.setup(configSchema.parse({ file, key: "backups/db" }), moduleDeps(blobs, dir, Date.now())));

    expect(error).toMatchObject({ code: "instance-locked", module: "backup/blobstore" });
    expect(String(error)).toContain('host "other-host", pid 4242');
    expect(checksums(files)).toEqual(before);
    expect(blobs.keys).toEqual([]);

    rmSync(lockFileOf(file));
    const instance = await module.setup(configSchema.parse({ file, key: "backups/db" }), moduleDeps(blobs, dir, Date.now()));
    expect(readFileSync(file, "utf8")).toBe("staged");
    await module.teardown!(instance);
  });

  it("refuses a file another process holds before it restores the missing file from the backup, creating no file", async () => {
    const dir = await freshDir();
    const file = join(dir, "kestrel.db");
    holdForeignLock(file);
    const blobs = readsOf(fakeBlobstore());
    await blobs.put("backups/db", new TextEncoder().encode("hello"));

    expect(await failureOf(module.setup(configSchema.parse({ file, key: "backups/db" }), moduleDeps(blobs, dir, Date.now())))).toMatchObject({ code: "instance-locked" });

    expect(readdirSync(dir)).toEqual(["kestrel.db.instance"]);
    expect(blobs.keys).toEqual([]);
  });

  it("starts beside another process's lock with allowConcurrentProcesses and leaves that lock as it is", async () => {
    const dir = await freshDir();
    const file = join(dir, "kestrel.db");
    const held = holdForeignLock(file);
    const blobs = fakeBlobstore();
    await blobs.put("backups/db", new TextEncoder().encode("hello"));

    const instance = await module.setup(configSchema.parse({ file, key: "backups/db", allowConcurrentProcesses: true }), moduleDeps(blobs, dir, Date.now()));
    expect(readFileSync(file, "utf8")).toBe("hello");
    await module.teardown!(instance);

    expect(readFileSync(lockFileOf(file), "utf8")).toBe(held);
  });

  it("holds the lock beside the file until teardown and gives it up when the start fails", async () => {
    const dir = await freshDir();
    const file = join(dir, "kestrel.db");
    await writeFile(file, "hello");
    const instance = await module.setup(configSchema.parse({ file, key: "backups/db", restoreOnStart: false }), moduleDeps(fakeBlobstore(), dir, Date.now()));
    expect(existsSync(lockFileOf(file))).toBe(true);
    await module.teardown!(instance);
    expect(existsSync(lockFileOf(file))).toBe(false);

    await mkdir(join(`${file}.restore-marker`, "blocked"), { recursive: true });
    await writeFile(`${file}.restore-pending`, "staged");
    expect(await failureOf(module.setup(configSchema.parse({ file, key: "backups/db" }), moduleDeps(fakeBlobstore(), dir, Date.now())))).toBeInstanceOf(Error);
    expect(existsSync(lockFileOf(file))).toBe(false);
  });

  it("reports a lock that another instance took over as needing a restart", async () => {
    const dir = await freshDir();
    const file = join(dir, "kestrel.db");
    await writeFile(file, "hello");
    shares.push(acquireInstanceLock(file, { module: "test", ttlMs: 300, heartbeatMs: 100 }));
    const instance = await module.setup(configSchema.parse({ file, key: "backups/db", restoreOnStart: false }), moduleDeps(fakeBlobstore(), dir, Date.now()));
    expect(module.health!(instance)).toEqual({ ok: true });

    holdForeignLock(file);
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(module.health!(instance)).toMatchObject({ ok: false, restartRequired: true });
    await module.teardown!(instance);
  });
});
