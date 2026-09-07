import { z } from "zod";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { first, stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createLinksDefault, type Links } from "./impl.ts";

export const configSchema = z
  .object({
    timeoutMs: z.number().int().positive().default(10_000),
    concurrency: z.number().int().min(1).max(32).default(4),
    recheckAfterSeconds: z.number().int().min(0).default(6 * 3600),
    userAgent: z.string().min(1).default("kestrel-links/0.1 (+link check)"),
    allowPrivate: z.boolean().default(false),
  })
  .strict();

const ENTRY = {
  type: "object",
  properties: {
    url: { type: "string" }, fromType: { type: "string" }, fromId: { type: "string" }, field: { type: "string" }, locale: { type: "string" },
    ok: { type: ["boolean", "null"] }, status: { type: ["number", "null"] }, error: { type: ["string", "null"] }, checkedAt: { type: ["number", "null"] },
  },
};

export default defineModule({
  name: "links/default",
  provides: [],
  requires: [CONTENT, PERSISTENCE],
  configSchema,

  async setup(config, deps): Promise<Links> {
    return createLinksDefault(config, deps.get(CONTENT), deps.get(PERSISTENCE));
  },

  steps: (links) => ({
    extract: stepFactory((type: string) => async (ctx: Context) => {
      const result = ctx.result as { id?: unknown } | undefined;
      const id = result?.id;
      if (typeof id !== "string") throw new Error(`links.extract:${type}: no document id in result`);
      const extracted = await links.extract(type, id);
      if (isErr(extracted)) return ctx.fail(extracted.error);
      return ok(ctx);
    }),
    unextract: stepFactory((type: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const removed = await links.unextract(type, ctx.params.id);
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok(ctx);
    }),
    check: async (ctx: Context) => {
      const result = await links.check();
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: result.value });
    },
    report: async (ctx: Context) => {
      const result = await links.report(first(ctx.payload.type));
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: result.value });
    },
    rebuild: async (ctx: Context) => {
      const result = await links.rebuild();
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: result.value });
    },
  }),

  describe: () => ({
    extract: (type: string) => ({ summary: `Index external links of ${type}`, reads: ["result.id"], writes: [] }),
    unextract: (type: string) => ({ summary: `Drop indexed links of ${type}`, reads: ["params.id"], writes: [], errors: { 400: "missing id" } }),
    check: { summary: "Check due links", reads: [], writes: ["result"], output: { type: "object", properties: { urls: { type: "number" }, checked: { type: "number" }, broken: { type: "number" }, skipped: { type: "number" } } } },
    report: { summary: "Broken links", reads: [], writes: ["result"], query: { type: { type: "string" } }, output: { type: "array", items: ENTRY } },
    rebuild: { summary: "Rebuild the link index", reads: [], writes: ["result"], output: { type: "object", properties: { documents: { type: "number" }, entries: { type: "number" } } } },
  }),
});
