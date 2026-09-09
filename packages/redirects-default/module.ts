import { z } from "zod";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createRedirects, requestPath, type Redirects } from "./impl.ts";
import { RedirectRuleError } from "./rules.ts";

export const configSchema = z
  .object({
    type: z.string().min(1).default("redirects"),
    field: z.string().min(1).default("rules"),
    prefix: z.string().default(""),
    key: z.string().min(1).default("redirects.json"),
  })
  .strict();

const RULE_SCHEMA = { type: "object", properties: { pattern: { type: "string" }, target: { type: "string" }, status: { type: "integer", enum: [301, 302, 307, 308] } }, required: ["pattern", "target", "status"] };
const ROW_SCHEMA = { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, status: { type: ["string", "number"] } } };

export default defineModule({
  name: "redirects/default",
  provides: [],
  requires: [CONTENT, BLOBSTORE],
  configSchema,

  async setup(config, deps): Promise<Redirects & { field: string }> {
    return { ...createRedirects(config, { content: deps.get(CONTENT), blobs: deps.get(BLOBSTORE), logger: deps.logger }), field: config.field };
  },

  steps: (redirects) => ({
    validate: async (ctx: Context) => {
      const rules = ctx.payload[redirects.field];
      if (rules === undefined || rules === null) return ok(ctx);
      try {
        redirects.validate(rules);
      } catch (e) {
        if (!(e instanceof RedirectRuleError)) throw e;
        const row = /^Row (\d+):/.exec(e.message);
        return row ? ctx.fail("VALIDATION", `redirects: ${e.message}`, { row: Number(row[1]) }) : ctx.fail("VALIDATION", `redirects: ${e.message}`);
      }
      return ok(ctx);
    },
    lookup: async (ctx: Context) => {
      const hit = await redirects.lookup(requestPath(ctx.params.path ?? ""));
      if (isErr(hit)) return ctx.fail(hit.error);
      return hit.value ? ctx.done({ redirect: hit.value }) : ok(ctx);
    },
    export: async (ctx: Context) => {
      const previous = typeof ctx.result === "object" && ctx.result !== null && !Array.isArray(ctx.result) ? (ctx.result as Record<string, unknown>) : {};
      const exported = await redirects.export();
      if (isErr(exported)) return ctx.fail(exported.error);
      return ok({ ...ctx, result: { ...previous, redirects: exported.value } });
    },
    render: async (ctx: Context) => {
      const rendered = await redirects.render();
      if (isErr(rendered)) return ctx.fail(rendered.error);
      return ok({ ...ctx, result: rendered.value });
    },
  }),

  describe: (redirects) => ({
    validate: {
      summary: "Compile the redirect rules of the payload; VALIDATION names the offending row",
      reads: [],
      writes: [],
      input: { type: "object", properties: { [redirects.field]: { type: "array", items: ROW_SCHEMA } }, additionalProperties: false },
      errors: { 400: "Row N: <reason>" },
    },
    lookup: { summary: "Answer { redirect: { to, status } } and end the pipeline when the request path matches a rule", reads: ["params.path"], writes: ["result"] },
    export: {
      summary: "Write redirects.json to the blobstore (adds `redirects: { rules, skipped }` to the result)",
      reads: [],
      writes: ["result.redirects"],
      extendsOutput: { type: "object", properties: { redirects: { type: "object", properties: { rules: { type: "integer" }, skipped: { type: "array", items: { type: "string" } } }, required: ["rules", "skipped"] } }, required: ["redirects"] },
    },
    render: { summary: "The compiled redirect list (same content as redirects.json)", reads: [], writes: ["result"], output: { type: "array", items: RULE_SCHEMA } },
  }),
});
