import { messageOf, recordQuietly } from "../context.ts";
import { Interrupted } from "../interrupt.ts";
import { acknowledgement, listGenerations, type Generation } from "../replica.ts";
import { readUpdateRun, reportOf } from "./journal.ts";
import type { ReadyProbe } from "./target.ts";
import { UPDATE_EXIT, type RollbackResult, type UpdateContext, type UpdateExitCode, type UpdateOutcome, type UpdatePhase, type UpdateRun, type VerifyCheck, type VerifyInput, type VerifyResult, type VerifyVerdict } from "./types.ts";

const sleeper = (ctx: UpdateContext) => ctx.poll.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

async function until<T>(ctx: UpdateContext, seconds: number, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = ctx.clock() + seconds * 1000;
  const sleep = sleeper(ctx);
  for (;;) {
    const value = await read();
    if (done(value) || ctx.clock() >= deadline) return value;
    await sleep(ctx.poll.delayMs ?? 1000);
  }
}

const own = (gens: readonly Generation[], promoted: string): Generation | undefined => gens.find((g) => g.name > promoted && g.snapshot !== null);

function advanced(gens: readonly Generation[], first: Generation): boolean {
  const since = first.snapshot?.lastModified ?? Number.POSITIVE_INFINITY;
  const current = gens.find((g) => g.name === first.name);
  if (current === undefined) return false;
  const later = current.segments.some((info) => info.lastModified >= since);
  return later || gens.some((g) => g.name > first.name && g.snapshot !== null);
}

const check = (name: VerifyCheck["name"], ok: boolean, detail: string, hard = true): VerifyCheck => ({ name, hard, ok, detail });

const describeProbe = (probe: ReadyProbe): string => (probe.outcome === "unverifiable" ? `${probe.reason}${probe.status === null ? "" : ` (${probe.status})`}` : `answered ${probe.status}`);

/**
 * Verifies a started release. Hard checks: an instance runs and the platform recorded no crash since the start, both
 * read again once every wait below ended, so a crash inside the windows fails the verification;
 * readiness in three outcomes (ready; not-ready fails; unverifiable halts); `applied.json` of the promoted generation
 * names it and the nonce of its `origin.json`; the release's own generation, sorting after the promoted one, shows its
 * first snapshot; within `update.syncWindowSeconds` a WAL segment written after that snapshot, or a later generation
 * with a snapshot, shows that the sync advances (`origin.json`, `applied.json` and `sealed.json` do not count); a key under the
 * delivery prefix newer than the start shows that a render began within `update.renderTimeoutSeconds`. The soft
 * check `pages` (the delivery prefix holds keys) only warns. When reading the store or the target throws during a
 * check, the check `readable` fails and the verdict is `unverifiable`: a check that cannot be read halts, it does not
 * roll back.
 */
export async function verifyRelease(ctx: UpdateContext, input: VerifyInput): Promise<VerifyResult> {
  const checks: VerifyCheck[] = [];
  try {
    return await checkRelease(ctx, input, checks);
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    const reason = `a check could not read the store or the target: ${messageOf(error)}`;
    checks.push(check("readable", false, reason));
    ctx.out.error(`verify readable: ${reason}`);
    return { verdict: "unverifiable", checks, ready: { outcome: "unverifiable", status: null, reason }, ownGeneration: null };
  }
}

async function platformChecks(ctx: UpdateContext, startedAt: number): Promise<[VerifyCheck, VerifyCheck]> {
  const status = await ctx.target.status();
  const crashes = await ctx.target.crashEvents(startedAt);
  return [
    check("instance", status.state === "started" && status.instances > 0, `${status.state} with ${status.instances} running instance(s)`),
    check("crashes", crashes.length === 0, crashes.length === 0 ? "no crash since the start" : crashes.map((c) => `${new Date(c.at).toISOString()} ${c.type}${c.reason === null ? "" : `: ${c.reason}`}`).join("; ")),
  ];
}

