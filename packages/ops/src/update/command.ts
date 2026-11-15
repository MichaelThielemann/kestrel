import { resolve } from "node:path";
import { messageOf } from "../context.ts";
import { projectFacts, releaseVersions, writeBundle } from "../bundle.ts";
import { updateSettings } from "../environments.ts";
import { OpsError } from "../errors.ts";
import { hex } from "../layout.ts";
import { acquireLock, breakLocks, type Lock } from "../lock.ts";
import { createOutput } from "../output.ts";
import { fixedText, literal, Redactor } from "../redact.ts";
import { flagValue, openContext, parseArgs, selectEnvironment, type OpenedContext, type ParsedArgs, type RunOptions } from "../run.ts";
import { abort } from "./abort.ts";
import { accept } from "./accept.ts";
import { cleanup, type CleanupOptions } from "./cleanup.ts";
import { deploy } from "./deploy.ts";
import { continueJournal, latestDeployRun, readUpdateRun, reportOf, RUN_STEP } from "./journal.ts";
import { prepare, type PrepareOptions, type PrepareResult } from "./prepare.ts";
import { resume } from "./resume.ts";
import { rollbackCommand } from "./rollback.ts";
import { renderStatus, updateStatus } from "./status.ts";
import { defaultSteps } from "./steps.ts";
import { isUpdateTarget } from "./target.ts";
import type { UpdateContext, UpdateOutcome, UpdatePhase, UpdateRun } from "./types.ts";
import { verifyCommand } from "./verify.ts";

/** The usage text of `kestrel update`; `deploy`, `verify` and `bundle` belong to the pipeline and are not listed. */
export const UPDATE_USAGE = `usage:
  update prepare [--full-media]
  update accept [--run <id>]
  update rollback [--run <id>]
  update status [--run <id>]
  update resume [--run <id>]
  update abort [--run <id>]
  update cleanup [--run <id>] [--dry-run]
common options: --env <name>, --json, --yes, --answers <file>, --keep, --break-lock
exit codes: 0 done, 1 a check failed, a step was refused or the run halted, 2 usage or configuration error,
  3 a hard failure after the stop was rolled back automatically`;

