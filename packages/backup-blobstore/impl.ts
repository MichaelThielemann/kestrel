import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Blobstore, BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import { failure, type KestrelError } from "@michaelthielemann/kestrel/errors";
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
    await writeFile(part, blob.value.data);
    await rename(part, destination);
    return ok(blob.value.data.byteLength);
  };

  return {
    key: config.key,
    async backup() {
      const data = new Uint8Array(await readFile(config.source ?? config.file));
      const blob = { data, contentType: "application/octet-stream" };
      const put = await blobs.put(config.key, blob);
      if (isErr(put)) return put;
      if (config.versions > 0) {
        const putVersion = await blobs.put(versionKey(config.key, now()), blob);
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

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
