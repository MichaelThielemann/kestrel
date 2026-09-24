import { z } from "zod";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { ok, type Result } from "@michaelthielemann/kestrel/result";
import type { Context } from "@michaelthielemann/kestrel/context";

export default defineModule({
  name: "notes/local",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  steps: () => ({
    create: async (ctx: Context): Promise<Result<Context, never>> => ok({ ...ctx, result: { id: "n1" } }),
    onCreated: async (ctx: Context): Promise<Result<Context, never>> => ok(ctx),
  }),
  describe: () => ({
    create: { summary: "create a note", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    onCreated: { summary: "react to note.created", reads: [], writes: [] },
  }),
});