/** The commands {@link runUpdate} hands a parsed command line to; `RunOptions.updateCommands` replaces them in tests. */
export interface UpdateCommands {
  prepare(ctx: UpdateContext, options: PrepareOptions): Promise<PrepareResult>;
  deploy(ctx: UpdateContext): Promise<UpdateOutcome>;
  verify(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome>;
  accept(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome>;
  rollback(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome>;
  resume(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome>;
  abort(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome>;
  cleanup(ctx: UpdateContext, run: UpdateRun, options: CleanupOptions): Promise<UpdateOutcome>;
}

/** The real update commands. */
export function defaultCommands(): UpdateCommands {
  return { prepare, deploy, verify: verifyCommand, accept, rollback: rollbackCommand, resume, abort, cleanup };
}

/** The subcommands of `update`, with the options each takes besides the common ones. */
export const UPDATE_SUBCOMMANDS = {
  prepare: ["--full-media"],
  deploy: [],
  verify: ["--run"],
  accept: ["--run"],
  rollback: ["--run"],
  status: ["--run"],
  resume: ["--run"],
  abort: ["--run"],
  cleanup: ["--run", "--dry-run"],
  bundle: ["--out"],
} as const satisfies Record<string, readonly string[]>;

/** One subcommand of `update`. */
export type UpdateSubcommand = keyof typeof UPDATE_SUBCOMMANDS;

const COMMON_FLAGS = ["--env", "--json", "--yes", "--answers", "--keep", "--break-lock"];
const VALUE_FLAGS = new Set(["--env", "--answers", "--run", "--out"]);
const RUN_ID = /^[0-9a-z][0-9a-z_-]{0,63}$/;

const isSubcommand = (word: string | undefined): word is UpdateSubcommand => word !== undefined && Object.hasOwn(UPDATE_SUBCOMMANDS, word);

const usage = (message: string, element?: string): OpsError => new OpsError(message, 2, element);

function readSubcommand(parsed: ParsedArgs): UpdateSubcommand {
  const [sub, ...rest] = parsed.positional;
  if (!isSubcommand(sub)) throw usage(sub === undefined ? "no update command given" : `unknown update command ${sub}`, sub);
  if (rest.length > 0) throw usage(`update ${sub} takes no argument ${rest.join(" ")}`, rest[0]);
  const allowed = new Set<string>([...COMMON_FLAGS, ...UPDATE_SUBCOMMANDS[sub]]);
  const foreign = [...parsed.flags.keys()].filter((flag) => !allowed.has(flag));
  if (foreign.length > 0) throw usage(`update ${sub} does not take ${foreign.join(", ")}`, foreign[0]);
  const run = flagValue(parsed, "--run");
  if (run !== null && !RUN_ID.test(run)) throw usage(`${run} is not a run id`, "--run");
  return sub;
}

const PHASE: Record<Exclude<UpdateSubcommand, "status" | "bundle">, UpdatePhase> = {
  prepare: "prepare",
  deploy: "deploy",
  verify: "verify",
  accept: "accept",
  rollback: "rollback",
  resume: "resume",
  abort: "abort",
  cleanup: "cleanup",
};

function formatMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

async function openRun(ctx: UpdateContext, requested: string | null): Promise<UpdateRun> {
  const run = requested === null ? await latestDeployRun(ctx, ctx.envName) : await readUpdateRun(ctx, requested);
  if (run === null) throw new OpsError(fixedText`environment ${literal(ctx.envName)} has no update run to continue; a deploy starts one`, 1, "--run");
  if (run.env !== ctx.envName) throw usage(`update run ${run.runId} belongs to environment ${run.env}, not ${ctx.envName}`, "--run");
  return run;
}

/**
 * Runs one `update` command line (`argv` without the word `update`): `prepare`, `accept`, `rollback`, `status`,
 * `resume`, `abort`, `cleanup`, and for the pipeline `deploy`, `verify` and `bundle`. It loads the environment like
 * `runOps`, requires a target that implements `UpdateTarget` (exit 2 otherwise), takes the lock for every command but
 * `status`, opens or continues the run's journal, and resolves to one of `UPDATE_EXIT`. With `--json` it prints one
 * document with a `schema` field such as `kestrel-ops/update-deploy@1`.
 */
export async function runUpdate(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const redactor = new Redactor();
  const stdout = options.stdout ?? ((t: string) => process.stdout.write(t));
  const stderr = options.stderr ?? ((t: string) => process.stderr.write(t));
  const json = argv.includes("--json");
  const out = createOutput(redactor, stdout, stderr, json);
  const emit = (schema: string, payload: Record<string, unknown>): void => {
    if (json) stdout(redactor.document({ schema: `kestrel-ops/${schema}@1`, ...payload }, 2) + "\n");
  };
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    stdout(`${UPDATE_USAGE}\n`);
    return 0;
  }
  let parsed: ParsedArgs;
  let sub: UpdateSubcommand;
  try {
    parsed = parseArgs(argv, VALUE_FLAGS);
    sub = readSubcommand(parsed);
  } catch (error) {
    const message = messageOf(error);
    stderr(`error: ${message}\n${UPDATE_USAGE}\n`);
    emit("error", { ok: false, message, element: error instanceof OpsError ? (error.element ?? null) : null });
    return 2;
  }
  const schema = `update-${sub}`;
  const root = resolve(options.cwd ?? process.cwd());
  const clock = options.clock ?? Date.now;
  const runId = hex(6);
  let opened: OpenedContext | null = null;
  let ctx: UpdateContext | null = null;
  let lock: Lock | null = null;
  let journaled = false;
  try {
    if (sub === "bundle") {
      const outDir = resolve(root, flagValue(parsed, "--out") ?? ".");
      const bundle = writeBundle(root, outDir, options.host ?? {}, clock);
      out.info(`wrote ${bundle.dir} with ${Object.keys(bundle.packages).length} package(s)`);
      emit(schema, { ok: true, exitCode: 0, dir: bundle.dir, packages: bundle.packages });
      return 0;
    }
    const { envName, environment } = selectEnvironment(root, flagValue(parsed, "--env"));
    const project = options.project ?? projectFacts(root);
    opened = await openContext(options, { envName, environment, root, runId, writing: sub !== "status", answersFile: flagValue(parsed, "--answers"), yes: parsed.flags.has("--yes"), keep: parsed.flags.has("--keep"), project, redactor, out });
    const base = opened.ctx;
    const target = base.target;
    if (!isUpdateTarget(target)) throw new OpsError(fixedText`the target adapter ${environment.target.adapter} of ${literal(envName)} cannot run an update: it does not stage, swap and verify a release`, 2, "target");
    const update = updateSettings(environment);
    ctx = {
      ...base,
      target,
      update,
      release: { dir: resolve(options.releaseRoot ?? root, update.release.dir), projectDir: resolve(options.releaseRoot ?? root), versions: releaseVersions(project.versions), lockfileSha256: project.lockfileSha256 },
      host: options.host ?? {},
      run: { id: runId },
      steps: { ...defaultSteps(), ...options.updateSteps },
    };
    if (sub === "status") {
      const report = await updateStatus(ctx, flagValue(parsed, "--run"));
      for (const line of renderStatus(report)) out.info(line);
      emit(schema, { ok: true, exitCode: 0, ...report });
      return 0;
    }
    const opening = { command: `update ${sub}`, env: envName, phase: PHASE[sub], process: runId };
    const fresh = sub === "prepare" || sub === "deploy";
    if (fresh) {
      await ctx.journal.record(RUN_STEP, "started", opening);
      journaled = true;
    }
    if (parsed.flags.has("--break-lock")) await breakLocks(ctx, runId);
    lock = await acquireLock(opened.lockStore, ctx.location, runId, `update ${sub}`, clock);
    const continued = fresh ? null : await openRun(ctx, flagValue(parsed, "--run"));
    if (continued !== null) {
      ctx = { ...ctx, journal: continueJournal(ctx, continued), run: { id: continued.runId } };
      await ctx.journal.record(RUN_STEP, "started", opening);
      journaled = true;
    }
    const commands = { ...defaultCommands(), ...options.updateCommands };
    let receipt: PrepareResult["receipt"] | null = null;
    let outcome: UpdateOutcome;
    switch (sub) {
      case "prepare": {
        const result = await commands.prepare(ctx, { fullMedia: parsed.flags.has("--full-media") });
        receipt = result.receipt;
        outcome = result.outcome;
        break;
      }
      case "deploy":
        outcome = await commands.deploy(ctx);
        break;
      case "cleanup":
        outcome = await commands.cleanup(ctx, continued ?? (await openRun(ctx, null)), { dryRun: parsed.flags.has("--dry-run") });
        break;
      default:
        outcome = await commands[sub](ctx, continued ?? (await openRun(ctx, null)));
    }
    if (outcome.message !== "") out.info(outcome.message);
    if (outcome.report.downtimeMs !== null && outcome.report.downtimeMs > 0) out.info(fixedText`downtime ${literal(formatMs(outcome.report.downtimeMs))}`);
    const done = outcome.exitCode === 0 || outcome.exitCode === 3;
    await ctx.journal.finish(done, { exitCode: outcome.exitCode, state: outcome.state }).catch((cause: unknown) => out.warn(fixedText`the end entry of the journal could not be written: ${messageOf(cause)}`));
    emit(schema, { ok: outcome.exitCode === 0, ...outcome, ...(receipt === null ? {} : { receipt }) });
    return outcome.exitCode;
  } catch (error) {
    const opsError = error instanceof OpsError ? error : null;
    const message = messageOf(error);
    out.error(opsError?.element !== undefined && !message.includes(opsError.element) ? fixedText`${opsError.element}: ${message}` : message);
    if (ctx !== null && journaled) await ctx.journal.finish(false, { message }).catch(() => undefined);
    const exitCode = opsError?.exitCode ?? 1;
    const report = ctx !== null && journaled ? await readUpdateRun(ctx, ctx.run.id).then(reportOf).catch(() => null) : null;
    emit(schema, { ok: false, exitCode, message, element: opsError?.element ?? null, runId: ctx?.run.id ?? null, ...(report === null ? {} : { report }) });
    return exitCode;
  } finally {
    await lock?.release().catch(() => undefined);
    opened?.close();
  }
}
