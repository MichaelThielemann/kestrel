import { z } from "zod";
import "@michaelthielemann/kestrel-contracts/authn";
import { EVENTS } from "@michaelthielemann/kestrel-contracts/events";
import { eventEnvelope, mergeRelayReport } from "@michaelthielemann/kestrel-contracts/helpers/events.envelope";
import { withEventIdentity } from "@michaelthielemann/kestrel-contracts/helpers/events.envelope";
import { DELIVERY_STATUS_SCHEMA, RELAY_SCHEMA } from "@michaelthielemann/kestrel-contracts/events.steps";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { first, stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule, type JsonSchema } from "@michaelthielemann/kestrel/defineModule";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import type { Runner } from "@michaelthielemann/kestrel/runner";
import type { Unsubscribe } from "@michaelthielemann/kestrel-contracts/events";
import { createEventsQueue, MAIN_LANE, persistenceFailure, retryTarget, type EventsQueue } from "./impl.ts";

export const configSchema = z
  .object({
    pollMs: z.number().int().positive().default(500),
    batch: z.number().int().positive().default(20),
    maxAttempts: z.number().int().positive().default(5),
    backoffSeconds: z.array(z.number().int().nonnegative()).min(1).default([5, 30, 120, 600]),
    lockTtlSeconds: z.number().int().positive().default(300),
    retentionDays: z.number().int().positive().default(7),
    relayMs: z.number().int().nonnegative().default(5000),
    relayPipelines: z.union([z.literal("all"), z.array(z.string())]).default("all"),
    lanes: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.array(z.string())).default({}),
    delayMs: z.record(z.string(), z.number().int().nonnegative()).default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (MAIN_LANE in config.lanes) {
      ctx.addIssue({ code: "custom", path: ["lanes", MAIN_LANE], message: `lane name "${MAIN_LANE}" is reserved for the pipelines no lane names` });
    }
  });

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
    lanes: { type: "object", additionalProperties: { type: "object", properties: { pending: { type: "number" }, running: { type: "number" }, oldestPendingAt: NULLABLE_NUMBER }, required: ["pending", "running", "oldestPendingAt"] } },
  },
  required: ["pending", "running", "dead", "done24h", "oldestPendingAt", "worker", "lanes"],
};
export const DEAD_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, pipeline: { type: "string" }, attempts: { type: "number" }, error: { type: "string" }, createdAt: { type: "number" }, availableAt: { type: "number" }, runId: { type: "string" } }, required: ["id", "name", "pipeline", "attempts", "error", "createdAt", "availableAt", "runId"] },
    },
  },
  required: ["items"],
};
const COUNT = (key: string): JsonSchema => ({ type: "object", properties: { [key]: { type: "number" } }, required: [key] });
const DEFAULT_DEAD_LIMIT = 50;
const MAX_DEAD_LIMIT = 500;
const NO_SUBSCRIBER_RUN: Runner = () => Promise.reject(new Error("events/queue: no pipeline is subscribed to any event"));

type Instance = EventsQueue & { offs: Unsubscribe[]; logger: Logger; relayPipelines: string[] | "all"; lanes: Record<string, string[]>; delayMs: Record<string, number> };

