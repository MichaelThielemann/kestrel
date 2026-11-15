import { writeFileSync } from "node:fs";
import { acceptSeal, createBackup, precopy, readManifest } from "../backup.ts";
import { messageOf, stopTarget } from "../context.ts";
import { OpsError } from "../errors.ts";
import { Interrupted } from "../interrupt.ts";
import { keys, unstamp } from "../layout.ts";
import { recordPlacement } from "../placements.ts";
import { confirm } from "../questions.ts";
import { promote, stableGenerations } from "../replica.ts";
import { appClock, type ServerClock } from "../serverTime.ts";
import { sha256 } from "../sqlite.ts";
import { checkGate } from "./gate.ts";
import { continueJournal, listUpdateRuns, readUpdateRun } from "./journal.ts";
import { UPDATE_PIN_PREFIX, updateKeys } from "./layout.ts";
import { computePlan, planHash, replicaCopy } from "./plan.ts";
import { UPDATE_EXIT, type UpdateContext, type UpdateOutcome, type UpdatePlan, type UpdateRun, type VerifyResult, type VersionSet } from "./types.ts";
import { concludeVerify, outcomeOf } from "./verify.ts";

type Entry = "seal" | "cutover-backup" | "migrate" | "swap" | "start" | "verify";

interface Flow {
  plan: UpdatePlan | null;
  from: VersionSet | null;
  staged: string;
  stoppedAt: number;
  cutoverBackup: string | null;
  promoted: { generation: string; nonce: string; at: number } | null;
  startedAt: number | null;
}

const record = (ctx: UpdateContext, step: string, state: "started" | "done" | "failed" | "skipped", data: Record<string, unknown> = {}): Promise<void> => ctx.journal.record(step, state, { phase: "deploy", ...data });

const sleeper = (ctx: UpdateContext) => ctx.poll.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

async function cutoverDatabase(ctx: UpdateContext, backupId: string, file: string): Promise<string> {
  const manifest = await readManifest(ctx, backupId);
  if (manifest?.db === null || manifest === null) throw new OpsError(`the cutover backup ${backupId} holds no database`, 1, backupId);
  const data = await ctx.backups.get(ctx.location + keys.db(backupId));
  if (data === null || sha256(data) !== manifest.db.sha256) throw new OpsError(`the database of the cutover backup ${backupId} is missing or differs from its manifest`, 1, keys.db(backupId));
  writeFileSync(file, data);
  return file;
}

async function earlierDeploys(ctx: UpdateContext): Promise<UpdateRun[]> {
  const runs: UpdateRun[] = [];
  for (const entry of await listUpdateRuns(ctx, ctx.envName)) if (entry.command === "update deploy" && entry.runId !== ctx.run.id) runs.push(await readUpdateRun(ctx, entry.runId));
  return runs;
}

async function acceptImplicitly(ctx: UpdateContext, runId: string): Promise<void> {
  const earlier = await readUpdateRun(ctx, runId);
  await continueJournal(ctx, earlier).record("accept", "done", { phase: "accept", implicit: true, by: ctx.run.id });
  ctx.out.info(`update run ${runId} is accepted by this deploy`);
}

async function putOnce(ctx: UpdateContext, key: string, text: string): Promise<void> {
  if ((await ctx.backups.head(key)) !== null) throw new OpsError(`refusing to overwrite ${key}`, 1, key);
  await ctx.backups.put(key, new TextEncoder().encode(text), { contentType: "application/json" });
}

async function waitUntilStartable(ctx: UpdateContext, at: number, clock: ServerClock): Promise<void> {
  const sleep = sleeper(ctx);
  const behind = (): number => at + 1000 - Math.min(clock.now(), ctx.clock());
  while (behind() > 0) await sleep(Math.min(1000, behind()));
}

function stopQuestion(ctx: UpdateContext, plan: UpdatePlan): string {
  const migrations = plan.storage.length + plan.content.length;
  return `stop ${ctx.envName} now for the cutover backup${migrations > 0 ? `, ${migrations} migration(s)` : ""} and the start of the new release; the app stays down until the new release is verified`;
}

/**
 * Deploys the release in the order of `DEPLOY_STEPS`. While the old release serves: `gate`, `stage` (a staging
 * failure ends the run with exit 1 and the app was never stopped), `configuration` (recorded once into the backup
 * location), `precopy`. Then `stop` (after the `update-stop` answer), `seal` (waits for the seal after STOPPED),
 * `cutover-backup` (verified, pinned for this run until `update cleanup`), `migrate` (on a copy of the cutover
 * database), and `promote`, `swap` and `start` as one step without a question between them. `verify` decides: passed
 * runs `retire` and ends with exit 0; failed runs the automatic rollback and ends with exit 3 once it verified the
 * cutover state; unverifiable halts with exit 1 and leaves the new release running.
 */
