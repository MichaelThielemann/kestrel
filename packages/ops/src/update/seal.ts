import { readSeal } from "../backup.ts";
import { runtimeVersion } from "../context.ts";
import { listGenerations, SEALING_MAJOR, type SealReport } from "../replica.ts";
import type { UpdateContext } from "./types.ts";

/**
 * Waits after a stop until the newest replica generation's `sealed.json` shows in a listing, at most
 * `update.sealTimeoutSeconds` after `stoppedAt`, then classifies the stopped replica as `readSeal` does. A runtime the
 * target reports as older than the sealing major writes no seal, so nothing is awaited; an unknown runtime is awaited
 * for the whole timeout. The seal is looked for by listing only, never by reading a key before it exists.
 */
export async function waitForSeal(ctx: UpdateContext, stoppedAt: number): Promise<SealReport> {
  const prefix = ctx.env.app.replicaPrefix;
  const runtime = runtimeVersion(await ctx.target.describe());
  const major = runtime === null ? null : Number(/^(\d+)\./.exec(runtime)?.[1] ?? Number.NaN);
  if (major === null || Number.isNaN(major) || major >= SEALING_MAJOR) {
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
  return readSeal(ctx);
}
