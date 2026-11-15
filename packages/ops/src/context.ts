import type { Environment } from "./environments.ts";
import { OpsError } from "./errors.ts";
import type { Journal } from "./journal.ts";
import type { Output } from "./output.ts";
import type { AnswerSource } from "./questions.ts";
import type { Redactor } from "./redact.ts";
import type { PollOptions } from "./replica.ts";
import type { ObjectStore } from "./store.ts";
import type { Target, TargetFacts } from "./target.ts";
import type { Workspace } from "./workspace.ts";

/** The package whose version decides whether a replica is sealed at teardown. */
export const REPLICATION_PACKAGE = "@michaelthielemann/kestrel-replication-sqlite";

/** Everything a backup, restore or status run works with. */
export interface OpsContext {
  envName: string;
  env: Environment;
  /** The app's bucket, reached with the tool's own credentials. */
  app: ObjectStore;
  /** The bucket of the backup location (often the app's), with the tool's credentials. */
  backups: ObjectStore;
  /** The backup location's prefix in {@link OpsContext.backups}. */
  location: string;
  target: Target;
  out: Output;
  answers: AnswerSource;
  clock: () => number;
  redactor: Redactor;
  workspace: Workspace;
  runId: string;
  journal: Journal;
  tool: { name: string; version: string };
  /** Versions of the project's packages and the lockfile hash, recorded in each manifest. */
  project: { versions: Record<string, string>; lockfileSha256: string | null };
  poll: PollOptions;
  /** How long a start waits for the app's readiness check: `update.readyTimeoutSeconds` of the environment. */
  readyTimeoutMs: number;
  /** How long after the start a restore waits for the first generation of an app whose runtime names it by its own clock. */
  generationWaitMs: number;
}

/** The replication runtime version a target reports, or null when it cannot tell. */
export function runtimeVersion(facts: TargetFacts): string | null {
  return facts.packages[REPLICATION_PACKAGE] ?? null;
}

async function startAgain(ctx: OpsContext): Promise<void> {
  const now = await ctx.target.status().catch(() => null);
  if (now?.state === "started") {
    ctx.out.error("the stop failed and the app still runs");
    return;
  }
  ctx.out.error(now === null ? "the state of the app cannot be read after the stop; starting it again" : "the app was stopped; starting it again");
  await startTarget(ctx).catch((cause: unknown) => ctx.out.error(`starting the app again failed: ${messageOf(cause)}`));
}

/**
 * Stops the target unless it is stopped and checks that it reports stopped with no running instance. When the stop
 * itself, that check or its journal entry fails, it starts a target it was asked to stop again unless the target
 * reports it still runs.
 */
export async function stopTarget(ctx: OpsContext): Promise<{ stoppedAt: number; wasRunning: boolean }> {
  const before = await ctx.target.status();
  const wasRunning = before.state !== "stopped" || before.instances > 0;
  try {
    const stoppedAt = wasRunning ? (await ctx.target.stop()).stoppedAt : ctx.clock();
    const after = await ctx.target.status();
    if (after.state !== "stopped" || after.instances > 0) throw new OpsError(`the target reports ${after.state} with ${after.instances} instance(s) after the stop`, 1, "target");
    await ctx.journal.record("stop", "done", { stoppedAt, wasRunning });
    return { stoppedAt, wasRunning };
  } catch (error) {
    if (wasRunning) await startAgain(ctx);
    throw error;
  }
}

/** The message of a caught value. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Records a journal entry, reporting a failure to write it as a warning instead of failing the step it describes. */
export async function recordQuietly(ctx: OpsContext, step: string, state: "done" | "failed", data: Record<string, unknown>): Promise<void> {
  await ctx.journal.record(step, state, data).catch((cause: unknown) => ctx.out.warn(`the journal entry ${step}-${state} could not be written: ${messageOf(cause)}`));
}

/** Starts the target and waits for its readiness check; `started` is called once the start resolved, before the wait. */
export async function startTarget(ctx: OpsContext, started?: () => void): Promise<void> {
  await ctx.target.start();
  started?.();
  const ready = await ctx.target.waitReady(ctx.readyTimeoutMs);
  await recordQuietly(ctx, "start", ready ? "done" : "failed", { ready });
  if (!ready) throw new OpsError(`the app did not become ready within ${Math.round(ctx.readyTimeoutMs / 1000)} s`, 1, "target");
}
