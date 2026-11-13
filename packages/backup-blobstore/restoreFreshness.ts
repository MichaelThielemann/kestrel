import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

async function hasBackup(blobs: Blobstore, key: string): Promise<boolean> {
  const list = await blobs.list(key);
  if (isErr(list)) throw new Error(list.error.message, { cause: list.error });
  return list.value.length > 0;
}

/**
 * The sidecar a restoring module leaves next to the file, naming the boot that restored it:
 * `{ "restoredAtBootStartedAt": <epoch ms> }`. Read by any module configured on the same file
 * (`backup-blobstore`, `replication-sqlite`) to recognize a file the other one already restored in
 * this boot, without either module naming the other. One fixed name, always overwritten; a sidecar
 * from a different boot is simply ignored.
 */
export function restoreSidecar(file: string): string {
  return `${file}.restored-at`;
}

export function markRestoredThisBoot(file: string, bootStartedAt: number): void {
  writeFileSync(restoreSidecar(file), JSON.stringify({ restoredAtBootStartedAt: bootStartedAt }));
}

/** Whether the `restoreSidecar` of `file` names the boot that started at `bootStartedAt`. */
export function restoredThisBoot(file: string, bootStartedAt: number): boolean {
  const sidecar = restoreSidecar(file);
  if (!existsSync(sidecar)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(sidecar, "utf8"));
    const record = boundaryCast<Partial<RestoreSidecarContent>>(parsed, "host");
    return record.restoredAtBootStartedAt === bootStartedAt;
  } catch {
    return false;
  }
}

function freshRestoreError(file: string): string {
  return `the file ${file} was created during this start-up while the backup holds a restore point, so restore-on-start was about to be skipped over an intact backup. Another module opened the file before this one: list backup-blobstore before the persistence module in kestrel.config.modules. Move ${file} aside and start again — an ephemeral disk clears it for you on the next restart, a persistent volume does not, so move it by hand there; ${file}.restore-pending and ${file}.restore-marker are left untouched. Set restoreOnStart: false to start from the local file instead.`;
}

/**
 * Called from `setup()` when `restoreOnStart` is set, the file already exists and no pending
 * restore was just applied in this same `setup()` call, so the restore that would otherwise run
 * is about to be skipped. A file the `restoreSidecar` shows this same boot already restored — by
 * this module's own automatic restore, or by another module configured on the same file — is
 * skipped without further checks. Otherwise freshness is judged locally first, against
 * `bootStartedAt` (the start of this boot, not of the process): an old file never needs a
 * blobstore call at all. Only a file that looks fresh asks the blobstore whether a restore point
 * exists — there is no row-count fallback here, since the backed-up file is not necessarily
 * SQLite, so an unavailable birth time is only logged. A blobstore failure for a fresh file fails
 * the boot, since the file is already a plausible loss and the check could not rule it out.
 */
export async function checkSkippedRestore(config: Config, blobs: Blobstore, logger: Logger, bootStartedAt: number, readBirth: (file: string) => number = fileBirthMs): Promise<void> {
  if (restoredThisBoot(config.file, bootStartedAt)) {
    logger.info("backup/blobstore: restore-on-start skipped", { file: config.file, reason: "file restored earlier in this boot" });
    return;
  }
  const freshness = freshnessOf(readBirth(config.file), bootStartedAt);
  if (freshness === "old") {
    logger.info("backup/blobstore: restore-on-start skipped", { file: config.file, reason: "file present, older than this process" });
    return;
  }
  if (freshness === "unknown") {
    logger.info("backup/blobstore: restore-on-start skipped", { file: config.file, reason: "file present, birth time unavailable on this file system; the order is not checked here" });
    return;
  }
  let hasPoint: boolean;
  try {
    hasPoint = await hasBackup(blobs, config.key);
  } catch (err) {
    throw new Error(`backup/blobstore: could not check whether a restore point exists for ${config.file} before judging the skipped restore over it: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (!hasPoint) {
    logger.info("backup/blobstore: restore-on-start skipped", { file: config.file, reason: "file present, no restore point" });
    return;
  }
  throw new Error(freshRestoreError(config.file));
}
