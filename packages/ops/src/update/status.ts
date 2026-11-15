import { parseJsonOrNull } from "../layout.ts";
import { stableList } from "../store.ts";
import { listUpdateRuns, readUpdateRun, reportOf, RUN_STEP } from "./journal.ts";
import { OPEN_STATES, type UpdateContext, type UpdateReport, type UpdateRun, type UpdateRunState } from "./types.ts";

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

const LOCK_START = /^locks\/([^/]+)\/\d{8}T\d{6}Z-start-[0-9a-f]{4}\.json$/;

async function lockHosts(ctx: UpdateContext): Promise<Map<string, string>> {
  const hosts = new Map<string, string>();
  for (const info of await stableList(ctx.backups, `${ctx.location}locks/`, ctx.poll)) {
    const lockRun = LOCK_START.exec(info.key.slice(ctx.location.length))?.[1];
    if (lockRun === undefined || hosts.has(lockRun)) continue;
    const data = await ctx.backups.get(info.key);
    const value: unknown = data === null ? null : parseJsonOrNull(data);
    const host: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "host") : undefined;
    if (typeof host === "string" && host !== "") hosts.set(lockRun, host);
  }
  return hosts;
}

/** The command run `run`, opened by `command`, needs next, or null when it needs nothing. */
export function nextCommand(run: UpdateRun, command: string): string | null {
  const scope = `--env ${run.env} --run ${run.runId}`;
  if (command === "update prepare") return run.state === "prepared" ? `node .kestrel-ops/run.mjs deploy --env ${run.env}` : null;
  switch (run.state) {
    case "deploying":
      return `kestrel update abort ${scope}`;
    case "down":
    case "verifying":
    case "rolling-back":
      return `kestrel update resume ${scope}`;
    case "halted":
      return `kestrel update resume ${scope}`;
    case "verified":
      return `kestrel update accept ${scope}`;
    case "accepted":
      return `kestrel update cleanup ${scope}`;
    default:
      return null;
  }
}

function statusOf(run: UpdateRun, command: string, hosts: Map<string, string>): UpdateRunStatus {
  const processes = new Set<string>([run.runId]);
  for (const record of run.records) {
    const process = record.data.process;
    if (record.step === RUN_STEP && typeof process === "string") processes.add(process);
  }
  const where = [...processes].flatMap((id) => {
    const host = hosts.get(id);
    return host === undefined ? [] : [host];
  });
  return {
    runId: run.runId,
    command,
    state: run.state,
    startedAt: run.startedAt,
    lastAt: run.lastAt,
    hosts: [...new Set(where)],
    versions: run.versions,
    cutoverBackup: run.cutoverBackup,
    next: nextCommand(run, command),
    report: reportOf(run),
  };
}

/**
 * Reads the update runs of the environment from the backup location, so a run a deploy job started shows on any
 * machine with access to it, with the downtime of each step.
 */
export async function updateStatus(ctx: UpdateContext, runId: string | null): Promise<UpdateStatusReport> {
  const listed = await listUpdateRuns(ctx, ctx.envName);
  const hosts = await lockHosts(ctx);
  const commandOf = new Map(listed.map((entry) => [entry.runId, entry.command]));
  const statuses = new Map<string, UpdateRunStatus>();
  const read = async (id: string): Promise<UpdateRunStatus> => {
    const known = statuses.get(id);
    if (known !== undefined) return known;
    const status = statusOf(await readUpdateRun(ctx, id), commandOf.get(id) ?? "update deploy", hosts);
    statuses.set(id, status);
    return status;
  };
  const open: UpdateRunStatus[] = [];
  for (const entry of listed) {
    const status = await read(entry.runId);
    if (OPEN_STATES.has(status.state)) open.push(status);
  }
  const newestDeploy = listed.filter((entry) => entry.command === "update deploy").at(-1);
  const chosen = runId ?? newestDeploy?.runId ?? null;
  return { env: ctx.envName, run: chosen === null ? null : await read(chosen), open };
}

function duration(ms: number | null): string {
  if (ms === null) return "running";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

const versionsText = (versions: Record<string, string>): string => {
  const values = [...new Set(Object.values(versions))];
  return values.length === 0 ? "none" : values.join(" / ");
};

function runLines(status: UpdateRunStatus): string[] {
  const lines = [`run ${status.runId}  ${status.command}  ${status.state}  started ${new Date(status.startedAt).toISOString()}, last entry ${new Date(status.lastAt).toISOString()}`];
  lines.push(`  ran on ${status.hosts.length === 0 ? "an unknown host" : status.hosts.join(", ")}`);
  if (status.versions !== null) lines.push(`  versions ${status.versions.from === null ? "unknown" : versionsText(status.versions.from)} -> ${versionsText(status.versions.to)}`);
  if (status.cutoverBackup !== null) lines.push(`  cutover backup ${status.cutoverBackup}`);
  for (const step of status.report.steps) lines.push(`  ${`${step.phase} ${step.step}`.padEnd(36, " ")} ${duration(step.ms).padStart(12, " ")}${step.appDown ? "  app down" : ""}`);
  lines.push(`  downtime ${status.report.downtimeMs === null ? "the app is still down" : duration(status.report.downtimeMs)}`);
  lines.push(status.next === null ? "  nothing to do" : `  next: ${status.next}`);
  return lines;
}

/** The lines `update status` prints for `report`. */
export function renderStatus(report: UpdateStatusReport): string[] {
  const lines: string[] = [];
  if (report.run === null) lines.push(`${report.env}: no deploy run`);
  else lines.push(`${report.env}:`, ...runLines(report.run));
  const others = report.open.filter((status) => status.runId !== report.run?.runId);
  if (others.length > 0) lines.push(`open runs besides it: ${others.length}`, ...others.flatMap(runLines));
  return lines;
}
