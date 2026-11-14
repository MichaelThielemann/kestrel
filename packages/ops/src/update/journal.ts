import type { OpsContext } from "../context.ts";
import { OpsError } from "../errors.ts";
import { Journal } from "../journal.ts";
import { parseJsonOrNull } from "../layout.ts";
import { stableList } from "../store.ts";
import { UPDATE_PHASES, type StepTiming, type UpdatePhase, type UpdateRecord, type UpdateReport, type UpdateRun, type UpdateRunState, type VersionChange } from "./types.ts";

/** The journal step that opens each command of an update run, with `{ command, env, phase }` as its data. */
export const RUN_STEP = "run";

const JOURNAL_KEY = /^runs\/([^/]+)\/(\d{6})-(.+)-(started|done|failed|skipped)\.json$/;

const isPhase = (value: unknown): value is UpdatePhase => typeof value === "string" && UPDATE_PHASES.some((phase) => phase === value);
const isState = (value: unknown): value is UpdateRecord["state"] => value === "started" || value === "done" || value === "failed" || value === "skipped";
const field = (data: unknown, name: string): unknown => (typeof data === "object" && data !== null ? Reflect.get(data, name) : undefined);
const text = (data: unknown, name: string): string | null => {
  const value = field(data, name);
  return typeof value === "string" ? value : null;
};

const isVersionSet = (value: unknown): value is Record<string, string> => typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string");

function versionChange(value: unknown): VersionChange | null {
  const from = field(value, "from");
  const to = field(value, "to");
  if (!isVersionSet(to) || (from !== null && !isVersionSet(from))) return null;
  return { from, to };
}

const phaseOfCommand = (command: string | null): UpdatePhase => {
  const word = command?.split(" ")[1];
  return isPhase(word) ? word : "deploy";
};

/**
 * Reads the journal of update run `runId` from the backup location, listing until two listings agree and the
 * sequence numbers run from 1 without a gap. A record's phase is its `data.phase`, or that of the record before it
 * (`stop` and `start` from the shared target steps carry none). Refuses with exit 1 when the run has no record or a
 * gap stays.
 */
export async function readUpdateRun(ctx: Pick<OpsContext, "backups" | "location" | "poll">, runId: string): Promise<UpdateRun> {
  const base = `${ctx.location}runs/${runId}/`;
  const sleep = ctx.poll.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const listJournal = async (): Promise<Array<{ key: string; seq: number }>> =>
    (await stableList(ctx.backups, base, ctx.poll)).flatMap((info) => {
      const m = JOURNAL_KEY.exec(info.key.slice(ctx.location.length));
      return m ? [{ key: info.key, seq: Number(m[2]) }] : [];
    });
  let listed = await listJournal();
  for (let attempt = 0; ; attempt++) {
    const seen = new Set(listed.map((entry) => entry.seq));
    const highest = Math.max(0, ...seen);
    if (listed.length > 0 && seen.size === highest) break;
    if (attempt >= (ctx.poll.attempts ?? 30)) throw new OpsError(listed.length === 0 ? `update run ${runId} has no journal` : `the journal of update run ${runId} lacks entries below ${highest}`, 1, runId);
    await sleep(ctx.poll.delayMs ?? 1000);
    listed = await listJournal();
  }
  const records: UpdateRecord[] = [];
  let phase: UpdatePhase = "deploy";
  let env = "";
  let first: string | null = null;
  for (const entry of listed.sort((a, b) => a.seq - b.seq)) {
    const data = await ctx.backups.get(entry.key);
    const value: unknown = data === null ? null : parseJsonOrNull(data);
    const step = text(value, "step");
    const state = field(value, "state");
    const at = field(value, "at");
    const payload = field(value, "data");
    if (step === null || !isState(state) || typeof at !== "number") throw new OpsError(`journal entry ${entry.key} cannot be read`, 1, entry.key);
    const body = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? Object.fromEntries(Object.entries(payload)) : {};
    if (step === RUN_STEP) {
      const command = text(body, "command");
      first ??= command;
      env = text(body, "env") ?? env;
      phase = phaseOfCommand(command);
    }
    const own = field(body, "phase");
    if (isPhase(own)) phase = own;
    records.push({ seq: entry.seq, step, state, at, phase, data: body });
  }
  return summarize(runId, env, first, records);
}