export async function deploy(ctx: UpdateContext): Promise<UpdateOutcome> {
  let step = "gate";
  let stopBegun = false;
  let flow: Flow;
  try {
    await record(ctx, "gate", "started");
    const plan = await computePlan(ctx, await replicaCopy(ctx, ctx.workspace.path("plan.db")));
    const gate = await checkGate(ctx, plan, await earlierDeploys(ctx));
    if (gate.accepts !== null) await acceptImplicitly(ctx, gate.accepts);
    await record(ctx, "gate", "done", { receipt: gate.receipt === null ? null : `${gate.planHash}/${gate.receipt.runId}`, versions: plan.versions, planHash: gate.planHash, ordinary: gate.ordinary });

    step = "stage";
    await record(ctx, "stage", "started");
    const staged = await ctx.target.stage({ dir: ctx.release.dir });
    await record(ctx, "stage", "done", { droplet: staged.droplet, package: staged.package });
    ctx.out.info(`staged droplet ${staged.droplet} while the app keeps running`);

    step = "configuration";
    const droplet = await ctx.target.currentDroplet();
    const recorded = await ctx.target.readConfiguration(new Set(ctx.host.secretEnvNames ?? []));
    const key = updateKeys.configuration(ctx.envName, ctx.run.id);
    await putOnce(ctx, ctx.location + key, ctx.redactor.json(recorded, 2) + "\n");
    await record(ctx, "configuration", "done", { droplet, key });

    step = "precopy";
    await record(ctx, "precopy", "started");
    const copied = await precopy(ctx, [ctx.env.app.mediaPrefix, ctx.env.app.deliveryPrefix]);
    await record(ctx, "precopy", "done", { copied });

    step = "stop";
    await confirm(ctx.answers, "update-stop", stopQuestion(ctx, plan));
    await record(ctx, "stop", "started");
    stopBegun = true;
    const { stoppedAt } = await stopTarget(ctx);
    flow = { plan, from: plan.versions.from, staged: staged.droplet, stoppedAt, cutoverBackup: null, promoted: null, startedAt: null };
  } catch (error) {
    if (error instanceof Interrupted) throw stopBegun ? new Interrupted(error.signal, `the stop began, so the app may be stopped; do not start it by hand; run update abort --env ${ctx.envName} --run ${ctx.run.id}`) : error;
    if (stopBegun) return failedStop(ctx, error);
    await record(ctx, step, "failed", { error: messageOf(error) }).catch(() => undefined);
    const exitCode = error instanceof OpsError && error.exitCode === 2 ? UPDATE_EXIT.usage : UPDATE_EXIT.refused;
    return outcomeOf(ctx, exitCode, `the deploy stopped at ${step} before the app was stopped; production is unchanged: ${messageOf(error)}`);
  }
  return afterStop(ctx, flow, "seal");
}

async function failedStop(ctx: UpdateContext, error: unknown): Promise<UpdateOutcome> {
  const now = await ctx.target.status().catch(() => null);
  const runs = now?.state === "started";
  await record(ctx, "stop", "failed", { error: messageOf(error), appStopped: !runs }).catch(() => undefined);
  if (runs) return outcomeOf(ctx, UPDATE_EXIT.refused, `the deploy stopped at stop: ${messageOf(error)}; the previous release runs, nothing else changed`);
  return outcomeOf(ctx, UPDATE_EXIT.refused, `the deploy failed at stop: ${messageOf(error)}; the app ${now === null ? "may be stopped (its state cannot be read)" : "is stopped"} and did not start again; do not start it by hand while the run is open; run update abort --env ${ctx.envName} --run ${ctx.run.id}`);
}

function interruptedAfterStop(ctx: UpdateContext, step: string): string {
  const scope = `--env ${ctx.envName} --run ${ctx.run.id}`;
  const state = step === "verify" ? "the new release runs and is not verified" : step === "start" ? "the new release may be starting and is not verified" : "the app is stopped; do not start it by hand";
  return `${state}; run update resume ${scope} to continue the run, or update abort ${scope} to end it`;
}

function known(run: UpdateRun, flow: Pick<Flow, "staged" | "cutoverBackup" | "promoted">): UpdateRun {
  const promoted = flow.promoted === null ? run.promoted : { generation: flow.promoted.generation, nonce: flow.promoted.nonce };
  return { ...run, stagedDroplet: run.stagedDroplet ?? flow.staged, cutoverBackup: run.cutoverBackup ?? flow.cutoverBackup, promoted: run.promoted ?? promoted };
}

