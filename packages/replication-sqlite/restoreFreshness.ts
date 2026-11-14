import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { isErr } from "@michaelthielemann/kestrel/result";
import type { Config } from "./impl.ts";

interface FileTimes {
  birthtimeNs: bigint;
  ctimeNs: bigint;
}

function readFileTimes(file: string): FileTimes {
  const stats = statSync(file, { bigint: true });
  return { birthtimeNs: stats.birthtimeNs, ctimeNs: stats.ctimeNs };
}

interface RestoreSidecarContent {
  restoredAtBootStartedAt: number;
  reported?: true;
}

/**
 * Not part of the package's public API; module-internal seam for the boot-time skip check below.
 * `0` means unavailable: either the file system reports no birth time at all, or it reports one
 * equal to the change time at nanosecond precision, the signature of a file system (network, FUSE)
 * that fills the birth time in from the change time because it has none of its own.
 */
export function fileBirthMs(file: string, readTimes: (file: string) => FileTimes = readFileTimes): number {
  const { birthtimeNs, ctimeNs } = readTimes(file);
  if (birthtimeNs === ctimeNs) return 0;
  return Number(birthtimeNs / 1_000_000n);
}

export type Freshness = "fresh" | "old" | "unknown";

/** Compares a birth time against the start of this boot, both epoch ms. A birth time that is missing (`<= 0`) or later than now is `"unknown"`, never mistaken for fresh. */
export function freshnessOf(birthMs: number, bootStartedAt: number): Freshness {
  if (birthMs <= 0 || birthMs > Date.now()) return "unknown";
  return birthMs >= bootStartedAt ? "fresh" : "old";
}

function holdsNoRows(file: string): boolean {
  const db = new DatabaseSync(file);
  try {
    const tables = boundaryCast<Array<{ name: string }>>(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all(), "host");
    return tables.every(({ name }) => db.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1`).get() === undefined);
  } finally {
    db.close();
  }
}

async function hasSnapshot(blobs: Blobstore, prefix: string): Promise<boolean> {
  const list = await blobs.list(`${prefix}gen/`);
  if (isErr(list)) throw new Error(list.error.message, { cause: list.error });
  return list.value.some((info) => /gen\/\d{8}T\d{6}Z(?:-[0-9a-f]+)?\/snapshot\.db$/.test(info.key));
}

/**
 * The sidecar a restoring module leaves next to the database file, naming the boot that restored it:
 * `{ "restoredAtBootStartedAt": <epoch ms>, "reported"?: true }`, with `reported` for a restore
 * whose file can be older than what was delivered from the database before it. Read by any module configured on the same file (`replication-sqlite`, `backup-blobstore`) to
 * recognize a file the other one already restored in this boot, and by `reportedRestoreAt`, without
 * either module naming the other. One fixed name, overwritten by every restore.
 */
export function restoreSidecar(file: string): string {
  return `${file}.restored-at`;
}

/** Writes the `restoreSidecar` atomically and durably (temporary file, fsync, rename); `reported` when `reportedRestoreAt` should answer this restore. */
export function markRestoredThisBoot(file: string, bootStartedAt: number, reported = false): void {
  const content: RestoreSidecarContent = reported ? { restoredAtBootStartedAt: bootStartedAt, reported } : { restoredAtBootStartedAt: bootStartedAt };
  const sidecar = restoreSidecar(file);
  const temporary = `${sidecar}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, JSON.stringify(content));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, sidecar);
}

function readSidecar(file: string): Partial<RestoreSidecarContent> {
  const sidecar = restoreSidecar(file);
  if (!existsSync(sidecar)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(sidecar, "utf8"));
    return boundaryCast<Partial<RestoreSidecarContent>>(parsed, "host");
  } catch {
    return {};
  }
}

function restoredThisBoot(file: string, bootStartedAt: number): boolean {
  return readSidecar(file).restoredAtBootStartedAt === bootStartedAt;
}

/** The start (epoch ms) of the boot that wrote the latest reported restore of `file`, as its `restoreSidecar` records it; `null` when the sidecar records none. */
export function reportedRestoreAt(file: string): number | null {
  const record = readSidecar(file);
  return record.reported === true && typeof record.restoredAtBootStartedAt === "number" ? record.restoredAtBootStartedAt : null;
}

function freshRestoreError(file: string, note?: string): string {
  const clause = note ? ` (${note})` : "";
  return `the database file ${file} was created during this start-up${clause} while the replica holds a restore point, so restore-on-start was about to be skipped over an intact replica. Another module opened the database before this one: list replication-sqlite before the persistence module in kestrel.config.modules. Move ${file} (and ${file}-wal, ${file}-shm) aside and start again — an ephemeral disk clears them for you on the next restart, a persistent volume does not, so move them by hand there. Set restoreOnStart: false to start from the local file instead.`;
}

/**
 * Called from `setup()` when `restoreOnStart` is set, the file already exists and was not just
 * restored from a pending marker in this same `setup()` call, so the restore that would otherwise
 * run is about to be skipped. A file the `restoreSidecar` shows this same boot already restored —
 * by this module's own automatic restore, or by another module configured on the same file — is
 * skipped without further checks. Otherwise freshness is judged locally first, against
 * `bootStartedAt` (the start of this boot, not of the process): an old file never needs a blobstore
 * call at all. Only a file that looks fresh (or whose birth time this file system cannot report and
 * none of whose tables holds a row) asks the blobstore whether a restore point exists; a failure of
 * that one call fails the boot, since the file is already known to be a plausible loss and the
 * check could not rule it out. A file the blobstore has no restore point for, or one that predates
 * this boot, is safe and only logged.
 */
export async function checkSkippedRestore(config: Config, blobs: Blobstore, logger: Logger, bootStartedAt: number, readBirth: (file: string) => number = fileBirthMs): Promise<void> {
  if (restoredThisBoot(config.file, bootStartedAt)) {
    logger.info("replication/sqlite: restore-on-start skipped", { file: config.file, reason: "file restored earlier in this boot" });
    return;
  }
  const freshness = freshnessOf(readBirth(config.file), bootStartedAt);
  if (freshness === "old") {
    logger.info("replication/sqlite: restore-on-start skipped", { file: config.file, reason: "file present, older than this process" });
    return;
  }
  let judgedByRows = false;
  if (freshness === "unknown") {
    if (!holdsNoRows(config.file)) {
      logger.info("replication/sqlite: restore-on-start skipped", { file: config.file, reason: "file present, birth time unavailable on this file system; judged by whether any table holds a row" });
      return;
    }
    judgedByRows = true;
  }
  let hasPoint: boolean;
  try {
    hasPoint = await hasSnapshot(blobs, config.prefix);
  } catch (err) {
    throw new Error(`replication/sqlite: could not check whether a restore point exists for ${config.file} before judging the skipped restore over it: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (!hasPoint) {
    logger.info("replication/sqlite: restore-on-start skipped", { file: config.file, reason: "file present, no restore point" });
    return;
  }
  throw new Error(freshRestoreError(config.file, judgedByRows ? "birth time unavailable on this file system; judged by whether any table holds a row" : undefined));
}
