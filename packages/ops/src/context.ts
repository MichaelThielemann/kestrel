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
  readyTimeoutMs: number;
}

/** The replication runtime version a target reports, or null when it cannot tell. */
export function runtimeVersion(facts: TargetFacts): string | null {
  return facts.packages[REPLICATION_PACKAGE] ?? null;
}

/** Stops the target unless it is stopped and checks that it reports stopped with no running instance. */
export async function stopTarget(ctx: OpsContext): Promise<{ stoppedAt: number; wasRunning: boolean }> {
  const before = await ctx.target.status();
  const wasRunning = before.state !== "stopped" || before.instances > 0;
  const stoppedAt = wasRunning ? (await ctx.target.stop()).stoppedAt : ctx.clock();
  const after = await ctx.target.status();
  if (after.state !== "stopped" || after.instances > 0) throw new OpsError(`the target reports ${after.state} with ${after.instances} instance(s) after the stop`, 1, "target");
  await ctx.journal.record("stop", "done", { stoppedAt, wasRunning });
  return { stoppedAt, wasRunning };
}

/** Starts the target and waits for its readiness check. */
export async function startTarget(ctx: OpsContext): Promise<void> {
  await ctx.target.start();
  const ready = await ctx.target.waitReady(ctx.readyTimeoutMs);
  await ctx.journal.record("start", ready ? "done" : "failed", { ready });
  if (!ready) throw new OpsError(`the app did not become ready within ${Math.round(ctx.readyTimeoutMs / 1000)} s`, 1, "target");
}