function summarize(runId: string, env: string, firstCommand: string | null, records: UpdateRecord[]): UpdateRun {
  const prepare = phaseOfCommand(firstCommand) === "prepare";
  let state: UpdateRunState = prepare ? "untouched" : "deploying";
  const run: UpdateRun = { runId, env, records, state, lastDone: null, lastSeq: records.at(-1)?.seq ?? 0, receipt: null, stagedDroplet: null, previousDroplet: null, cutoverBackup: null, promoted: null, versions: null, startedAt: records[0]?.at ?? 0, lastAt: records.at(-1)?.at ?? 0 };
  for (const r of records) {
    if (r.state === "done" && r.step !== RUN_STEP && r.step !== "run-done" && r.step !== "run-failed") run.lastDone = { phase: r.phase, step: r.step };
    if (r.phase === "prepare") {
      if (r.step === "receipt" && r.state === "done") state = "prepared";
      continue;
    }
    if (r.step === "run-done" || r.step === "run-failed") {
      if (state === "deploying") state = "untouched";
      continue;
    }
    if (r.state !== "done") {
      if (r.phase === "rollback" && r.state === "started") state = "rolling-back";
      if (r.phase === "deploy" && r.step === "start" && r.state === "started") state = "verifying";
      continue;
    }
    switch (r.step) {
      case "gate":
        run.receipt = text(r.data, "receipt");
        run.versions = versionChange(field(r.data, "versions"));
        break;
      case "stage":
        run.stagedDroplet = text(r.data, "droplet");
        break;
      case "configuration":
        run.previousDroplet = text(r.data, "droplet");
        break;
      case "cutover-backup":
        run.cutoverBackup = text(r.data, "backupId");
        break;
      case "promote": {
        const generation = text(r.data, "generation");
        const nonce = text(r.data, "nonce");
        if (r.phase === "deploy" && generation !== null && nonce !== null) run.promoted = { generation, nonce };
        break;
      }
      case "stop":
        if (r.phase === "deploy" && state === "deploying") state = "down";
        break;
      case "verify": {
        const verdict = field(r.data, "verdict");
        if (r.phase === "deploy" || r.phase === "verify") state = verdict === "passed" ? "verified" : verdict === "unverifiable" ? "halted" : "rolling-back";
        break;
      }
      case "rollback":
      case "rollback-verify":
        state = "rolled-back";
        break;
      case "abort":
        if (field(r.data, "promoted") !== true) state = "aborted";
        break;
      case "accept":
        state = "accepted";
        break;
      case "unpin":
        if (r.phase === "cleanup") state = "cleaned";
        break;
    }
  }
  run.state = state;
  return run;
}

/** Ids of every update run of environment `env` in the backup location, oldest first, with the command that opened it. */
export async function listUpdateRuns(ctx: Pick<OpsContext, "backups" | "location" | "poll">, env: string): Promise<Array<{ runId: string; command: string; startedAt: number }>> {
  const firsts = new Map<string, { key: string; seq: number; at: number }>();
  for (const info of await stableList(ctx.backups, `${ctx.location}runs/`, ctx.poll)) {
    const m = JOURNAL_KEY.exec(info.key.slice(ctx.location.length));
    if (!m || m[3] !== RUN_STEP) continue;
    const runId = m[1] ?? "";
    const seq = Number(m[2]);
    const known = firsts.get(runId);
    if (known === undefined || seq < known.seq) firsts.set(runId, { key: info.key, seq, at: info.lastModified });
  }
  const out: Array<{ runId: string; command: string; startedAt: number }> = [];
  for (const [runId, first] of firsts) {
    const data = await ctx.backups.get(first.key);
    const body = field(data === null ? null : parseJsonOrNull(data), "data");
    const command = text(body, "command");
    if (command !== null && command.startsWith("update ") && text(body, "env") === env) out.push({ runId, command, startedAt: first.at });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : 1));
}

/** The newest deploy run of `env`, or null when there is none. */
export async function latestDeployRun(ctx: Pick<OpsContext, "backups" | "location" | "poll">, env: string): Promise<UpdateRun | null> {
  const newest = (await listUpdateRuns(ctx, env)).filter((r) => r.command === "update deploy").at(-1);
  return newest === undefined ? null : readUpdateRun(ctx, newest.runId);
}

/** A journal that appends to update run `run`, continuing after its last entry; every record of it goes through the redactor. */
export function continueJournal(ctx: Pick<OpsContext, "backups" | "location" | "redactor" | "clock" | "workspace">, run: Pick<UpdateRun, "runId" | "lastSeq">): Journal {
  return new Journal(run.runId, ctx.backups, ctx.location, ctx.redactor, ctx.clock, ctx.workspace.path("journal.jsonl"), run.lastSeq);
}

/**
 * The timings of a run from its journal: one entry per step from its `started` record (or the record before it, for a
 * step recorded only as `done`) to its `done`, `failed` or `skipped` record. The app counts as down from a `stop` until
 * a `start` that became ready; `downtimeMs` sums those periods and is null while the app is still down.
 */
export function reportOf(run: Pick<UpdateRun, "runId" | "records">): UpdateReport {
  const steps: StepTiming[] = [];
  const open = new Map<string, StepTiming>();
  let down = false;
  let downSince = 0;
  let total = 0;
  let previousAt = run.records[0]?.at ?? 0;
  for (const r of run.records) {
    const id = `${r.phase}:${r.step}`;
    if (r.step === RUN_STEP || r.step === "run-done" || r.step === "run-failed") {
      previousAt = r.at;
      continue;
    }
    if (r.state === "started") {
      const timing: StepTiming = { phase: r.phase, step: r.step, startedAt: r.at, endedAt: null, ms: null, appDown: down };
      open.set(id, timing);
      steps.push(timing);
    } else {
      const timing = open.get(id) ?? { phase: r.phase, step: r.step, startedAt: previousAt, endedAt: null, ms: null, appDown: down };
      if (!open.has(id)) steps.push(timing);
      open.delete(id);
      timing.endedAt = r.at;
      timing.ms = r.at - timing.startedAt;
      if (r.step === "stop" && r.state === "done" && !down) {
        down = true;
        downSince = r.at;
        timing.appDown = true;
      } else if (r.step === "start" && r.state === "done" && down && field(r.data, "ready") !== false) {
        down = false;
        total += r.at - downSince;
        timing.appDown = true;
      } else if (down) timing.appDown = true;
    }
    previousAt = r.at;
  }
  return { runId: run.runId, steps, downtimeMs: down ? null : total };
}
