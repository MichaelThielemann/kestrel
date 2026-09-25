import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it, expect } from "vitest";
import { BLOBSTORE, type Blobstore, type BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger, type Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import type { Replication } from "./impl.ts";
import { checkSkippedRestore, fileBirthMs, freshnessOf, markRestoredThisBoot } from "./restoreFreshness.ts";
import module from "./module.ts";

function fakeBlobs(): Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> } {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    blobs,
    async put(k, data, options) {
      blobs.set(k, { data: new Uint8Array(data), contentType: options?.contentType ?? "application/octet-stream" });
      return ok();
    },
    async get(k) {
      return ok(blobs.get(k)?.data ?? null);
    },
    async remove(k) {
      blobs.delete(k);
      return ok();
    },
    async move(from, to) {
      const b = blobs.get(from);
      if (!b) return err(failure("NOT_FOUND", `${from} not found`));
      blobs.set(to, b);
      blobs.delete(from);
      return ok();
    },
    async list(p) {
      return ok([...blobs].filter(([k]) => k.startsWith(p)).map(([key, b]) => ({ key, size: b.data.byteLength })));
    },
  };
}

function failingBlobs(): Blobstore {
  const error: BlobstoreError = failure("TRANSIENT", "fakeBlobs: injected TRANSIENT");
  return {
    put: async () => err(error),
    get: async () => err(error),
    remove: async () => err(error),
    move: async () => err(error),
    list: async () => err(error),
  };
}