async function afterStop(ctx: UpdateContext, flow: Flow, entry: Entry): Promise<UpdateOutcome> {
  const order: Entry[] = ["seal", "cutover-backup", "migrate", "swap", "start", "verify"];
  const from = order.indexOf(entry);
  const at = (e: Entry): boolean => order.indexOf(e) >= from;
  let step: string = entry;
  let result: VerifyResult;
  try {
    if (at("seal")) {
      step = "seal";
      await record(ctx, "seal", "started");
      const seal = await ctx.steps.waitForSeal(ctx, flow.stoppedAt);
      await acceptSeal(ctx, seal, flow.stoppedAt);
      await record(ctx, "seal", "done", { state: seal.state, generation: seal.generation });
      step = "cutover-backup";
      await record(ctx, "cutover-backup", "started");
      const running = { ...ctx, project: { versions: flow.from ?? {}, lockfileSha256: null } };
      const backup = await createBackup(running, { kind: "cutover", mode: { kind: "stopped", seal, stoppedAt: flow.stoppedAt }, pinFor: UPDATE_PIN_PREFIX + ctx.run.id });
      flow.cutoverBackup = backup.id;
      await record(ctx, "cutover-backup", "done", { backupId: backup.id });
      ctx.out.info(`cutover backup ${backup.id} written, verified and pinned`);
    }
    if (at("migrate")) {
      step = "migrate";
      const cutover = flow.cutoverBackup;
      if (cutover === null) throw new OpsError("the run has no cutover backup to migrate from", 1, "migrate");
      await record(ctx, "migrate", "started", { cutoverBackup: cutover });
      const start = await cutoverDatabase(ctx, cutover, ctx.workspace.path("cutover.db"));
      const plan = flow.plan ?? (await computePlan(ctx, start));
      flow.plan = plan;
      let database = start;
      if (plan.storage.length > 0 || plan.content.length > 0) {
        const migrated = await ctx.steps.migrateCopy(ctx, { cutoverBackup: cutover, plan, outFile: ctx.workspace.path("migrated.db") });
        database = ctx.workspace.path("migrated.db");
        await record(ctx, "migrate", "done", { migrated: true, sha256: migrated.sha256, storage: migrated.storage.map((m) => m.module), content: migrated.content, changedTables: migrated.changedTables });
      } else await record(ctx, "migrate", "done", { migrated: false });

      step = "promote";
      await record(ctx, "promote", "started");
      const clock = await appClock(ctx);
      const placing = { ...ctx, runId: ctx.run.id };
      const promoted = await promote({ store: ctx.app, prefix: ctx.env.app.replicaPrefix, target: ctx.target, database, origin: { kind: "upgrade", source: cutover }, serverNow: clock.now, skewMs: clock.skewMs, clock: ctx.clock, poll: ctx.poll, beforePlace: (generation) => recordPlacement(placing, generation) });
      flow.promoted = { generation: promoted.generation, nonce: promoted.nonce, at: promoted.at };
      await record(ctx, "promote", "done", { generation: promoted.generation, nonce: promoted.nonce, sha256: promoted.sha256 });
    }
    const promoted = flow.promoted;
    if (promoted === null) throw new OpsError("the run has no promoted generation", 1, "promote");
    if (at("swap")) {
      step = "swap";
      await waitUntilStartable(ctx, promoted.at, await appClock(ctx));
      await record(ctx, "swap", "started");
      await ctx.target.setDroplet(flow.staged);
      await ctx.target.applyReleaseConfiguration({ dir: ctx.release.dir });
      await record(ctx, "swap", "done", { droplet: flow.staged });
    }
    if (at("start")) {
      step = "start";
      const clock = await appClock(ctx);
      const startedAt = clock.now();
      flow.startedAt = startedAt;
      await record(ctx, "start", "started", { startedAt });
      if ((await ctx.target.status()).state !== "started") await ctx.target.start();
      const ready = await ctx.target.waitReady(ctx.update.readyTimeoutSeconds * 1000);
      await record(ctx, "start", "done", { ready, startedAt });
    }
    step = "verify";
    await record(ctx, "verify", "started");
    result = await ctx.steps.verify(ctx, { promoted: { generation: promoted.generation, nonce: promoted.nonce }, startedAt: flow.startedAt ?? ctx.clock() });
  } catch (error) {
    if (error instanceof Interrupted) throw new Interrupted(error.signal, interruptedAfterStop(ctx, step));
    const failure = `${step}: ${messageOf(error)}`;
    await record(ctx, step, "failed", { error: messageOf(error) }).catch(() => undefined);
    ctx.out.error(`the deploy failed after the stop at ${failure}; rolling back`);
    try {
      await ctx.steps.rollback(ctx, known(await readUpdateRun(ctx, ctx.run.id), flow), { kind: "automatic", failure });
    } catch (cause) {
      return outcomeOf(ctx, UPDATE_EXIT.refused, `the deploy failed at ${failure}, and the automatic rollback did not finish: ${messageOf(cause)}; the app stays stopped; do not start it by hand; run update resume --env ${ctx.envName} --run ${ctx.run.id}, which runs the rollback again`);
    }
    return outcomeOf(ctx, UPDATE_EXIT.rolledBack, flow.cutoverBackup === null ? `the deploy failed at ${failure} before its cutover backup; nothing was promoted, and the previous release runs again on the unchanged replica` : `the deploy failed at ${failure}; rolled back to the cutover state`);
  }
  return concludeVerify(ctx, "deploy", result, (run) => known(run, flow));
}