async function checkRelease(ctx: UpdateContext, input: VerifyInput, checks: VerifyCheck[]): Promise<VerifyResult> {
  checks.push(...(await platformChecks(ctx, input.startedAt)));
  const running = checks.every((c) => c.ok);
  const ready = running ? await until(ctx, ctx.update.readyTimeoutSeconds, () => ctx.target.probeReady(), (p) => p.outcome === "ready") : await ctx.target.probeReady();
  checks.push(check("ready", ready.outcome === "ready", describeProbe(ready)));
  let ownGeneration: string | null = null;
  if (running && ready.outcome !== "not-ready") {
    const prefix = ctx.env.app.replicaPrefix;
    const promoted = input.promoted.generation;
    const ack = await acknowledgement(ctx.app, prefix, { generation: promoted, nonce: input.promoted.nonce, at: 0, sha256: "", bytes: 0 }, ctx.poll);
    checks.push(check("provenance", ack === "applied", ack === "applied" ? `applied.json of ${promoted} names its nonce` : `no applied.json of ${promoted} names the nonce of its origin.json; the release did not restore the promoted generation`));
    const gens = await until(ctx, ctx.update.syncWindowSeconds, () => listGenerations(ctx.app, prefix), (g) => own(g, promoted) !== undefined);
    const first = own(gens, promoted);
    ownGeneration = first?.name ?? null;
    checks.push(check("first-snapshot", first !== undefined, first === undefined ? `no generation after ${promoted} shows a snapshot within ${ctx.update.syncWindowSeconds} s` : `generation ${first.name} holds its first snapshot`));
    if (first !== undefined) {
      const later = await until(ctx, ctx.update.syncWindowSeconds, () => listGenerations(ctx.app, prefix), (g) => advanced(g, first));
      checks.push(check("sync-advances", advanced(later, first), advanced(later, first) ? `generation ${first.name} was synced after its first snapshot` : `nothing reached generation ${first.name} after its first snapshot within ${ctx.update.syncWindowSeconds} s; the replication stands`));
    }
    const delivery = ctx.env.app.deliveryPrefix;
    const rendered = await until(ctx, ctx.update.renderTimeoutSeconds, () => ctx.app.list(delivery), (list) => list.some((info) => info.lastModified >= input.startedAt));
    const fresh = rendered.filter((info) => info.lastModified >= input.startedAt).length;
    checks.push(check("render-started", fresh > 0, fresh > 0 ? `${fresh} key(s) under ${delivery} written since the start` : `no key under ${delivery} was written within ${ctx.update.renderTimeoutSeconds} s of the start; the release did not render again`));
    checks.push(check("pages", rendered.length > 0, `${rendered.length} key(s) under ${delivery}`, false));
  }
  if (running) {
    const [instance, crashes] = await platformChecks(ctx, input.startedAt);
    checks.splice(0, 2, instance, crashes);
  }
  const hardFailed = checks.some((c) => c.hard && !c.ok && c.name !== "ready");
  const verdict: VerifyVerdict = hardFailed || ready.outcome === "not-ready" ? "failed" : ready.outcome === "unverifiable" ? "unverifiable" : "passed";
  for (const c of checks) {
    if (!c.ok && c.hard) ctx.out.error(`verify ${c.name}: ${c.detail}`);
    else if (!c.ok) ctx.out.warn(`verify ${c.name}: ${c.detail}`);
  }
  return { verdict, checks, ready, ownGeneration };
}

/** The outcome of a command on run `ctx.run.id`, with its state and report read back from the journal; the command line prints its message. */
export async function outcomeOf(ctx: UpdateContext, exitCode: UpdateExitCode, message: string): Promise<UpdateOutcome> {
  const run = await readUpdateRun(ctx, ctx.run.id);
  return { exitCode, runId: run.runId, state: run.state, message, report: reportOf(run) };
}

/** The message of an automatic rollback that brought back the cutover state but had no previous droplet to start. */
export function stoppedAfterRollback(ctx: Pick<UpdateContext, "envName">, failure: string): string {
  return `${failure}; the cutover state is back, but no previous droplet was left to start, so the app stays stopped: deploy the previous release again with node .kestrel-ops/run.mjs deploy --env ${ctx.envName}`;
}

/**
 * Records a verification of phase `phase` and acts on its verdict: `passed` retires the previous releases and ends
 * with exit 0 (1 when the retire failed, so the old droplets can still start until `update resume` retires them), `failed` rolls back automatically and ends with exit 3 (1 when the rollback did not finish or had no
 * previous droplet to start, so the app stays stopped),
 * `unverifiable` halts with exit 1 and leaves the new release running. `known` fills in what the caller knows of the
 * run and its journal listing may not show yet, such as the cutover backup and the promoted generation.
 */
