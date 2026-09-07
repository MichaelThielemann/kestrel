import { z } from "zod";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";
import { createRateLimitMemory, type RateLimit } from "./impl.ts";

export const configSchema = z
  .object({
    buckets: z.record(z.object({ limit: z.number().int().positive(), windowSeconds: z.number().int().positive() }).strict()),
  })
  .strict();

export default defineModule({
  name: "ratelimit/memory",
  provides: [],
  requires: [],
  configSchema,

  async setup(config): Promise<RateLimit> {
    return createRateLimitMemory(config);
  },

  steps: (limit) => ({
    check: stepFactory((bucket: string) => {
      limit.hit(bucket, "boot-probe");
      return async (ctx: Context) => {
        const decision = limit.hit(bucket, ctx.ip ?? "unknown");
        if (!decision.allowed) {
          return ctx.fail("RATE_LIMITED", `too many requests, retry in ${decision.retryAfterSeconds}s`, { retryAfterSeconds: decision.retryAfterSeconds });
        }
        return ok(ctx);
      };
    }),
    sweep: async (ctx: Context) => ok({ ...ctx, result: { removed: limit.sweep() } }),
  }),

  describe: () => ({
    check: (bucket: string) => ({ summary: `Rate limit bucket ${bucket}`, reads: [], writes: [], errors: { 429: "too many requests" } }),
    sweep: { summary: "Drop expired rate-limit windows", reads: [], writes: ["result"], output: { type: "object", properties: { removed: { type: "number" } } } },
  }),
});
