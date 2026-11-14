import { listBackups, type BackupSummary } from "./backup.ts";
import { runtimeVersion, type OpsContext } from "./context.ts";
import { environmentProblems } from "./environments.ts";
import { listRuns, openRuns, type RunSummary } from "./journal.ts";
import { keys } from "./layout.ts";
import { heldLocks, type HeldLock } from "./lock.ts";
import { listGenerations } from "./replica.ts";
import { appClock } from "./serverTime.ts";
import type { ObjectStore } from "./store.ts";
import type { TargetFacts, TargetStatus } from "./target.ts";

/** Whether the app's own credentials can delete in the backup location: `yes` means they cannot. */
export type Protection = "yes" | "no" | "unknown";

/** What `status` reports. */
export interface StatusReport {
  env: string;
  target: TargetStatus & { facts: TargetFacts };
  replica: { generations: number; newest: string | null; lastFrameAt: number | null; sealed: boolean; runtime: string | null };
  backups: BackupSummary[];
  openRuns: RunSummary[];
  locks: HeldLock[];
  clockSkewMs: number;
  protectedFromApp: Protection;
  problems: string[];
}

const isAccessDenied = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false;
  const name: unknown = Reflect.get(cause, "name");
  const meta: unknown = Reflect.get(cause, "$metadata");
  const status: unknown = typeof meta === "object" && meta !== null ? Reflect.get(meta, "httpStatusCode") : undefined;
  return name === "AccessDenied" || status === 403;
};

/** Writes a probe with the tool's credentials and tries to delete it with the app's: only an access-denied answer proves the backups are out of the app's reach. */
export async function probeProtection(tool: ObjectStore, app: ObjectStore | null, location: string, runId: string): Promise<Protection> {
  if (app === null) return "unknown";
  const key = location + keys.probe(runId);
  await tool.put(key, new TextEncoder().encode("probe"), { contentType: "text/plain" });
  try {
    await app.delete(key);
    return (await tool.head(key)) === null ? "no" : "unknown";
  } catch (cause) {
    return isAccessDenied(cause) ? "yes" : "unknown";
  } finally {
    await tool.delete(key);
  }
}

/** Reads the state of an environment without changing anything but short-lived probe objects. */
export async function status(ctx: OpsContext, appCredentialStore: ObjectStore | null): Promise<StatusReport> {
  const now = ctx.clock();
  const facts = await ctx.target.describe();
  const targetStatus = await ctx.target.status();
  const gens = await listGenerations(ctx.app, ctx.env.app.replicaPrefix);
  const newest = gens.at(-1) ?? null;
  const clock = await appClock(ctx);
  const problems = environmentProblems(ctx.env);
  const protectedFromApp = await probeProtection(ctx.backups, appCredentialStore, ctx.location, ctx.runId);
  if (protectedFromApp === "no") problems.push("the app's credentials can delete backups");
  if (targetStatus.instances > 1) problems.push(`the target runs ${targetStatus.instances} instances; backup and restore need exactly one writer`);
  return {
    env: ctx.envName,
    target: { ...targetStatus, facts },
    replica: { generations: gens.length, newest: newest?.name ?? null, lastFrameAt: newest?.lastFrameAt ?? null, sealed: newest?.files["sealed.json"] !== undefined, runtime: runtimeVersion(facts) },
    backups: await listBackups(ctx),
    openRuns: openRuns(await listRuns(ctx.backups, ctx.location), now).filter((r) => r.runId !== ctx.runId),
    locks: (await heldLocks(ctx.backups, ctx.location, now)).filter((l) => l.runId !== ctx.runId),
    clockSkewMs: clock.skewMs,
    protectedFromApp,
    problems,
  };
}
