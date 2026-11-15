import { readSeal } from "../backup.ts";
import { listGenerations, SEALING_MAJOR, type SealReport } from "../replica.ts";
import { reportedVersions, runtimeOf } from "./plan.ts";
import type { UpdateContext } from "./types.ts";

/**
 * Waits after a stop until the newest replica generation's `sealed.json` shows in a listing, at most
 * `update.sealTimeoutSeconds` after `stoppedAt`, then classifies the stopped replica as `readSeal` does. The
 * replication runtime is the one `running` names (the running versions the run knows), else the one the target reports
 * outside the release's own installation ({@link reportedVersions}); when neither names it, `convertsFrom`, the major
 * the pending storage migrations convert from, stands for its major. A runtime older than the sealing major writes no
 * seal, so nothing is awaited and the `unsealed-stop` question follows at once, and a replica without a seal counts as
 * unsupported; an unknown runtime is awaited for the whole timeout, after one warning that names how to make it known.
 * The seal is looked for by listing only, never by reading a key before it exists.
 */
export async function waitForSeal(ctx: UpdateContext, stoppedAt: number, running: Readonly<Record<string, string>> | null = null, convertsFrom: number | null = null): Promise<SealReport> {
  const prefix = ctx.env.app.replicaPrefix;
  const runtime = runtimeOf(running) ?? runtimeOf(await reportedVersions(ctx));
  const major = runtime === null ? convertsFrom : Number(/^(\d+)\./.exec(runtime)?.[1] ?? Number.NaN);
  const before = major !== null && !Number.isNaN(major) && major < SEALING_MAJOR;
  if (!before) {
    if (runtime === null) ctx.out.warn(`the running replication runtime version is unknown: the run names none, and the target reports none outside the release's own installation; the stop waits up to ${ctx.update.sealTimeoutSeconds} s for a seal, which a runtime before ${SEALING_MAJOR} never writes; to name it, point the target's dir at an installation of the running release before update prepare, or lower update.sealTimeoutSeconds for this one deploy`);
    const sleep = ctx.poll.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const deadline = stoppedAt + ctx.update.sealTimeoutSeconds * 1000;
    const delay = ctx.poll.delayMs ?? 1000;
    const attempts = Math.ceil((ctx.update.sealTimeoutSeconds * 1000) / Math.max(1, delay)) + 1;
    for (let i = 0; i < attempts; i++) {
      const newest = (await listGenerations(ctx.app, prefix)).at(-1);
      if (newest?.files["sealed.json"] !== undefined) break;
      if (ctx.clock() >= deadline) break;
      await sleep(delay);
    }
  }
  const seal = await readSeal(ctx, runtime);
  return before && seal.state === "unknown" ? { ...seal, state: "unsupported" } : seal;
}
