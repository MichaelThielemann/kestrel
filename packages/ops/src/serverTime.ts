import type { OpsContext } from "./context.ts";
import { OpsError } from "./errors.ts";
import { Interrupted } from "./interrupt.ts";
import { keys } from "./layout.ts";
import type { Output } from "./output.ts";
import type { PollOptions } from "./replica.ts";
import type { ObjectStore } from "./store.ts";

/** The store's clock relative to this machine's. */
export interface ServerClock {
  /** Local clock minus server clock, in milliseconds. */
  skewMs: number;
  /** The server's time now, estimated from the local clock and the skew. */
  now: () => number;
}

const warned = new WeakSet<Output>();

/** Warns on `out` that the probe `key` could not be deleted, once per output for every kind of probe. */
export function leftoverProbe(out: Output | undefined, key: string, kind: "clock" | "protection" = "clock"): void {
  if (out === undefined || warned.has(out)) return;
  warned.add(out);
  out.warn(`the ${kind} probe ${key} could not be deleted with the tool's credentials; the ${kind === "clock" ? "measurement" : "result"} holds, and backup prune removes stale probes with credentials that may delete there`);
}

/**
 * Measures the store's clock from the `LastModified` of a freshly written probe below `location`, found by listing (a
 * listing reports milliseconds, a HEAD only seconds) and listed again until it shows up, since a listing may lag
 * behind the write. The probe is deleted afterwards; a delete that fails does not fail the measurement and is warned
 * about on `out` once per output, since `backup prune` removes stale probes. A store with its own `serverTime`
 * measures it that way.
 */
export async function serverClock(store: ObjectStore, location: string, runId: string, clock: () => number, poll: PollOptions = {}, out?: Output): Promise<ServerClock> {
  if (store.serverTime !== undefined) {
    const { skewMs, leftover } = await store.serverTime(location, clock, poll);
    if (leftover !== undefined) leftoverProbe(out, leftover);
    return { skewMs, now: () => clock() - skewMs };
  }
  const key = location + keys.probe(runId);
  const before = clock();
  await store.put(key, new TextEncoder().encode(String(before)), { contentType: "text/plain" });
  const after = clock();
  const sleep = poll.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let measured: ServerClock | null = null;
  try {
    for (let i = 0; i < (poll.attempts ?? 30) && measured === null; i++) {
      const found = (await store.list(key)).find((info) => info.key === key);
      if (found) {
        const skewMs = Math.round((before + after) / 2) - found.lastModified;
        measured = { skewMs, now: () => clock() - skewMs };
      } else await sleep(poll.delayMs ?? 1000);
    }
  } finally {
    await store.delete(key).catch((cause: unknown) => {
      if (cause instanceof Interrupted) throw cause;
      leftoverProbe(out, key);
    });
  }
  if (measured === null) throw new OpsError(`the probe ${key} did not appear in the listing; cannot read the store's clock`, 1, key);
  return measured;
}

/**
 * The clock of the store the replica lives in, which names and orders its generations. The probe goes to the backup
 * location when that shares the app's store, otherwise below the replica prefix, outside the `gen/` keys a runtime
 * reads.
 */
export function appClock(ctx: Pick<OpsContext, "app" | "env" | "location" | "runId" | "clock" | "poll" | "out">): Promise<ServerClock> {
  const location = ctx.env.backups.storage === undefined ? ctx.location : ctx.env.app.replicaPrefix;
  return serverClock(ctx.app, location, ctx.runId, ctx.clock, ctx.poll, ctx.out);
}
