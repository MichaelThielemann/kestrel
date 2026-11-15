import { parseJsonOrNull } from "../layout.ts";
import { fixedText, literal } from "../redact.ts";
import { stableList } from "../store.ts";
import { listUpdateRuns, readUpdateRun, reportOf, retirePending, RUN_STEP } from "./journal.ts";
import { OPEN_STATES, type UpdateContext, type UpdateReport, type UpdateRun, type UpdateRunState, type VersionSet } from "./types.ts";

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
  /** The run asked for with `--run`, or the newest deploy run that is not `untouched` (see `latestDeployRun`). */
  run: UpdateRunStatus | null;
  /** Without `--run`, the newest deploy run when it is an `untouched` one other than {@link UpdateStatusReport.run}, such as a deploy the gate refused; otherwise null. */
  latestAttempt: UpdateRunStatus | null;
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

const OPS_PACKAGE = "@michaelthielemann/kestrel-ops";

/**
 * How to deploy the release that ran before deploy run `run` again: through its bundle when it brings kestrel-ops,
 * otherwise the way it was deployed before the update.
 */
export function previousReleaseDeploy(run: Pick<UpdateRun, "env" | "versions">): string {
  return run.versions?.from?.[OPS_PACKAGE] !== undefined ? fixedText`node .kestrel-ops/run.mjs deploy --env ${literal(run.env)}` : fixedText`deploy the previous release of ${literal(run.env)} again the way it was deployed before the update; it brings no kestrel-ops`;
}

/** The message of a rollback that brought back the cutover state after `what` but had no previous droplet to start. */
export function stoppedAfterRollback(ctx: Pick<UpdateContext, "envName">, what: string, from: VersionSet | null): string {
  const again = previousReleaseDeploy({ env: ctx.envName, versions: { from, to: {} } });
  return fixedText`${what}; the cutover state is back, but no previous droplet was left to start, so the app stays stopped: ${again.startsWith("node ") ? fixedText`deploy the previous release again with the bundle of its own build, ${again}` : again}`;
}

/**
 * The command run `run`, opened by `command`, needs next, or null when it needs nothing; for a run whose rollback left
 * the app stopped, a deploy of the previous release ({@link previousReleaseDeploy}); for a verified or accepted run whose retire of the previous
 * releases did not end, `update resume`.
 */
export function nextCommand(run: UpdateRun, command: string): string | null {
  const scope = fixedText`--env ${literal(run.env)} --run ${literal(run.runId)}`;
  if (command === "update prepare") return run.state === "prepared" ? fixedText`node .kestrel-ops/run.mjs deploy --env ${literal(run.env)}` : null;
  if (retirePending(run)) return fixedText`kestrel update resume ${scope}`;
  switch (run.state) {
    case "deploying":
      return fixedText`kestrel update abort ${scope}`;
    case "down":
      return run.records.some((r) => r.phase === "deploy" && r.step === "stop" && r.state === "done") ? fixedText`kestrel update resume ${scope}` : fixedText`kestrel update abort ${scope}`;
    case "verifying":
    case "rolling-back":
      return fixedText`kestrel update resume ${scope}`;
    case "halted":
      return run.records.filter((r) => r.step === "verify" && r.state === "done").at(-1)?.data.held === true ? fixedText`kestrel update rollback ${scope}` : fixedText`kestrel update resume ${scope}`;
    case "verified":
      return fixedText`kestrel update accept ${scope}`;
    case "accepted":
      return fixedText`kestrel update cleanup ${scope}`;
    case "rolled-back":
      return run.records.filter((r) => r.step === "rollback" && r.state === "done").at(-1)?.data.ended === "stopped" ? previousReleaseDeploy(run) : null;
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
  const deploys = listed.filter((entry) => entry.command === "update deploy");
  let chosen = runId;
  for (const entry of [...deploys].reverse()) {
    if (chosen !== null) break;
    if ((await read(entry.runId)).state !== "untouched") chosen = entry.runId;
  }
  const newest = deploys.at(-1)?.runId ?? null;
  chosen ??= newest;
  const latestAttempt = runId === null && newest !== null && newest !== chosen ? await read(newest) : null;
  return { env: ctx.envName, run: chosen === null ? null : await read(chosen), latestAttempt, open };
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
  const lines = [fixedText`run ${literal(status.runId)}  ${literal(status.command)}  ${literal(status.state)}  started ${literal(new Date(status.startedAt).toISOString())}, last entry ${literal(new Date(status.lastAt).toISOString())}`];
  lines.push(fixedText`  ran on ${status.hosts.length === 0 ? literal("an unknown host") : status.hosts.join(", ")}`);
  if (status.versions !== null) lines.push(fixedText`  versions ${literal(status.versions.from === null ? "unknown" : versionsText(status.versions.from))} -> ${literal(versionsText(status.versions.to))}`);
  if (status.cutoverBackup !== null) lines.push(fixedText`  cutover backup ${literal(status.cutoverBackup)}`);
  for (const step of status.report.steps) lines.push(fixedText`  ${literal(`${step.phase} ${step.step}`.padEnd(36, " "))} ${literal(duration(step.ms).padStart(12, " "))}${literal(step.appDown ? "  app down" : "")}`);
  lines.push(fixedText`  downtime ${literal(status.report.downtimeMs === null ? "the app is still down" : duration(status.report.downtimeMs))}`);
  const derived = status.report.derived;
  if (derived !== undefined) {
    const sample = [...derived.keys.added, ...derived.keys.changed, ...derived.keys.missing].slice(0, 5);
    lines.push(fixedText`  derived keys after the rollback: ${derived.added} added, ${derived.changed} changed, ${derived.missing} missing${sample.length === 0 ? literal("") : fixedText`, such as ${sample.join(", ")}`}`);
  }
  lines.push(status.next === null ? fixedText`  nothing to do` : fixedText`  next: ${status.next}`);
  return lines;
}

/** The lines `update status` prints for `report`. */
export function renderStatus(report: UpdateStatusReport): string[] {
  const lines: string[] = [];
  if (report.run === null) lines.push(fixedText`${literal(report.env)}: no deploy run`);
  else lines.push(fixedText`${literal(report.env)}:`, ...runLines(report.run));
  if (report.latestAttempt !== null) lines.push(fixedText`newest attempt ${literal(report.latestAttempt.runId)} is ${literal(report.latestAttempt.state)}: it changed nothing`);
  const others = report.open.filter((status) => status.runId !== report.run?.runId);
  if (others.length > 0) lines.push(fixedText`open runs besides it: ${others.length}`, ...others.flatMap(runLines));
  return lines;
}