const doneStep = (run: UpdateRun, step: string): boolean => run.records.some((r) => r.phase === "deploy" && r.step === step && r.state === "done");
const startedStep = (run: UpdateRun, step: string): boolean => run.records.some((r) => r.phase === "deploy" && r.step === step);

/**
 * Continues deploy run `run` after its last done step (see `UpdateRun.lastDone`), checking that step's postcondition
 * first: a migration that did not finish starts again from the cutover backup's database; a promotion whose generation
 * is not the newest any more is refused; after `promote` it swaps and starts; after `start` it verifies.
 */
export async function continueDeploy(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  if (run.state !== "down" && run.state !== "verifying") return outcomeOf(ctx, UPDATE_EXIT.refused, `update run ${run.runId} is ${run.state}; only a deploy that stopped the app and has not concluded can be continued${run.state === "deploying" ? `; ${startedStep(run, "stop") ? "its stop began, so the app may be stopped" : "nothing changed yet"}: run update abort --env ${ctx.envName} --run ${run.runId} and deploy again` : ""}`);
  const stop = run.records.find((r) => r.phase === "deploy" && r.step === "stop" && r.state === "done");
  const stoppedAt = stop?.data.stoppedAt;
  if (run.stagedDroplet === null || typeof stoppedAt !== "number") return outcomeOf(ctx, UPDATE_EXIT.refused, `update run ${run.runId} records no staged droplet or no completed stop; run update ${run.cutoverBackup === null ? "abort" : "rollback"} --env ${ctx.envName} --run ${run.runId}`);
  const startRecord = [...run.records].reverse().find((r) => r.phase === "deploy" && r.step === "start");
  const recordedStart = startRecord?.data.startedAt;
  const flow: Flow = { plan: null, from: run.versions?.from ?? null, staged: run.stagedDroplet, stoppedAt, cutoverBackup: run.cutoverBackup, promoted: run.promoted === null ? null : { ...run.promoted, at: unstamp(run.promoted.generation) }, startedAt: typeof recordedStart === "number" ? recordedStart : null };
  if (flow.promoted !== null) {
    if (!startedStep(run, "start")) {
      const newest = (await stableGenerations(ctx.app, ctx.env.app.replicaPrefix, ctx.poll)).at(-1);
      if (newest?.name !== flow.promoted.generation) return outcomeOf(ctx, UPDATE_EXIT.refused, `the promoted generation ${flow.promoted.generation} is not the newest any more (${newest?.name ?? "none"} is); starting the release now would restore other data; run update rollback --env ${ctx.envName} --run ${run.runId}`);
      return afterStop(ctx, flow, doneStep(run, "swap") ? "start" : "swap");
    }
    return afterStop(ctx, flow, doneStep(run, "start") ? "verify" : "start");
  }
  if (flow.cutoverBackup !== null) {
    if (run.receipt !== null) {
      const plan = await computePlan(ctx, await cutoverDatabase(ctx, flow.cutoverBackup, ctx.workspace.path("cutover-plan.db")));
      const hash = planHash(plan);
      if (!run.receipt.startsWith(`${hash}/`)) return outcomeOf(ctx, UPDATE_EXIT.refused, `the plan of the cutover database (${hash.slice(0, 12)}) differs from the receipt the gate matched; run update rollback --env ${ctx.envName} --run ${run.runId}`);
      flow.plan = plan;
    }
    return afterStop(ctx, flow, "migrate");
  }
  return afterStop(ctx, flow, "seal");
}
