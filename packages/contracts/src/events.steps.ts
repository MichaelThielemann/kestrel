import type { Identity } from "./authn.ts";
import type { JsonSchema } from "@michaelthielemann/kestrel/defineModule";
import { defineStepSet } from "./helpers/stepSet.ts";

/** Every event delivery module registers these steps; the bus module `events/inmemory` registers none. */
export const EVENT_DELIVERY_STEPS = defineStepSet({ id: "events.delivery", prefix: "events", steps: ["events.emit", "events.relay", "events.readDeliveryStatus"] });

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
  /** The client address of the run that emitted the event, `null` when it had none. */
  ip?: string | null;
}

/** What `events.readDeliveryStatus` answers: the deliveries this module gave up on. */
export interface DeliveryStatus {
  /** Deliveries that failed and that the module does not retry on its own. */
  dead: number;
  /**
   * `store`: counted over the module's stored rows, the same whichever process answers, lowered by a retry.
   * `process`: counted in the process that answers, since `since`; another process of the same site has its
   * own count, and a restart starts at 0.
   */
  scope: "store" | "process";
  /** Where a `process` count starts; `null` for `store`. */
  since: number | null;
  /** When the newest counted delivery failed; `null` when `dead` is 0. */
  lastDeadAt: number | null;
}

export const DELIVERY_STATUS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    dead: { type: "integer", minimum: 0 },
    scope: { type: "string", enum: ["store", "process"] },
    since: { type: ["number", "null"] },
    lastDeadAt: { type: ["number", "null"] },
  },
  required: ["dead", "scope", "since", "lastDeadAt"],
};

const RELAY_STATUS: JsonSchema = { type: "string", enum: ["done", "error", "pending", "queued"] };

/** The `_events` member `events.relay` adds to a result: the outcome of every pipeline the emitting run raised. */
export const RELAY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    _events: {
      type: "object",
      properties: {
        status: RELAY_STATUS,
        pipelines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              event: { type: "string" },
              pipeline: { type: "string" },
              status: RELAY_STATUS,
              attempts: { type: "integer" },
              dead: { type: "boolean" },
              error: { type: ["string", "null"] },
            },
            required: ["event", "pipeline", "status", "attempts", "dead", "error"],
          },
        },
      },
      required: ["status", "pipelines"],
    },
  },
  required: ["_events"],
};

export interface RelayEntry {
  event: string;
  pipeline: string;
  /** `queued` names a pipeline the relay never attempted, left to the worker from the start. */
  status: "done" | "error" | "pending" | "queued";
  attempts: number;
  dead: boolean;
  error: string | null;
}

export interface RelayReport {
  status: "done" | "error" | "pending";
  pipelines: RelayEntry[];
}
