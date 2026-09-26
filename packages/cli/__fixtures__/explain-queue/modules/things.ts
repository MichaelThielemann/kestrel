import { z } from "zod";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";

export default defineModule({
  name: "things/local",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  steps: () => ({
    create: async (ctx: Context) => ok({ ...ctx, result: { id: "thing-1" } }),
    note: async (ctx: Context) => ok(ctx),
  }),
  describe: () => ({
    create: { summary: "creates a thing", reads: ["payload"], writes: ["result"], atomicSafe: true, output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    note: { summary: "notes a thing", reads: [], writes: [] },
  }),
});
