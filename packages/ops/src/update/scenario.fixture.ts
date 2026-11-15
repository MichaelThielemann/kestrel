import { DatabaseSync } from "node:sqlite";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { acceptSeal, createBackup, precopy, readManifest } from "../backup.ts";
import { startTarget, stopTarget } from "../context.ts";
import { LOCATION, PREFIXES } from "../harness.fixture.ts";
import { fromJsonl, jsonBytes, keys, parseJsonOrNull, type BlobEntry } from "../layout.ts";
import { listGenerations, markerKey, promote, type Origin } from "../replica.ts";
import { downloadDb } from "../restore.ts";
import { appClock } from "../serverTime.ts";
import { sha256File, tables } from "../sqlite.ts";
import type { ObjectStore } from "../store.ts";
import { createUpdateHarness, type ContextOptions, type UpdateHarness, type UpdateHarnessOptions } from "./harness.fixture.ts";
import { readUpdateRun, RUN_STEP } from "./journal.ts";
import { UPDATE_PIN_PREFIX, updateKeys } from "./layout.ts";
import { DEPLOY_STEPS, UPDATE_EXIT, type DeployStep, type UpdateContext, type UpdateOutcome, type UpdateRun, type UpdateRunState, type VerifyVerdict } from "./types.ts";

/** The table the stand-in storage migration adds to the converted copy. */
export const CONVERTED_TABLE = "stand_in_storage_versions";

/** Where the stand-in storage migration puts the converted originals. */
export const CONVERTED_PREFIX = `${PREFIXES.media}converted/`;

/** Options of {@link createScenario}. */
export interface ScenarioOptions extends UpdateHarnessOptions {
  /** Variables of the app before the update. */
  env?: Record<string, string>;
  /** Names whose values the recorded configuration keeps only as fingerprints. */
  secretNames?: string[];
}

/** A harness whose app runs the old release with seeded content, ready for a deploy run. */
export interface Scenario {
  h: UpdateHarness;
  secretNames: ReadonlySet<string>;
  /** The droplet the app ran before any update. */
  previousDroplet: string;
}

/** Builds a {@link Scenario}: starts the old release and seeds pages, media, users and the delivery prefix. */
export async function createScenario(options: ScenarioOptions = {}): Promise<Scenario> {
  const h = createUpdateHarness(options);
  Object.assign(h.target.configuration.env, options.env ?? {});
  await h.target.start();
  const app = h.target.app;
  if (app === null) throw new Error("the old release did not start");
  await app.seed();
  return { h, secretNames: new Set(options.secretNames ?? []), previousDroplet: h.target.current };
}

/** How a deploy step of the scenario ended. */
export interface StepEnd {
  /** The last step that ran to its end, or null. */
  last: DeployStep | null;
  /** The error the next step threw, or null when every step up to the requested one ran. */
  failure: Error | null;
  /** The verdict of `verify` when it ran. */
  verdict: VerifyVerdict | null;
}

/** A deploy run of the scenario, with the context of the process that ran it. */
export interface ScenarioRun {
  runId: string;
  ctx: UpdateContext;
  end: StepEnd;
}

const stepIndex = (step: string | null): number => (step === null ? -1 : DEPLOY_STEPS.findIndex((s) => s === step));

function stateOf(run: UpdateRun): { from: number; stoppedAt: number | null } {
  let from = -1;
  let stoppedAt: number | null = null;
  for (const r of run.records) {
    if (r.phase !== "deploy" || r.state !== "done") continue;
    if (r.step === "stop") stoppedAt = typeof r.data.stoppedAt === "number" ? r.data.stoppedAt : null;
    const index = stepIndex(r.step === "backup" ? null : r.step);
    if (index > from) from = index;
  }
  return { from: from + 1, stoppedAt };
}

