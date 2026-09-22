import type { JsonSchema } from "@michaelthielemann/kestrel/defineModule";
import { defineStepSet } from "./stepSet.ts";

/** Every event delivery module registers these steps; the bus module `events/inmemory` registers none. */
export const EVENT_DELIVERY_STEPS = defineStepSet({ id: "events.delivery", prefix: "events", steps: ["events.emit", "events.relay"] });

const RELAY_STATUS: JsonSchema = { type: "string", enum: ["done", "error", "pending"] };

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
  status: "done" | "error" | "pending";
  attempts: number;
  dead: boolean;
  error: string | null;
}

export interface RelayReport {
  status: "done" | "error" | "pending";
  pipelines: RelayEntry[];
}

/** Folds per-pipeline statuses into the summary: `error` beats `pending` beats `done`. */
export function relaySummary(pipelines: readonly RelayEntry[]): RelayReport["status"] {
  if (pipelines.some((p) => p.status === "error")) return "error";
  if (pipelines.some((p) => p.status === "pending")) return "pending";
  return "done";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges `_events` into a result: creates an object when `result` is `undefined`, merges into an
 * existing record. A defined non-object result is a wiring error, the same way `authz.describeAccess`
 * treats it.
 */
export function mergeRelayReport(result: unknown, report: RelayReport, moduleName: string): unknown {
  if (result === undefined) return { _events: report };
  if (isRecord(result)) return { ...result, _events: report };
  throw new Error(`${moduleName}: cannot add _events to a non-object result`);
}
