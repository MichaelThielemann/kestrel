import { z } from "zod";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { createAuditPersistence, DEFAULT_FAILED_STEPS, entryFromEventData, securityThrottle, securityEntry, type Audit } from "./impl.ts";

export const configSchema = z
  .object({
    retentionDays: z.number().int().positive().optional().describe("How long an entry is kept; without it `audit.prune` has no rule to apply and fails"),
    securityEvents: z.boolean().default(true).describe("Record failed sign-ins and password checks, 403 and 429 answers of HTTP runs as entries"),
    failedSteps: z.array(z.string().min(1)).default([...DEFAULT_FAILED_STEPS]).describe("The steps whose failure is recorded as `auth.failed`"),
  })
  .strict();

type Instance = Audit & { retentionDays?: number; securityEvents: boolean; failedSteps: readonly string[]; logger: Logger };

function userIdOf(ctx: Context): string | null {
  if (ctx.params.id !== undefined) return ctx.params.id;
  return typeof ctx.payload.id === "string" ? ctx.payload.id : null;
}

export default defineModule({
  name: "audit/persistence",
  provides: [],
  requires: [PERSISTENCE],
  configSchema,

  async setup(config, deps): Promise<Instance> {
    const audit = await createAuditPersistence(deps.get(PERSISTENCE));
    return { ...audit, securityEvents: config.securityEvents, failedSteps: config.failedSteps, logger: deps.logger, ...(config.retentionDays === undefined ? {} : { retentionDays: config.retentionDays }) };
  },

  attach(audit, kestrel) {
    if (!audit.securityEvents) return;
    const keep = securityThrottle();
    return kestrel.observe({
      runEnd(event) {
        const entry = securityEntry(event, audit.failedSteps);
        if (entry === null || !keep(entry)) return;
        void audit.record(entry).then((recorded) => {
          if (isErr(recorded)) audit.logger.error("audit/persistence: a security entry was not recorded", { event: entry.event, code: recorded.error.code });
        });
      },
    });
  },

  steps: (audit) => ({
    record: async (ctx: Context) => {
      const recorded = await audit.record(entryFromEventData(ctx.payload));
      if (isErr(recorded)) return ctx.fail(recorded.error);
      return ok(ctx);
    },
    recordActor: async (ctx: Context) => {
      const recorded = await audit.record({ ...entryFromEventData(ctx.payload), params: {} });
      if (isErr(recorded)) return ctx.fail(recorded.error);
      return ok(ctx);
    },
    anonymize: async (ctx: Context) => {
      const id = userIdOf(ctx);
      if (id === null) return ctx.fail("VALIDATION", "audit.anonymize: no user id in params.id or the event payload");
      const changed = await audit.anonymize(id);
      if (isErr(changed)) return ctx.fail(changed.error);
      return ok({ ...ctx, result: { entries: changed.value } });
    },
    prune: async (ctx: Context) => {
      if (audit.retentionDays === undefined) return ctx.fail("VALIDATION", "audit.prune: no retentionDays configured");
      const removed = await audit.prune(audit.retentionDays);
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok({ ...ctx, result: { removed: removed.value } });
    },
  }),

  describe: () => ({
    record: { summary: "Persist an audit log entry for an emitted event", reads: ["payload"], writes: [], input: { type: "object", additionalProperties: true } },
    recordActor: { summary: "Persist an audit log entry for an emitted event with its caller and address but without its params and id, so it names no one the event was about", reads: ["payload"], writes: [], input: { type: "object", additionalProperties: true } },
    anonymize: {
      summary: "Strip the user in `params.id` or the event payload's `id` from every audit entry: their identity id and every param naming them go, the event and its time stay",
      reads: ["params.id", "payload"],
      writes: ["result"],
      input: { type: "object", additionalProperties: true },
      output: { type: "object", properties: { entries: { type: "number" } }, required: ["entries"] },
      errors: { 400: "no user id" },
    },
    prune: {
      summary: "Remove every audit entry older than the configured `retentionDays`",
      reads: [],
      writes: ["result"],
      output: { type: "object", properties: { removed: { type: "number" } }, required: ["removed"] },
      errors: { 400: "no `retentionDays` configured" },
    },
  }),
});