export async function concludeVerify(ctx: UpdateContext, phase: UpdatePhase, result: VerifyResult, known: (run: UpdateRun) => UpdateRun = (run) => run): Promise<UpdateOutcome> {
  await ctx.journal.record("verify", "done", { phase, verdict: result.verdict, checks: result.checks, ownGeneration: result.ownGeneration });
  if (result.verdict === "unverifiable") return outcomeOf(ctx, UPDATE_EXIT.refused, `verification could not tell (${describeProbe(result.ready)}); the new release keeps running and nothing was rolled back. Once its readiness can be checked, run update resume --env ${ctx.envName} --run ${ctx.run.id}, or update rollback`);
  const run = known(await readUpdateRun(ctx, ctx.run.id));
  if (result.verdict === "failed") {
    const failure = result.checks.filter((c) => c.hard && !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ");
    let ended: RollbackResult["ended"];
    try {
      ended = (await ctx.steps.rollback(ctx, run, { kind: "automatic", failure })).ended;
    } catch (cause) {
      return outcomeOf(ctx, UPDATE_EXIT.refused, `verification failed (${failure}) and the automatic rollback did not finish: ${messageOf(cause)}; run update resume --env ${ctx.envName} --run ${ctx.run.id}, which runs the rollback again`);
    }
    if (ended === "stopped") return outcomeOf(ctx, UPDATE_EXIT.refused, stoppedAfterRollback(ctx, `verification failed (${failure})`));
    return outcomeOf(ctx, UPDATE_EXIT.rolledBack, `verification failed (${failure}); rolled back to the cutover state`);
  }
  const retired = await retireStep(ctx, run);
  if (!retired.ok) return outcomeOf(ctx, UPDATE_EXIT.refused, retireFailed(ctx, retired.error));
  return outcomeOf(ctx, UPDATE_EXIT.done, `verified; accept it with update accept --env ${ctx.envName}, or roll back with update rollback --env ${ctx.envName}`);
}

function retireFailed(ctx: UpdateContext, error: string): string {
  return `the new release is verified, but retiring the previous releases failed: ${error}; their droplets can still be started by the platform on the converted data until they are retired; run update resume --env ${ctx.envName} --run ${ctx.run.id} to retire them`;
}

/**
 * Runs the `retire` step of verified deploy run `run` between a `retire` started record and its `done` or `failed`
 * record, and never throws but for an interrupt, which it records as `failed` first and throws again with the command
 * that retires them. When `again` is set and the app runs another droplet than the one the run deployed, a later
 * deploy replaced it and retired the releases itself: the step is recorded as `skipped`.
 */
export async function retireStep(ctx: UpdateContext, run: UpdateRun, again = false): Promise<{ ok: true } | { ok: false; error: string }> {
  if (again && run.stagedDroplet !== null && (await ctx.target.currentDroplet()) !== run.stagedDroplet) {
    await ctx.journal.record("retire", "skipped", { phase: "deploy", reason: "a later deploy replaced the droplet of this run" });
    return { ok: true };
  }
  await ctx.journal.record("retire", "started", { phase: "deploy" });
  try {
    const retired = await ctx.steps.retire(ctx, run);
    await ctx.journal.record("retire", "done", { phase: "deploy", droplets: retired.droplets, revisions: retired.revisions, savedDroplet: retired.savedDroplet, kept: retired.kept });
    return { ok: true };
  } catch (cause) {
    await recordQuietly(ctx, "retire", "failed", { phase: "deploy", error: messageOf(cause) });
    if (cause instanceof Interrupted) throw new Interrupted(cause.signal, retireFailed(ctx, "it was interrupted"));
    ctx.out.error(`retiring the previous releases failed: ${messageOf(cause)}`);
    return { ok: false, error: messageOf(cause) };
  }
}

/** `update verify`: verifies the running release of deploy run `run` again, for a halted run once readiness can be checked. */
export async function verifyCommand(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome> {
  if ((run.state !== "halted" && run.state !== "verifying") || run.promoted === null) return outcomeOf(ctx, UPDATE_EXIT.refused, `update run ${run.runId} is ${run.state}; only a started deploy whose verification did not conclude can be verified again`);
  const start = [...run.records].reverse().find((r) => r.step === "start" && r.phase === "deploy");
  const recorded: unknown = start?.data.startedAt;
  const startedAt = typeof recorded === "number" ? recorded : (start?.at ?? run.lastAt);
  await ctx.journal.record("verify", "started", { phase: "verify" });
  const promoted = run.promoted;
  return concludeVerify(ctx, "verify", await ctx.steps.verify(ctx, { promoted, startedAt }), (read) => ({ ...read, stagedDroplet: read.stagedDroplet ?? run.stagedDroplet, cutoverBackup: read.cutoverBackup ?? run.cutoverBackup, promoted: read.promoted ?? promoted }));
}
