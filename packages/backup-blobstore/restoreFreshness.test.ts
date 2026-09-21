import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { BLOBSTORE, type Blobstore, type BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger, type Logger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import type { Backup } from "./impl.ts";
import { checkSkippedRestore, fileBirthMs, freshnessOf, markRestoredThisBoot } from "./restoreFreshness.ts";
import module from "./module.ts";

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
      if (!b) return err(failure("NOT_FOUND", `${from} not found`));
      blobs.set(to, b);
      blobs.delete(from);
      return ok();
    },
    async list(prefix) {
      return ok([...blobs].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.data.byteLength })));
    },
  };
}

function failingBlobstore(): Blobstore {
  const error: BlobstoreError = failure("TRANSIENT", "fakeBlobstore: injected TRANSIENT");
  return {
    put: async () => err(error),
    get: async () => err(error),
    remove: async () => err(error),
    move: async () => err(error),
    list: async () => err(error),
  };
}

function deps(blobs: Blobstore, root: string, bootStartedAt: number = Date.now()): Deps {
  return {
    get<T>(contract: Contract<T>): T {
      if (contract.name !== BLOBSTORE.name) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(blobs, "host");
    },
    find: <T>(): T | undefined => undefined,
    logger: silentLogger,
    root,
    bootStartedAt,
  };
}

function skippedConfig(file: string) {
  return { file, key: "backups/db", restoreOnStart: true, versions: 0 };
}

function infoLogger(): { infos: { message: string; data?: Record<string, unknown> }[]; logger: Logger } {
  const infos: { message: string; data?: Record<string, unknown> }[] = [];
  return { infos, logger: { ...silentLogger, info: (message, data) => infos.push(data === undefined ? { message } : { message, data }) } };
}

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
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

describe("backup/blobstore module setup: restore-on-start skip check", () => {
  it("setup() rejects when the file was created during this boot while a restore point exists", async () => {
    const bootStartedAt = Date.now();
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-fresh-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    await writeFile(file, "live");
    if (freshnessOf(fileBirthMs(file), bootStartedAt) !== "fresh") return;
    const blobs = fakeBlobstore();
    blobs.blobs.set("backups/db", { data: new TextEncoder().encode("from-backup"), contentType: "application/octet-stream" });
    let thrown: unknown;
    try {
      await module.setup(module.configSchema.parse(skippedConfig(file)), deps(blobs, dir, bootStartedAt));
    } catch (e) {
      thrown = e;
    }
    if (!(thrown instanceof Error)) throw new Error("expected setup() to reject with an Error");
    const message = thrown.message;
    expect(message).toContain(file);
    expect(message).toMatch(/was created during this start-up while the backup holds a restore point/);
    expect(message).toMatch(/list backup-blobstore before the persistence module/);
    expect(message).toContain(`${file}.restore-pending`);
    expect(message).toContain(`${file}.restore-marker`);
  });

  it("does not reject a file it just restored from a pending marker in this same setup() call", async () => {
    const bootStartedAt = Date.now();
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-fresh-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    const blobs = fakeBlobstore();
    blobs.blobs.set("backups/db", { data: new TextEncoder().encode("from-backup"), contentType: "application/octet-stream" });
    await writeFile(file, "live");
    await writeFile(`${file}.restore-pending`, "staged");
    await writeFile(`${file}.restore-marker`, "backups/db");
    const instance = boundaryCast<Backup>(await module.setup(module.configSchema.parse(skippedConfig(file)), deps(blobs, dir, bootStartedAt)), "host");
    expect(instance.key).toBe("backups/db");
  });
});

