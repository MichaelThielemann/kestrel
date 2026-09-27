import { randomUUID } from "node:crypto";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context } from "@michaelthielemann/kestrel/context";
import type { EventEnvelope, EventIdentity, RelayEntry, RelayReport } from "../events.steps.ts";
import type { EventData } from "../events.ts";

/** Splits an `events.emit` step argument into the event name and whether `?with=result` (or any alias of it) enables carrying the result. */
export function parseEmitSpec(spec: string): { name: string; withResult: boolean } {
  const questionMark = spec.indexOf("?");
  const name = questionMark === -1 ? spec : spec.slice(0, questionMark);
  const withResult = questionMark !== -1 && new URLSearchParams(spec.slice(questionMark + 1)).get("with") === "result";
  return { name, withResult };
}

interface ResultShape {
  id?: unknown;
  document?: { id?: unknown };
  ids?: unknown;
}

/** Builds the envelope both delivery modules' `events.emit` step produces for a given pipeline context. */
export function eventEnvelope(spec: string, ctx: Context): { name: string; envelope: EventEnvelope } {
  const { name, withResult } = parseEmitSpec(spec);
  const result = boundaryCast<ResultShape | undefined>(ctx.result, "json");
  const id = typeof result?.id === "string" ? result.id : typeof result?.document?.id === "string" ? result.document.id : typeof ctx.params.id === "string" ? ctx.params.id : null;
  const envelope: EventEnvelope = { eventId: randomUUID(), event: name, at: Date.now(), runId: ctx.runId, identity: ctx.identity ?? null, params: ctx.params, id, ip: ctx.ip ?? null };
  if (Array.isArray(result?.ids) && result.ids.every((v): v is string => typeof v === "string")) envelope.ids = result.ids;
  if (withResult) envelope.result = ctx.result ?? null;
  return { name, envelope };
}

/**
 * Guarantees `eventId`, `event` and `at` on data raised through `events@1`. Values the emitter supplied for
 * those three keys are kept; missing ones are filled. Every other field of `data` keeps its name, its value
 * and its meaning.
 */
export function withEventIdentity(event: string, data: EventData): EventData & EventIdentity {
  const identity: EventIdentity = {
    eventId: typeof data.eventId === "string" ? data.eventId : randomUUID(),
    event: typeof data.event === "string" ? data.event : event,
    at: typeof data.at === "number" ? data.at : Date.now(),
  };
  if (data.eventId === identity.eventId && data.event === identity.event && data.at === identity.at) {
    return boundaryCast<EventData & EventIdentity>(data, "json");
  }
  const out: Record<string, unknown> = { ...identity };
  for (const [key, value] of Object.entries(data)) if (!Object.hasOwn(identity, key)) out[key] = value;
  return boundaryCast<EventData & EventIdentity>(out, "json");
}

/** Folds per-pipeline statuses into the summary: `error` beats `pending`/`queued` beats `done`. */
export function relaySummary(pipelines: readonly RelayEntry[]): RelayReport["status"] {
  if (pipelines.some((p) => p.status === "error")) return "error";
  if (pipelines.some((p) => p.status === "pending" || p.status === "queued")) return "pending";
  return "done";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges `_events` into a result: creates an object when `result` is `undefined`, merges into an
 * existing record. A defined non-object result is a wiring error, the same way `authz.listRoles`
 * treats it.
 */
export function mergeRelayReport(result: unknown, report: RelayReport, moduleName: string): unknown {
  if (result === undefined) return { _events: report };
  if (isRecord(result)) return { ...result, _events: report };
  throw new Error(`${moduleName}: cannot add _events to a non-object result`);
}