async function migrateCopy(ctx: UpdateContext, cutover: string, file: string): Promise<void> {
  const manifest = await readManifest(ctx, cutover);
  if (manifest === null) throw new Error(`cutover backup ${cutover} is missing`);
  await downloadDb(ctx, manifest, file);
  const db = new DatabaseSync(file);
  try {
    const rows = boundaryCast<Array<{ id: string; key: string; filename: string }>>(db.prepare(`SELECT "id", "key", "filename" FROM media_items ORDER BY "id"`).all(), "host");
    for (const row of rows) {
      const to = `${CONVERTED_PREFIX}${row.id}/${row.filename}`;
      const bytes = await ctx.app.get(row.key);
      if (bytes !== null) await ctx.app.put(to, bytes);
      db.prepare(`UPDATE media_items SET "key" = ? WHERE "id" = ?`).run(to, row.id);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS "${CONVERTED_TABLE}" ("module" TEXT PRIMARY KEY, "version" INTEGER)`);
    db.prepare(`INSERT OR REPLACE INTO "${CONVERTED_TABLE}" VALUES (?, ?)`).run("media/default", 2);
  } finally {
    db.close();
  }
}

async function runSteps(ctx: UpdateContext, scenario: Scenario, run: UpdateRun | null, until: DeployStep, before: (step: DeployStep, ctx: UpdateContext) => void = () => undefined): Promise<StepEnd> {
  const state = run === null ? { from: 0, stoppedAt: null } : stateOf(run);
  let stoppedAt = state.stoppedAt;
  let staged = run?.stagedDroplet ?? null;
  let cutover = run?.cutoverBackup ?? null;
  let promoted = run?.promoted ?? null;
  let startedAt = 0;
  const migrated = ctx.workspace.path("migrated.db");
  const deploy = { phase: "deploy" };
  const end: StepEnd = { last: null, failure: null, verdict: null };
  const steps: Record<DeployStep, () => Promise<void>> = {
    gate: () => ctx.journal.record("gate", "done", { ...deploy, receipt: null, versions: { from: null, to: ctx.release.versions } }),
    stage: async () => {
      staged = (await ctx.target.stage({ dir: ctx.release.dir })).droplet;
      await ctx.journal.record("stage", "done", { ...deploy, droplet: staged });
    },
    configuration: async () => {
      const recorded = await ctx.target.readConfiguration(scenario.secretNames);
      const key = ctx.location + updateKeys.configuration(ctx.envName, ctx.run.id);
      if ((await ctx.backups.head(key)) === null) await ctx.backups.put(key, jsonBytes(recorded), { contentType: "application/json" });
      await ctx.journal.record("configuration", "done", { ...deploy, droplet: recorded.droplet });
    },
    precopy: async () => {
      const copied = await precopy(ctx, [ctx.env.app.mediaPrefix, ctx.env.app.deliveryPrefix]);
      await ctx.journal.record("precopy", "done", { ...deploy, copied });
    },
    stop: async () => {
      await ctx.journal.record("stop", "started", deploy);
      stoppedAt = (await stopTarget(ctx)).stoppedAt;
    },
    seal: async () => {
      const seal = await ctx.steps.waitForSeal(ctx, stoppedAt ?? ctx.clock());
      await acceptSeal(ctx, seal, stoppedAt ?? ctx.clock());
      await ctx.journal.record("seal", "done", { ...deploy, state: seal.state, generation: seal.generation });
    },
    "cutover-backup": async () => {
      const seal = await ctx.steps.waitForSeal(ctx, stoppedAt ?? ctx.clock());
      await acceptSeal(ctx, seal, stoppedAt ?? ctx.clock());
      cutover = (await createBackup(ctx, { kind: "cutover", mode: { kind: "stopped", seal, stoppedAt: stoppedAt ?? ctx.clock() }, pinFor: UPDATE_PIN_PREFIX + ctx.run.id })).id;
      await ctx.journal.record("cutover-backup", "done", { ...deploy, backupId: cutover });
    },
    migrate: async () => {
      if (cutover === null) throw new Error("no cutover backup to migrate");
      await migrateCopy(ctx, cutover, migrated);
      await ctx.journal.record("migrate", "done", { ...deploy, sha256: sha256File(migrated) });
    },
    promote: async () => {
      if (cutover === null) throw new Error("no cutover backup to promote");
      const clock = await appClock(ctx);
      const done = await promote({ store: ctx.app, prefix: ctx.env.app.replicaPrefix, target: ctx.target, database: migrated, origin: { kind: "upgrade", source: cutover }, serverNow: clock.now, skewMs: clock.skewMs, clock: ctx.clock, poll: ctx.poll });
      promoted = { generation: done.generation, nonce: done.nonce };
      await ctx.journal.record("promote", "done", { ...deploy, generation: done.generation, nonce: done.nonce });
    },
    swap: async () => {
      if (staged === null) throw new Error("no staged droplet");
      await ctx.target.setDroplet(staged);
      await ctx.target.applyReleaseConfiguration({ dir: ctx.release.dir });
      await ctx.journal.record("swap", "done", { ...deploy, droplet: staged });
    },
    start: async () => {
      startedAt = ctx.clock();
      await ctx.journal.record("start", "started", deploy);
      await startTarget(ctx);
    },
    verify: async () => {
      const probe = await ctx.target.probeReady();
      const crashes = await ctx.target.crashEvents(startedAt);
      end.verdict = crashes.length > 0 || probe.outcome === "not-ready" ? "failed" : probe.outcome === "unverifiable" ? "unverifiable" : "passed";
      await ctx.journal.record("verify", "done", { ...deploy, verdict: end.verdict, promoted });
    },
    retire: async () => {
      const result = await ctx.steps.retire(ctx, await readUpdateRun(ctx, ctx.run.id));
      await ctx.journal.record("retire", "done", { ...deploy, droplets: result.droplets, revisions: result.revisions, savedDroplet: result.savedDroplet });
    },
  };
  for (const step of DEPLOY_STEPS.slice(state.from, stepIndex(until) + 1)) {
    try {
      before(step, ctx);
      await steps[step]();
    } catch (error) {
      end.failure = error instanceof Error ? error : new Error(String(error));
      return end;
    }
    end.last = step;
    if (step === "verify" && end.verdict !== "passed") return end;
  }
  return end;
}

/**
 * Starts a deploy run in a new process context and runs it up to and including `until`, or to the step that throws;
 * `before` sees each step and the context just before the step runs.
 */
export async function deployUntil(scenario: Scenario, until: DeployStep, options: ContextOptions = {}, before?: (step: DeployStep, ctx: UpdateContext) => void): Promise<ScenarioRun> {
  const ctx = await scenario.h.context({ command: "update deploy", answers: { "unsealed-stop": "accept" }, ...options });
  const end = await runSteps(ctx, scenario, null, until, before);
  return { runId: ctx.run.id, ctx, end };
}

/** Update run `runId` as its journal in the scenario's store shows it. */
export function runOf(scenario: Scenario, runId: string): Promise<UpdateRun> {
  return readUpdateRun({ backups: scenario.h.store, location: LOCATION, poll: { delayMs: 5, attempts: 200 } }, runId);
}

/**
 * A context of a later command that continues run `runId` in a new process, after its opening `run` record, and the
 * run as the journal showed it before that record.
 */
export async function continueRun(scenario: Scenario, runId: string, command: string, options: Omit<ContextOptions, "run" | "command"> = {}): Promise<{ ctx: UpdateContext; run: UpdateRun }> {
  const run = await runOf(scenario, runId);
  const ctx = await scenario.h.context({ answers: { "unsealed-stop": "accept" }, ...options, run });
  await ctx.journal.record(RUN_STEP, "started", { command, env: ctx.envName, phase: command.split(" ")[1] ?? "deploy" });
  return { ctx, run };
}

const outcomeState = async (ctx: UpdateContext): Promise<UpdateRunState> => (await readUpdateRun(ctx, ctx.run.id)).state;

/**
 * A stand-in for `continueDeploy`: runs the remaining deploy steps of `run` after its last done one, migrating again
 * from the cutover backup when the migration did not finish, and rolls back automatically when verification fails.
 */
export function scenarioContinue(scenario: Scenario): (ctx: UpdateContext, run: UpdateRun) => Promise<UpdateOutcome> {
  return async (ctx, run) => {
    const end = await runSteps(ctx, scenario, run, "retire");
    const report = { runId: run.runId, steps: [], downtimeMs: null };
    if (end.failure === null && end.verdict === "passed") return { exitCode: UPDATE_EXIT.done, runId: run.runId, state: await outcomeState(ctx), message: "verified", report };
    if (end.verdict === "unverifiable") return { exitCode: UPDATE_EXIT.refused, runId: run.runId, state: await outcomeState(ctx), message: "halted", report };
    await ctx.steps.rollback(ctx, await readUpdateRun(ctx, run.runId), { kind: "automatic", failure: end.failure?.message ?? "verification failed" });
    return { exitCode: UPDATE_EXIT.rolledBack, runId: run.runId, state: await outcomeState(ctx), message: "rolled back", report };
  };
}

/** Records `accept` for run `runId` at `at`, as `update accept` does. */
export async function acceptRun(scenario: Scenario, runId: string): Promise<void> {
  const { ctx } = await continueRun(scenario, runId, "update accept");
  await ctx.journal.record("accept", "done", { phase: "accept" });
}

/** Rows of every table of a database file, by table, ordered by `id` where the table has one and by rowid otherwise. */
export function rowsOf(file: string): Record<string, unknown[]> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const order = (table: string): string => (db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = 'id'`).get(table) === undefined ? "rowid" : `"id"`);
    return Object.fromEntries(tables(db).map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY ${order(table)}`).all()]));
  } finally {
    db.close();
  }
}

/** The originals `blobs.jsonl` of a backup lists. */
export async function blobsOf(store: ObjectStore, backupId: string): Promise<BlobEntry[]> {
  return boundaryCast<BlobEntry[]>(fromJsonl((await store.get(LOCATION + keys.blobs(backupId))) ?? new Uint8Array()), "json");
}

/** The `origin.json` of the newest replica generation, or null when it has none. */
export async function newestOrigin(store: ObjectStore): Promise<(Origin & { generation: string }) | null> {
  const newest = (await listGenerations(store, PREFIXES.replica)).at(-1);
  if (newest === undefined) return null;
  const data = await store.get(markerKey(PREFIXES.replica, newest.name, "origin"));
  const value: unknown = data === null ? null : parseJsonOrNull(data);
  return value === null ? null : { ...boundaryCast<Origin>(value, "json"), generation: newest.name };
}

/**
 * Wraps the target's `start` so every start is checked first: a release whose replication runtime is before 6 must
 * never start while the newest generation is one an update promoted (`origin.json` of kind `upgrade`). Returns the
 * violations seen.
 */
export function guardStarts(scenario: Scenario): string[] {
  const violations: string[] = [];
  const target = scenario.h.target;
  const start = target.start.bind(target);
  target.start = async () => {
    const major = Number(target.release.runtime.split(".")[0]);
    const origin = await newestOrigin(scenario.h.store);
    if (major < 6 && origin?.kind === "upgrade") violations.push(`runtime ${target.release.runtime} started on promoted generation ${origin.generation}`);
    return start();
  };
  return violations;
}
