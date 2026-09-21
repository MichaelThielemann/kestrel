import { statSync } from "node:fs";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { isErr } from "@michaelthielemann/kestrel/result";
import type { Config } from "./impl.ts";

/** Not part of the package's public API; module-internal seam for the boot-time skip check below. */
export function fileBirthMs(file: string): number {
  return statSync(file).birthtimeMs;
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

function freshRestoreError(file: string): string {
  return `the file ${file} was created during this start-up while the backup holds a restore point, so restore-on-start was about to be skipped over an intact backup. Another module opened the file before this one: list backup-blobstore before the persistence module in kestrel.config.modules. Delete ${file} before the next start — on an ephemeral disk the restart does that for you, on a persistent volume it does not; ${file}.restore-pending and ${file}.restore-marker are left untouched. Set restoreOnStart: false to start from the local file instead.`;
}

/**
 * Called from `setup()` when `restoreOnStart` is set, the file already exists and no pending
 * restore was just applied in this same `setup()` call, so the restore that would otherwise run
 * is about to be skipped. Freshness is judged locally first, against `bootStartedAt` (the start of
 * this boot, not of the process): an old file never needs a blobstore call at all. Only a file
 * that looks fresh asks the blobstore whether a restore point exists — there is no table-count
 * fallback here, since the backed-up file is not necessarily SQLite, so an unavailable birth time
 * is logged and left to the `module-order` warning instead. A blobstore failure for a fresh file
 * fails the boot, since the file is already a plausible loss and the check could not rule it out.
 */
export async function checkSkippedRestore(config: Config, blobs: Blobstore, logger: Logger, bootStartedAt: number, readBirth: (file: string) => number = fileBirthMs): Promise<void> {
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
