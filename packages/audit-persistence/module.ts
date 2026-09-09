import { z } from "zod";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createAuditPersistence, entryFromEventData, type Audit } from "./impl.ts";

export default defineModule({
  name: "audit/persistence",
  provides: [],
  requires: [PERSISTENCE],
  configSchema: z.object({}).strict(),

  async setup(_config, deps): Promise<Audit> {
    return createAuditPersistence(deps.get(PERSISTENCE));
  },

  steps: (audit) => ({
    record: async (ctx: Context) => {
      const recorded = await audit.record(entryFromEventData(ctx.payload));
      if (isErr(recorded)) return ctx.fail(recorded.error);
      return ok(ctx);
    },
  }),

  describe: () => ({
    record: { summary: "Persist an audit log entry for an emitted event", reads: ["payload"], writes: [], input: { type: "object", additionalProperties: true } },
  }),
});
