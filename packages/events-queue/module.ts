import { randomUUID } from "node:crypto";
import { z } from "zod";
import "@michaelthielemann/kestrel-contracts/authn";
import { EVENTS } from "@michaelthielemann/kestrel-contracts/events";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { first, stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule, type JsonSchema } from "@michaelthielemann/kestrel/defineModule";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createEventsQueue, persistenceFailure, retryTarget, type EventsQueue } from "./impl.ts";
import { startEventTriggers } from "./triggers.ts";

export const configSchema = z
  .object({
    pollMs: z.number().int().positive().default(500),
    batch: z.number().int().positive().default(20),
    maxAttempts: z.number().int().positive().default(5),
    backoffSeconds: z.array(z.number().int().nonnegative()).min(1).default([5, 30, 120, 600]),
    lockTtlSeconds: z.number().int().positive().default(300),
    retentionDays: z.number().int().positive().default(7),
  })
  .strict();

const NULLABLE_NUMBER: JsonSchema = { type: ["number", "null"] };
export const STATUS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    pending: { type: "number" },
    running: { type: "number" },
    dead: { type: "number" },
    done24h: { type: "number" },
    oldestPendingAt: NULLABLE_NUMBER,
    worker: { type: "object", properties: { running: { type: "boolean" }, lastTickAt: NULLABLE_NUMBER }, required: ["running", "lastTickAt"] },
  },
  required: ["pending", "running", "dead", "done24h", "oldestPendingAt", "worker"],
};
export const DEAD_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, attempts: { type: "number" }, error: { type: "string" }, createdAt: { type: "number" }, availableAt: { type: "number" } }, required: ["id", "name", "attempts", "error", "createdAt", "availableAt"] },
    },
  },
  required: ["items"],
};
const COUNT = (key: string): JsonSchema => ({ type: "object", properties: { [key]: { type: "number" } }, required: [key] });
const DEFAULT_DEAD_LIMIT = 50;
const MAX_DEAD_LIMIT = 500;

type Instance = EventsQueue & { logger: Logger };

export default defineModule({
  name: "events/queue",
  provides: [EVENTS],
  requires: [PERSISTENCE],
  configSchema,

  async setup(config, deps): Promise<Instance> {
    return { ...(await createEventsQueue(config, { db: deps.get(PERSISTENCE), logger: deps.logger })), logger: deps.logger };
  },

  triggers: {
    event: (events, entries, run, logger) => {
      const off = startEventTriggers(events, entries, run, logger);
      events.startWorker();
      return () => {
        off();
        void events.stopWorker();
      };
    },
  },

  teardown: (events) => events.stopWorker(),

  steps: (events) => ({
    emit: stepFactory((spec: string) => async (ctx: Context) => {
      const questionMark = spec.indexOf("?");
      const name = questionMark === -1 ? spec : spec.slice(0, questionMark);
      const withResult = questionMark !== -1 && new URLSearchParams(spec.slice(questionMark + 1)).get("with") === "result";
      const result = ctx.result as { id?: unknown; document?: { id?: unknown }; ids?: unknown } | undefined;
      const id = typeof result?.id === "string" ? result.id : typeof result?.document?.id === "string" ? result.document.id : typeof ctx.params.id === "string" ? ctx.params.id : null;
      const envelope: Record<string, unknown> = { eventId: randomUUID(), event: name, at: Date.now(), runId: ctx.runId, identity: ctx.identity ?? null, params: ctx.params, id };
      if (Array.isArray(result?.ids) && result.ids.every((v): v is string => typeof v === "string")) envelope.ids = result.ids;
      if (withResult) envelope.result = ctx.result ?? null;
      try {
        await events.emit(name, envelope);
      } catch (error) {
        const failure = persistenceFailure(error);
        if (failure) return ctx.fail(failure);
        events.logger.error("events/queue: emit failed", { event: name, error });
      }
      return ok(ctx);
    }),
    readQueueStatus: async (ctx: Context) => {
      const status = await events.status();
      if (isErr(status)) return ctx.fail(status.error);
      return ok({ ...ctx, result: status.value });
    },
    listDead: async (ctx: Context) => {
      const raw = first(ctx.payload.limit) ?? (typeof ctx.payload.limit === "number" ? String(ctx.payload.limit) : undefined);
      const limit = raw === undefined ? DEFAULT_DEAD_LIMIT : Math.min(MAX_DEAD_LIMIT, Number(raw));
      const listed = await events.listDead(limit);
      if (isErr(listed)) return ctx.fail(listed.error);
      return ok({ ...ctx, result: listed.value });
    },
    retryDead: stepFactory((arg: string) => {
      const target = retryTarget(arg);
      return async (ctx: Context) => {
        if (target === "one" && !ctx.params.id) return ctx.fail("VALIDATION", "missing id");
        const retried = await events.retryDead(target === "all" ? "all" : (ctx.params.id as string));
        if (isErr(retried)) return ctx.fail(retried.error);
        if (target === "one" && retried.value.retried === 0) return ctx.fail("NOT_FOUND", `no dead event "${ctx.params.id ?? ""}"`);
        return ok({ ...ctx, result: retried.value });
      };
    }),
    purgeDone: async (ctx: Context) => {
      const removed = await events.purgeDone();
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok({ ...ctx, result: removed.value });
    },
  }),

  describe: () => ({
    emit: (spec: string) => ({ summary: `Queue event "${spec}" for the subscribed handler pipelines; the worker delivers it after this run`, reads: [], writes: [], errors: { 503: "the event could not be persisted" } }),
    readQueueStatus: { summary: "Queue counters per state, the oldest pending event and the worker state of this process", reads: [], writes: ["result"], output: STATUS_SCHEMA },
    listDead: { summary: "Dead-letter events, most recently failed first", reads: [], writes: ["result"], query: { limit: { type: "integer", minimum: 1, maximum: MAX_DEAD_LIMIT } }, output: DEAD_SCHEMA },
    retryDead: (arg: string) => ({ summary: arg === "one" ? "Requeue the dead-letter event named by params.id" : "Requeue every dead-letter event", reads: arg === "one" ? ["params.id"] : [], writes: ["result"], output: COUNT("retried"), ...(arg === "one" ? { errors: { 400: "missing id", 404: "no dead event with that id" } } : {}) }),
    purgeDone: { summary: "Delete delivered events older than retentionDays", reads: [], writes: ["result"], output: COUNT("removed") },
  }),
});
