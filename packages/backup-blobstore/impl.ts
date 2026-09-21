import { statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Blobstore, BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import { failure, type KestrelError } from "@michaelthielemann/kestrel/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { err, isErr, ok, type Result } from "@michaelthielemann/kestrel/result";

export interface Config {
  file: string;
  source?: string | undefined;
  key: string;
  restoreOnStart: boolean;
  versions: number;
}

export interface Backup {
  backup(): Promise<Result<{ key: string; size: number; versions: string[] }, BlobstoreError>>;
  prepareRestore(key?: string): Promise<Result<{ prepared: true; key: string; size: number; file: string }, KestrelError<"NOT_FOUND" | "TRANSIENT">>>;
  restoreWhenMissing(): Promise<{ restored: boolean; key: string; size: number }>;
  versions(): Promise<Result<string[], BlobstoreError>>;
  key: string;
}

export function versionKey(key: string, at: number): string {
  return `${key}.${new Date(at).toISOString().replace(/[:.]/g, "-")}`;
}

export function pendingRestoreFile(file: string): string {
  return `${file}.restore-pending`;
}

export function restoreMarker(file: string): string {
  return `${file}.restore-marker`;
}

export async function applyPendingRestore(file: string): Promise<{ key: string; size: number } | null> {
  const marker = restoreMarker(file);
  if (!(await exists(marker))) return null;
  const pending = pendingRestoreFile(file);
  if (!(await exists(pending))) {
    await rm(marker, { force: true });
    return null;
  }
  const key = (await readFile(marker, "utf8")).trim();
  const size = (await stat(pending)).size;
  for (const suffix of ["", "-wal", "-shm"]) await rm(file + suffix, { force: true });
  await rename(pending, file);
  await rm(marker, { force: true });
  return { key, size };
}

export function createBackupBlobstore(config: Config, blobs: Blobstore, now: () => number = Date.now): Backup {
  const versions = async (): Promise<Result<string[], BlobstoreError>> => {
    const list = await blobs.list(`${config.key}.`);
    if (isErr(list)) return list;
    return ok(list.value.map((b) => b.key).sort().reverse());
  };

  const assertOwnKey = (key: string): void => {
    if (key !== config.key && !key.startsWith(`${config.key}.`)) throw new Error(`backup/blobstore: key ${JSON.stringify(key)} is not a backup of ${config.key}`);
  };

  const download = async (key: string, destination: string): Promise<Result<number | null, BlobstoreError>> => {
    const blob = await blobs.get(key);
    if (isErr(blob)) return blob;
    if (blob.value === null) return ok(null);
    await mkdir(dirname(destination), { recursive: true });
    const part = `${destination}.part`;
    await writeFile(part, blob.value);
    await rename(part, destination);
    return ok(blob.value.byteLength);
  };

  return {
    key: config.key,
    async backup() {
      const data = new Uint8Array(await readFile(config.source ?? config.file));
      const put = await blobs.put(config.key, data, { contentType: "application/octet-stream" });
      if (isErr(put)) return put;
      if (config.versions > 0) {
        const putVersion = await blobs.put(versionKey(config.key, now()), data, { contentType: "application/octet-stream" });
        if (isErr(putVersion)) return putVersion;
        const before = await versions();
        if (isErr(before)) return before;
        for (const key of before.value.slice(config.versions)) {
          const removed = await blobs.remove(key);
          if (isErr(removed)) return removed;
        }
      }
      const after = await versions();
      if (isErr(after)) return after;
      return ok({ key: config.key, size: data.byteLength, versions: after.value });
    },
    async prepareRestore(key = config.key) {
      assertOwnKey(key);
      const pending = pendingRestoreFile(config.file);
      const size = await download(key, pending);
      if (isErr(size)) return size;
      if (size.value === null) return err(failure("NOT_FOUND", `no backup at ${key}`));
      await writeFile(restoreMarker(config.file), key);
      return ok({ prepared: true as const, key, size: size.value, file: pending });
    },
    async restoreWhenMissing() {
      if (await exists(config.file)) return { restored: false, key: config.key, size: 0 };
      const size = await download(config.key, config.file);
      if (isErr(size)) throw new Error(size.error.message, { cause: size.error });
      if (size.value === null) return { restored: false, key: config.key, size: 0 };
      return { restored: true, key: config.key, size: size.value };
    },
    versions,
  };
}

export async function hasRestorePoint(blobs: Blobstore, key: string): Promise<boolean> {
  const list = await blobs.list(key);
  if (isErr(list)) throw new Error(list.error.message, { cause: list.error });
  return list.value.length > 0;
}

/** The file's birth time in epoch ms (`CLOCK_REALTIME`), or `0` when the file system does not report one. */
export function fileBirthMs(file: string): number {
  return statSync(file).birthtimeMs;
}

export type Freshness = "fresh" | "old" | "unknown";

/** Compares a birth time against the process origin, both epoch ms. A birth time that is missing (`<= 0`) or later than now is `"unknown"`, never mistaken for fresh. */
export function freshnessOf(birthMs: number, processStartMs: number = performance.timeOrigin): Freshness {
  if (birthMs <= 0 || birthMs > Date.now()) return "unknown";
  return birthMs >= processStartMs ? "fresh" : "old";
}

function freshRestoreError(file: string): string {
  return `the file ${file} was created during this start-up while the backup holds a restore point, so restore-on-start was about to be skipped over an intact backup. Another module opened the file before this one: list backup-blobstore before the persistence module in kestrel.config.modules. Delete ${file} before the next start — on an ephemeral disk the restart does that for you, on a persistent volume it does not; ${file}.restore-pending and ${file}.restore-marker are left untouched. Set restoreOnStart: false to start from the local file instead.`;
}

/**
 * Called from `setup()` when `restoreOnStart` is set and the file already exists, so the restore
 * that would otherwise run is about to be skipped. Fails when the file was created during this
 * start-up while a restore point exists in the blobstore; otherwise logs why the skip is safe.
 * Unlike `replication-sqlite` there is no table-count fallback: the file is not necessarily SQLite.
 */
export async function checkSkippedRestore(config: Config, blobs: Blobstore, logger: Logger, readBirth: (file: string) => number = fileBirthMs): Promise<void> {
  if (!(await hasRestorePoint(blobs, config.key))) {
    logger.info("backup/blobstore: restore-on-start skipped", { file: config.file, reason: "file present, no restore point" });
    return;
  }
  const freshness = freshnessOf(readBirth(config.file));
  if (freshness === "fresh") throw new Error(freshRestoreError(config.file));
  if (freshness === "old") {
    logger.info("backup/blobstore: restore-on-start skipped", { file: config.file, reason: "file present, older than this process" });
    return;
  }
  logger.info("backup/blobstore: restore-on-start skipped", { file: config.file, reason: "file present, birth time unavailable on this file system; the order is not checked here" });
}

function isErrno(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error;
}

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") return false;
    throw err;
  }
}
