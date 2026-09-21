import { randomUUID } from "node:crypto";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context } from "@michaelthielemann/kestrel/context";
import type { Identity } from "./authn.ts";
import type { EventData } from "./events.ts";

/** What every event a delivery module hands to a pipeline carries, whatever raised it. */
export interface EventIdentity {
  eventId: string;
  event: string;
  at: number;
}

/** What an `events.emit` step puts on the bus or into the queue, and what an event pipeline reads as `payload`. */
export interface EventEnvelope extends EventIdentity {
  runId: string;
  identity: Identity | null;
  params: Record<string, string>;
  id: string | null;
  ids?: string[];
  result?: unknown;
}

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
  const envelope: EventEnvelope = { eventId: randomUUID(), event: name, at: Date.now(), runId: ctx.runId, identity: ctx.identity ?? null, params: ctx.params, id };
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
  for (const [key, value] of Object.entries(data)) if (!(key in identity)) out[key] = value;
  return boundaryCast<EventData & EventIdentity>(out, "json");
}
