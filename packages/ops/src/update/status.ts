import type { UpdateContext, UpdateReport, UpdateRunState } from "./types.ts";
import { notImplemented } from "./pending.ts";

/** One update run as `update status` shows it. */
export interface UpdateRunStatus {
  runId: string;
  command: string;
  state: UpdateRunState;
  startedAt: number;
  lastAt: number;
  /** Where the run's processes ran, from the lock trace (a CI agent, a laptop). */
  hosts: string[];
  versions: { from: Record<string, string> | null; to: Record<string, string> } | null;
  cutoverBackup: string | null;
  /** The command to run next, or null when the run needs nothing. */
  next: string | null;
  report: UpdateReport;
}

/** What `update status` reports. */
export interface UpdateStatusReport {
  env: string;
  /** The run asked for with `--run`, or the newest deploy run. */
  run: UpdateRunStatus | null;
  /** Every update run of the environment that is in an open state. */
  open: UpdateRunStatus[];
}

/**
 * Reads the update runs of the environment from the backup location, so a run a deploy job started shows on any
 * machine with access to it, with the downtime of each step.
 */
export async function updateStatus(ctx: UpdateContext, runId: string | null): Promise<UpdateStatusReport> {
  return notImplemented(`updateStatus(${runId ?? "latest"})`);
}

/** The lines `update status` prints for `report`. */
export function renderStatus(report: UpdateStatusReport): string[] {
  return notImplemented(`renderStatus(${report.env})`);
}
