import { z } from "zod";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createAuditPersistence, entryFromEventData, type Audit } from "./impl.ts";

export const configSchema = z
  .object({
    retentionDays: z.number().int().positive().optional().describe("How long an entry is kept; without it `audit.prune` has no rule to apply and fails"),
  })
  .strict();

type Instance = Audit & { retentionDays?: number };

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
    return { ...audit, ...(config.retentionDays === undefined ? {} : { retentionDays: config.retentionDays }) };
  },

  steps: (audit) => ({
    record: async (ctx: Context) => {
      const recorded = await audit.record(entryFromEventData(ctx.payload));
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