export default defineModule({
  name: "events/queue",
  provides: [],
  requires: [PERSISTENCE, EVENTS],
  configSchema,

  async setup(config, deps): Promise<Instance> {
    const bus = deps.get(EVENTS);
    const queue = await createEventsQueue(config, { db: deps.get(PERSISTENCE), logger: deps.logger });
    const names = [...new Set(deps.eventTriggers.map((entry) => entry.event))];
    if (names.length === 0) queue.setDelivery([], NO_SUBSCRIBER_RUN);
    const offs = names.map((name) =>
      bus.on(name, async (event, data) => {
        await queue.enqueue(event, withEventIdentity(event, data));
      }),
    );
    return { ...queue, offs, logger: deps.logger, relayPipelines: config.relayPipelines, lanes: config.lanes, delayMs: config.delayMs };
  },

  triggers: {
    event: (instance, entries, run) => {
      instance.setDelivery(entries, run);
      instance.startWorker();
      return () => {};
    },
  },

  attach: (instance, kestrel) => {
    const manifest = kestrel.describe();
    const known = new Set(manifest.pipelines.map((p) => p.name));
    const eventRun = new Set(manifest.triggers.events.map((entry) => entry.pipeline));
    if (instance.relayPipelines !== "all") {
      const unknown = instance.relayPipelines.filter((name) => !known.has(name));
      if (unknown.length > 0) throw new Error(`events/queue: relayPipelines names unknown pipeline(s): ${unknown.join(", ")}`);
      const untriggered = instance.relayPipelines.filter((name) => !eventRun.has(name));
      if (untriggered.length > 0) throw new Error(`events/queue: relayPipelines names pipeline(s) no event trigger runs, so the queue never delivers to them: ${untriggered.join(", ")}`);
    }
    const laneOfPipeline = new Map<string, string>();
    for (const [lane, pipelines] of Object.entries(instance.lanes)) {
      for (const pipeline of pipelines) {
        if (!known.has(pipeline)) throw new Error(`events/queue: lane "${lane}" names unknown pipeline "${pipeline}"`);
        if (!eventRun.has(pipeline)) throw new Error(`events/queue: lane "${lane}" names pipeline "${pipeline}", which no event trigger runs, so the queue never delivers to it`);
        const already = laneOfPipeline.get(pipeline);
        if (already !== undefined) throw new Error(`events/queue: pipeline "${pipeline}" is in two lanes: "${already}" and "${lane}"`);
        laneOfPipeline.set(pipeline, lane);
        if (instance.relayPipelines !== "all" && instance.relayPipelines.includes(pipeline)) {
          throw new Error(`events/queue: pipeline "${pipeline}" is in lane "${lane}" and in relayPipelines`);
        }
      }
    }
    const delayed = Object.keys(instance.delayMs);
    const unknownDelayed = delayed.filter((name) => !known.has(name));
    if (unknownDelayed.length > 0) throw new Error(`events/queue: delayMs names unknown pipeline(s): ${unknownDelayed.join(", ")}`);
    const untriggeredDelayed = delayed.filter((name) => !eventRun.has(name));
    if (untriggeredDelayed.length > 0) throw new Error(`events/queue: delayMs names pipeline(s) no event trigger runs, so the queue never delivers to them: ${untriggeredDelayed.join(", ")}`);
    if (instance.relayPipelines !== "all") {
      const relayedAndDelayed = instance.relayPipelines.filter((name) => (instance.delayMs[name] ?? 0) > 0);
      if (relayedAndDelayed.length > 0) throw new Error(`events/queue: pipeline(s) ${relayedAndDelayed.map((name) => `"${name}"`).join(", ")} have a delay in delayMs and are named in relayPipelines; a delayed pipeline is never relayed`);
    }
  },

  teardown: async (instance) => {
    for (const off of instance.offs) off();
    await instance.stopWorker();
  },

  steps: (queue) => ({
    emit: stepFactory((spec: string) => async (ctx: Context) => {
      const { name, envelope } = eventEnvelope(spec, ctx);
      try {
        await queue.enqueue(name, { ...envelope });
      } catch (error) {
        const failure = persistenceFailure(error);
        if (!failure) throw error;
        return ctx.fail(failure);
      }
      return ok(ctx);
    }),
    readQueueStatus: async (ctx: Context) => {
      const status = await queue.status();
      if (isErr(status)) return ctx.fail(status.error);
      return ok({ ...ctx, result: status.value });
    },
    readDeliveryStatus: async (ctx: Context) => {
      const status = await queue.deliveryStatus();
      if (isErr(status)) return ctx.fail(status.error);
      return ok({ ...ctx, result: status.value });
    },
    listDead: async (ctx: Context) => {
      const raw = first(ctx.payload.limit) ?? (typeof ctx.payload.limit === "number" ? String(ctx.payload.limit) : undefined);
      const limit = raw === undefined ? DEFAULT_DEAD_LIMIT : Math.min(MAX_DEAD_LIMIT, Number(raw));
      const listed = await queue.listDead(limit);
      if (isErr(listed)) return ctx.fail(listed.error);
      return ok({ ...ctx, result: listed.value });
    },
    retryDead: stepFactory((arg: string) => {
      const target = retryTarget(arg);
      return async (ctx: Context) => {
        if (target === "all") {
          const retried = await queue.retryDead("all");
          if (isErr(retried)) return ctx.fail(retried.error);
          return ok({ ...ctx, result: retried.value });
        }
        if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
        const retried = await queue.retryDead(ctx.params.id);
        if (isErr(retried)) return ctx.fail(retried.error);
        if (retried.value.retried === 0) return ctx.fail("NOT_FOUND", `no dead event "${ctx.params.id}"`);
        return ok({ ...ctx, result: retried.value });
      };
    }),
    purgeDone: async (ctx: Context) => {
      const removed = await queue.purgeDone();
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok({ ...ctx, result: removed.value });
    },
    relay: async (ctx: Context) => {
      const report = await queue.relay(ctx.runId);
      return ok({ ...ctx, result: mergeRelayReport(ctx.result, report, "events/queue") });
    },
  }),

  describe: () => ({
    emit: (spec: string) => ({ summary: `Queue event "${spec}" for the subscribed handler pipelines; the worker delivers it after this run`, reads: [], writes: [], errors: { 503: "the event could not be persisted" }, atomicSafe: true }),
    readQueueStatus: { summary: "Queue counters per state, the oldest pending event, the worker state of this process, and pending/running/oldestPendingAt per configured lane", reads: [], writes: ["result"], output: STATUS_SCHEMA, atomicSafe: true },
    readDeliveryStatus: { summary: "Dead-letter rows of the queue across every process: deliveries that used up maxAttempts and wait for events.retryDead", reads: [], writes: ["result"], output: DELIVERY_STATUS_SCHEMA, errors: { 503: "the queue could not be read" }, atomicSafe: true },
    listDead: { summary: "Dead-letter events, most recently failed first", reads: [], writes: ["result"], query: { limit: { type: "integer", minimum: 1, maximum: MAX_DEAD_LIMIT } }, output: DEAD_SCHEMA, atomicSafe: true },
    retryDead: (arg: string) =>
      arg === "one"
        ? { summary: "Requeue the dead-letter event named by params.id", reads: ["params.id"], writes: ["result"], output: COUNT("retried"), errors: { 400: "missing id", 404: "no dead event with that id" }, atomicSafe: true }
        : { summary: "Requeue every dead-letter event", reads: [], writes: ["result"], output: COUNT("retried"), atomicSafe: true },
    purgeDone: { summary: "Delete delivered events older than retentionDays", reads: [], writes: ["result"], output: COUNT("removed"), atomicSafe: true },
    relay: {
      summary: "Deliver the events this run queued, before the response; whatever is left over stays for the worker (adds `_events` to the result)",
      reads: [],
      writes: ["result._events"],
      extendsOutput: RELAY_SCHEMA,
    },
  }),
});
