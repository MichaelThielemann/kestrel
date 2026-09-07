import { z } from "zod";
import "@michaelthielemann/kestrel-contracts/authn";
import { VALIDATE } from "@michaelthielemann/kestrel-contracts/validate";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";
import { createValidator, type Validator } from "./impl.ts";

export const configSchema = z
  .object({
    schemas: z.record(z.union([z.string().min(1), z.record(z.unknown())])),
    maxDepth: z.number().int().positive().default(32),
    maxNodes: z.number().int().positive().default(20_000),
    watch: z.boolean().default(false),
  })
  .strict();

export default defineModule({
  name: "validate/jsonschema",
  provides: [VALIDATE],
  requires: [],
  configSchema,

  async setup(config, deps): Promise<Validator> {
    return createValidator(config, deps.root, deps.logger);
  },

  teardown: (v) => v.close(),

  steps: (v) => ({
    sanitize: stepFactory((target: string) => {
      if (!v.targets().includes(target)) throw new Error(`validate.sanitize: no schema configured for "${target}"`);
      const field = target.slice(target.indexOf(".") + 1);
      return async (ctx: Context) => {
        if (!(field in ctx.payload) || ctx.payload[field] === null) return ok(ctx);
        return ok({ ...ctx, payload: { ...ctx.payload, [field]: v.sanitize(target, ctx.payload[field]) } });
      };
    }),
    sanitizeHtml: stepFactory((field: string) => async (ctx: Context) => {
      const value = ctx.payload[field];
      if (typeof value !== "string") return ok(ctx);
      return ok({ ...ctx, payload: { ...ctx.payload, [field]: v.sanitizeHtml(value) } });
    }),
    check: stepFactory((target: string) => {
      if (!v.targets().includes(target)) throw new Error(`validate.check: no schema configured for "${target}"`);
      const field = target.slice(target.indexOf(".") + 1);
      return async (ctx: Context) => {
        if (!(field in ctx.payload) || ctx.payload[field] === null) return ok(ctx);
        const result = v.check(target, ctx.payload[field]);
        if (result.ok) return ok(ctx);
        const message = `${target}: ${result.problems.map((p) => `${p.path} ${p.message}`).join("; ")}`;
        const details: Record<string, unknown> = { problems: result.problems };
        const rootProblems = result.problems.filter((p) => p.path === "/");
        if (rootProblems.length > 0) details.fields = rootProblems.map((p) => ({ field, message: p.message }));
        return ctx.fail("VALIDATION", message, details);
      };
    }),
  }),

  describe: () => ({
    sanitize: (target: string) => ({ summary: `Sanitize HTML at format:"html" positions of payload field ${target}`, reads: [], writes: [`payload.${target.slice(target.indexOf(".") + 1)}`] }),
    sanitizeHtml: (field: string) => ({ summary: `Sanitize the HTML payload field ${field}`, reads: [], writes: [`payload.${field}`] }),
    check: (target: string) => ({ summary: `Validate payload field ${target} against its JSON Schema`, reads: [], writes: [], errors: { 400: "schema violation (path and message per problem)" } }),
  }),
});
