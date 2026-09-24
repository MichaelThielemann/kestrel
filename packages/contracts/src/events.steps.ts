import type { JsonSchema } from "@michaelthielemann/kestrel/defineModule";
import { defineStepSet } from "./stepSet.ts";

/** Every event delivery module registers these steps; the bus module `events/inmemory` registers none. */
export const EVENT_DELIVERY_STEPS = defineStepSet({ id: "events.delivery", prefix: "events", steps: ["events.emit", "events.relay", "events.readDeliveryStatus"] });

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
