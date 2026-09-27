import { z } from "zod";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";
import { clientKey, createRateLimitMemory, usernameKey, type BucketKey, type RateLimit } from "./impl.ts";

export const configSchema = z
  .object({
    buckets: z.record(
      z
        .object({
          limit: z.number().int().positive(),
          windowSeconds: z.number().int().positive(),
          key: z.enum(["ip", "username", "identity"]).default("ip").describe("What the bucket counts by: the client address (IPv6 by its /64), the username or email in the body, or the signed-in identity"),
          maxBlockSeconds: z.number().int().positive().optional().describe("With it, each further exceeded window doubles the block, up to this many seconds"),
        })
        .strict(),
    ),
  })
  .strict();

function keyFor(kind: BucketKey, ctx: Context): string {
  if (kind === "identity") {
    const identity: unknown = Reflect.get(ctx, "identity");
    const id: unknown = typeof identity === "object" && identity !== null ? Reflect.get(identity, "id") : undefined;
    return typeof id === "string" ? id : "unknown";
  }
  if (kind === "username") {
    const name = ctx.payload.username ?? ctx.payload.email;
    return usernameKey(typeof name === "string" ? name : undefined);
  }
  return clientKey(ctx.ip);
}

const READS: Record<BucketKey, string[]> = { ip: ["ip?"], username: ["payload.username?", "payload.email?"], identity: ["identity"] };

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
      const kind = limit.keyOf(bucket);
      return async (ctx: Context) => {
        const decision = limit.hit(bucket, keyFor(kind, ctx));
        if (!decision.allowed) {
          return ctx.fail("RATE_LIMITED", `too many requests, retry in ${decision.retryAfterSeconds}s`, { retryAfterSeconds: decision.retryAfterSeconds });
        }
        return ok(ctx);
      };
    }),
    sweep: async (ctx: Context) => ok({ ...ctx, result: { removed: limit.sweep() } }),
  }),

  describe: (limit) => ({
    check: (bucket: string) => {
      const kind = bucket === "<arg>" ? "ip" : limit.keyOf(bucket);
      return {
        summary: `Rate limit bucket ${bucket}, counted by ${kind === "ip" ? "client address" : kind}`,
        reads: READS[kind],
        writes: [],
        ...(kind === "username" ? { input: { type: "object", properties: { username: { type: "string" }, email: { type: "string" } }, additionalProperties: true } } : {}),
        errors: { 429: "too many requests" },
      };
    },
    sweep: { summary: "Drop expired rate-limit windows", reads: [], writes: ["result"], output: { type: "object", properties: { removed: { type: "number" } }, required: ["removed"] } },
  }),
});
