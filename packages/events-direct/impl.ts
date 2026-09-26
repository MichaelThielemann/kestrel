import { withEventIdentity } from "@michaelthielemann/kestrel-contracts/helpers/events.envelope";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import type { DeliveryStatus, RelayEntry } from "@michaelthielemann/kestrel-contracts/events.steps";
import type { ContextInput } from "@michaelthielemann/kestrel/context";
import type { EventEntry } from "@michaelthielemann/kestrel/defineModule";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import type { Runner } from "@michaelthielemann/kestrel/runner";

/** The failed deliveries of one process; nothing here retries, so each one is final. */
export interface DeadDeliveries {
  record(): void;
  status(): DeliveryStatus;
}

export function createDeadDeliveries(since: number, now: () => number = Date.now): DeadDeliveries {
  let dead = 0;
  let lastDeadAt: number | null = null;
  return {
    record() {
      dead += 1;
      lastDeadAt = now();
    },
    status() {
      return { dead, scope: "process", since, lastDeadAt };
    },
  };
}

/** One process's record of what its own runs raised: `_events` reads and clears one run's entry. */
export interface RelayReports {
  record(runId: string, entry: RelayEntry): void;
  take(runId: string): RelayEntry[] | undefined;
  sweep(maxAgeMs: number, warn: (count: number) => void): void;
}

export function createRelayReports(now: () => number = Date.now): RelayReports {
  const byRun = new Map<string, { entries: RelayEntry[]; at: number }>();
  return {
    record(runId, entry) {
      const bucket = byRun.get(runId) ?? { entries: [], at: now() };
      bucket.entries.push(entry);
      byRun.set(runId, bucket);
    },
    take(runId) {
      const bucket = byRun.get(runId);
      byRun.delete(runId);
      return bucket?.entries;
    },
    sweep(maxAgeMs, warn) {
      const at = now();
      let dropped = 0;
      for (const [runId, bucket] of byRun) {
        if (at - bucket.at > maxAgeMs) {
          byRun.delete(runId);
          dropped++;
        }
      }
      if (dropped > 0) warn(dropped);
    },
  };
}

/**
 * Subscribes the configured `{ event, pipeline }` entries to the bus and returns the unsubscribe.
 * One bus subscription per distinct event name: `withEventIdentity` runs once per emit, before any
 * subscribed pipeline of that event sees the data, so all of them get the same `eventId`/`event`/`at`
 * rather than each minting its own when the emitter did not supply one.
 */
export function startEventTriggers(events: Events, entries: readonly EventEntry[], run: Runner, logger: Logger, reports?: RelayReports, dead?: DeadDeliveries): () => void {
  const pipelinesByEvent = new Map<string, string[]>();
  for (const entry of entries) {
    const pipelines = pipelinesByEvent.get(entry.event) ?? [];
    pipelines.push(entry.pipeline);
    pipelinesByEvent.set(entry.event, pipelines);
  }
  const offs = [...pipelinesByEvent].map(([event, pipelines]) =>
    events.on(event, async (name, data) => {
      const payload = withEventIdentity(name, data);
      const input: ContextInput = { trigger: { kind: "event", name }, payload };
      const runId = typeof payload.runId === "string" ? payload.runId : undefined;
      if (runId !== undefined) input.parentRunId = runId;
      const thrown: unknown[] = [];
      for (const pipeline of pipelines) {
        try {
          const res = await run(pipeline, input);
          const failed = res.status >= 400;
          if (failed) {
            logger.error(`event "${name}" pipeline "${pipeline}" ended with ${res.status}`, { runId: res.runId, parentRunId: input.parentRunId ?? null, error: res.error, code: res.code, retryable: res.retryable });
            dead?.record();
          }
          if (runId !== undefined) reports?.record(runId, { event: name, pipeline, status: failed ? "error" : "done", attempts: 1, dead: failed, error: failed ? (res.error ?? res.code ?? `status ${res.status}`) : null });
        } catch (error) {
          logger.error(`event "${name}" pipeline "${pipeline}" threw`, { error });
          dead?.record();
          if (runId !== undefined) reports?.record(runId, { event: name, pipeline, status: "error", attempts: 1, dead: true, error: error instanceof Error ? error.message : String(error) });
          thrown.push(error);
        }
      }
      if (thrown.length > 0) throw thrown.length === 1 ? thrown[0] : new AggregateError(thrown, `events/direct: ${thrown.length} pipeline(s) threw for "${name}"`);
    }),
  );
  return () => {
    for (const off of offs) off();
  };
}