function moduleDeps(blobs: Blobstore, root: string, bootStartedAt: number = Date.now()): Deps {
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

function putSnapshot(blobs: ReturnType<typeof fakeBlobs>): void {
  blobs.blobs.set("replica/gen/20260101T000000Z/snapshot.db", { data: new Uint8Array([1]), contentType: "application/vnd.sqlite3" });
}

function skippedConfig(file: string) {
  return { file, prefix: "replica/", checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 24 * 3600, retentionSeconds: 48 * 3600, restoreOnStart: true };
}

function infoLogger(): { infos: { message: string; data?: Record<string, unknown> }[]; logger: Logger } {
  const infos: { message: string; data?: Record<string, unknown> }[] = [];
  return { infos, logger: { ...silentLogger, info: (message, data) => infos.push(data === undefined ? { message } : { message, data }) } };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("fileBirthMs", () => {
  it("returns the birth time in ms when it differs from the change time", () => {
    expect(fileBirthMs("/irrelevant", () => ({ birthtimeNs: 1_700_000_000_123_000_000n, ctimeNs: 1_700_000_001_456_000_000n }))).toBe(1_700_000_000_123);
  });

  it("returns 0 when the birth time is zero, the file system reports none at all", () => {
    expect(fileBirthMs("/irrelevant", () => ({ birthtimeNs: 0n, ctimeNs: 1_700_000_001_456_000_000n }))).toBe(0);
  });

  it("returns 0 when the birth time equals the change time, the signature of a file system that fakes it from the change time", () => {
    expect(fileBirthMs("/irrelevant", () => ({ birthtimeNs: 1_700_000_000_123_000_000n, ctimeNs: 1_700_000_000_123_000_000n }))).toBe(0);
  });
});

describe("freshnessOf", () => {
  it("is fresh when the birth time is after the start of this boot", () => {
    expect(freshnessOf(1000, 900)).toBe("fresh");
  });

  it("is fresh at the exact boundary, birth time equal to the start of this boot — deliberate: coarse timestamp granularity can only truncate a birth time downward, so treating equality as fresh is the direction that never masks a real loss", () => {
    expect(freshnessOf(1000, 1000)).toBe("fresh");
  });

  it("is old when the birth time is before the start of this boot", () => {
    expect(freshnessOf(900, 1000)).toBe("old");
  });

  it("is unknown when the birth time is zero", () => {
    expect(freshnessOf(0, 1000)).toBe("unknown");
  });

  it("is unknown when the birth time is nonsensically in the future", () => {
    expect(freshnessOf(Date.now() + 60_000, Date.now())).toBe("unknown");
  });
});

describe("replication/sqlite module setup: restore-on-start skip check", () => {
  it("rejects when the file already holds rows and was created during this boot, even though a check by rows alone would stay quiet", async () => {
    const bootStartedAt = Date.now();
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-fresh-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    const app = new DatabaseSync(file);
    app.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    app.prepare("INSERT INTO t (v) VALUES ('x')").run();
    app.close();
    if (freshnessOf(fileBirthMs(file), bootStartedAt) !== "fresh") return;
    const blobs = fakeBlobs();
    putSnapshot(blobs);
    let thrown: unknown;
    try {
      await module.setup(module.configSchema.parse(skippedConfig(file)), moduleDeps(blobs, dir, bootStartedAt));
    } catch (e) {
      thrown = e;
    }
    if (!(thrown instanceof Error)) throw new Error("expected setup() to reject with an Error");
    const message = thrown.message;
    expect(message).toContain(file);
    expect(message).toMatch(/was created during this start-up while the replica holds a restore point/);
    expect(message).toMatch(/list replication-sqlite before the persistence module/);
    expect(message).toContain(`${file}-wal`);
    expect(message).toContain(`${file}-shm`);
  });

  it("does not reject a file it just restored from a pending marker in this same setup() call", async () => {
    const bootStartedAt = Date.now();
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-fresh-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    const app = new DatabaseSync(file);
    app.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    app.close();
    copyFileSync(file, `${file}.restore`);
    rmSync(file);
    const blobs = fakeBlobs();
    putSnapshot(blobs);
    const instance = boundaryCast<Replication>(await module.setup(module.configSchema.parse(skippedConfig(file)), moduleDeps(blobs, dir, bootStartedAt)), "host");
    instance.close();
  });
});

describe("checkSkippedRestore: the restore sidecar", () => {
  it("skips a fresh, restore-point-holding file another module already restored in this boot", async () => {
    const bootStartedAt = Date.now();
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-check-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    writeFileSync(file, "x");
    markRestoredThisBoot(file, bootStartedAt);
    const blobs = fakeBlobs();
    putSnapshot(blobs);
    const { infos, logger } = infoLogger();
    await checkSkippedRestore(skippedConfig(file), blobs, logger, bootStartedAt, () => Date.now());
    expect(infos).toEqual([{ message: "replication/sqlite: restore-on-start skipped", data: { file, reason: "file restored earlier in this boot" } }]);
  });

  it("ignores a sidecar left by a different boot and judges freshness normally", async () => {
    const bootStartedAt = Date.now();
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-check-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    writeFileSync(file, "x");
    markRestoredThisBoot(file, bootStartedAt - 999_999);
    const blobs = fakeBlobs();
    putSnapshot(blobs);
    await expect(checkSkippedRestore(skippedConfig(file), blobs, silentLogger, bootStartedAt, () => Date.now())).rejects.toThrow(/was created during this start-up/);
  });
});

describe("checkSkippedRestore", () => {
  it("rejects when the stubbed birth time is at or after this boot's start, without needing the file system's birth time to be reliable", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-check-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    writeFileSync(file, "x");
    const blobs = fakeBlobs();
    putSnapshot(blobs);
    await expect(checkSkippedRestore(skippedConfig(file), blobs, silentLogger, Date.now() - 1000, () => Date.now())).rejects.toThrow(/was created during this start-up/);
  });

  it("logs and stays clean, with no blobstore call, when the stubbed birth time is before this boot's start", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-check-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    writeFileSync(file, "x");
    const { infos, logger } = infoLogger();
    await checkSkippedRestore(skippedConfig(file), failingBlobs(), logger, Date.now() + 60_000, () => Date.now());
    expect(infos).toEqual([{ message: "replication/sqlite: restore-on-start skipped", data: { file, reason: "file present, older than this process" } }]);
  });

  it("falls back to whether any table holds a row when the birth time is unavailable, and rejects a database without tables", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-check-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    const app = new DatabaseSync(file);
    app.close();
    const blobs = fakeBlobs();
    putSnapshot(blobs);
    await expect(checkSkippedRestore(skippedConfig(file), blobs, silentLogger, Date.now(), () => 0)).rejects.toThrow(/birth time unavailable on this file system; judged by whether any table holds a row/);
  });

  it("rejects a database whose tables hold no rows when the birth time is unavailable, the shape a schema created during this boot leaves behind", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-check-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    const app = new DatabaseSync(file);
    app.exec("CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT)");
    app.exec("CREATE TABLE \"odd \"\"name\" (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    app.close();
    const blobs = fakeBlobs();
    putSnapshot(blobs);
    await expect(checkSkippedRestore(skippedConfig(file), blobs, silentLogger, Date.now(), () => 0)).rejects.toThrow(/birth time unavailable on this file system; judged by whether any table holds a row/);
  });

  it("stays clean when the birth time is unavailable and a table already holds a row", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-check-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    const app = new DatabaseSync(file);
    app.exec("CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT)");
    app.exec("CREATE TABLE \"odd \"\"name\" (id INTEGER PRIMARY KEY)");
    app.prepare("INSERT INTO \"odd \"\"name\" (id) VALUES (1)").run();
    app.close();
    const blobs = fakeBlobs();
    putSnapshot(blobs);
    const { infos, logger } = infoLogger();
    await checkSkippedRestore(skippedConfig(file), blobs, logger, Date.now(), () => 0);
    expect(infos).toEqual([{ message: "replication/sqlite: restore-on-start skipped", data: { file, reason: "file present, birth time unavailable on this file system; judged by whether any table holds a row" } }]);
  });

  it("stays quiet when no restore point exists, whatever the birth time", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-check-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    writeFileSync(file, "x");
    const blobs = fakeBlobs();
    const { infos, logger } = infoLogger();
    await checkSkippedRestore(skippedConfig(file), blobs, logger, Date.now() - 1000, () => Date.now());
    expect(infos).toEqual([{ message: "replication/sqlite: restore-on-start skipped", data: { file, reason: "file present, no restore point" } }]);
  });

  it("fails the boot when the blobstore cannot be asked whether a restore point exists for a fresh file", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-check-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    writeFileSync(file, "x");
    await expect(checkSkippedRestore(skippedConfig(file), failingBlobs(), silentLogger, Date.now() - 1000, () => Date.now())).rejects.toThrow(/could not check whether a restore point exists/);
  });

  it("never asks the blobstore for an old file, even when the blobstore itself would fail", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-check-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    writeFileSync(file, "x");
    const { infos, logger } = infoLogger();
    await checkSkippedRestore(skippedConfig(file), failingBlobs(), logger, Date.now() + 60_000, () => Date.now());
    expect(infos).toEqual([{ message: "replication/sqlite: restore-on-start skipped", data: { file, reason: "file present, older than this process" } }]);
  });

  it("uses the real fileBirthMs by default; nothing to assert where the file system reports none", async () => {
    const bootStartedAt = Date.now();
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-check-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    writeFileSync(file, "x");
    if (freshnessOf(fileBirthMs(file), bootStartedAt) !== "fresh") return;
    const blobs = fakeBlobs();
    putSnapshot(blobs);
    await expect(checkSkippedRestore(skippedConfig(file), blobs, silentLogger, bootStartedAt)).rejects.toThrow(/was created during this start-up/);
  });
});