describe("checkSkippedRestore: the restore sidecar", () => {
  it("skips a fresh, restore-point-holding file another module already restored in this boot", async () => {
    const bootStartedAt = Date.now();
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-check-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    await writeFile(file, "live");
    markRestoredThisBoot(file, bootStartedAt);
    const blobs = fakeBlobstore();
    blobs.blobs.set("backups/db", { data: new TextEncoder().encode("from-backup"), contentType: "application/octet-stream" });
    const { infos, logger } = infoLogger();
    await checkSkippedRestore(skippedConfig(file), blobs, logger, bootStartedAt, () => Date.now());
    expect(infos).toEqual([{ message: "backup/blobstore: restore-on-start skipped", data: { file, reason: "file restored earlier in this boot" } }]);
  });

  it("ignores a sidecar left by a different boot and judges freshness normally", async () => {
    const bootStartedAt = Date.now();
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-check-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    await writeFile(file, "live");
    markRestoredThisBoot(file, bootStartedAt - 999_999);
    const blobs = fakeBlobstore();
    blobs.blobs.set("backups/db", { data: new TextEncoder().encode("from-backup"), contentType: "application/octet-stream" });
    await expect(checkSkippedRestore(skippedConfig(file), blobs, silentLogger, bootStartedAt, () => Date.now())).rejects.toThrow(/was created during this start-up/);
  });
});

describe("checkSkippedRestore", () => {
  it("rejects when the stubbed birth time is at or after this boot's start, without needing the file system's birth time to be reliable", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-check-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    await writeFile(file, "live");
    const blobs = fakeBlobstore();
    blobs.blobs.set("backups/db", { data: new TextEncoder().encode("from-backup"), contentType: "application/octet-stream" });
    await expect(checkSkippedRestore(skippedConfig(file), blobs, silentLogger, Date.now() - 1000, () => Date.now())).rejects.toThrow(/was created during this start-up/);
  });

  it("logs and stays clean, with no blobstore call, when the stubbed birth time is before this boot's start", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-check-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    await writeFile(file, "live");
    const { infos, logger } = infoLogger();
    await checkSkippedRestore(skippedConfig(file), failingBlobstore(), logger, Date.now() + 60_000, () => Date.now());
    expect(infos).toEqual([{ message: "backup/blobstore: restore-on-start skipped", data: { file, reason: "file present, older than this process" } }]);
  });

  it("logs that the order is not checked when the birth time is unavailable, with no blobstore call, and stays clean", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-check-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    await writeFile(file, "live");
    const { infos, logger } = infoLogger();
    await checkSkippedRestore(skippedConfig(file), failingBlobstore(), logger, Date.now(), () => 0);
    expect(infos).toEqual([{ message: "backup/blobstore: restore-on-start skipped", data: { file, reason: "file present, birth time unavailable on this file system; the order is not checked here" } }]);
  });

  it("stays quiet when no restore point exists, whatever the birth time", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-check-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    await writeFile(file, "live");
    const blobs = fakeBlobstore();
    const { infos, logger } = infoLogger();
    await checkSkippedRestore(skippedConfig(file), blobs, logger, Date.now() - 1000, () => Date.now());
    expect(infos).toEqual([{ message: "backup/blobstore: restore-on-start skipped", data: { file, reason: "file present, no restore point" } }]);
  });

  it("fails the boot when the blobstore cannot be asked whether a restore point exists for a fresh file", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-check-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    await writeFile(file, "live");
    await expect(checkSkippedRestore(skippedConfig(file), failingBlobstore(), silentLogger, Date.now() - 1000, () => Date.now())).rejects.toThrow(/could not check whether a restore point exists/);
  });

  it("uses the real fileBirthMs by default; nothing to assert where the file system reports none", async () => {
    const bootStartedAt = Date.now();
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-check-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    await writeFile(file, "live");
    if (freshnessOf(fileBirthMs(file), bootStartedAt) !== "fresh") return;
    const blobs = fakeBlobstore();
    blobs.blobs.set("backups/db", { data: new TextEncoder().encode("from-backup"), contentType: "application/octet-stream" });
    await expect(checkSkippedRestore(skippedConfig(file), blobs, silentLogger, bootStartedAt)).rejects.toThrow(/was created during this start-up/);
  });
});
