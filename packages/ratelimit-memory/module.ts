import { z } from "zod";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";
import { clientKey, createRateLimitMemory, usernameKey, type Bucket, type RateLimit } from "./impl.ts";

/** The longest account name a username bucket accepts; a longer one is refused before it is counted. */
export const MAX_ACCOUNT_NAME = 320;

const NOT_COUNTED_CODES = new Set(["RATE_LIMITED", "SECOND_FACTOR_REQUIRED", "SECOND_FACTOR_SETUP_REQUIRED"]);

type Instance = RateLimit & { pending: Map<string, Array<{ bucket: string; key: string }>> };

export const configSchema = z
  .object({
    buckets: z.record(
      z
        .object({
          limit: z.number().int().positive(),
          windowSeconds: z.number().int().positive(),
          key: z.enum(["ip", "username", "identity"]).default("ip").describe("What the bucket counts by: the client address (IPv6 by its /64), the username or email in the body, or the signed-in identity"),
          maxBlockSeconds: z.number().int().positive().optional().describe("With it, each further exceeded window doubles the block, up to this many seconds"),
          field: z.enum(["username", "email"]).default("username").describe("For a username bucket: the body field that names the account, the same one the login reads"),
          counts: z.enum(["requests", "failures"]).default("requests").describe("requests counts every request let through; failures counts only runs that fail after the check (400 or 401), and a successful run clears the key"),
        })
        .strict(),
    ),
  })
  .strict();

function keyFor(bucket: Bucket, ctx: Context): string {
  const kind = bucket.key ?? "ip";
  if (kind === "identity") {
    const identity: unknown = Reflect.get(ctx, "identity");
    const id: unknown = typeof identity === "object" && identity !== null ? Reflect.get(identity, "id") : undefined;
    return typeof id === "string" ? id : "unknown";
  }
  if (kind === "username") {
    const name = ctx.payload[bucket.field ?? "username"];
    return usernameKey(typeof name === "string" ? name : undefined);
  }
  return clientKey(ctx.ip);
}

export default defineModule({
  name: "ratelimit/memory",
  provides: [],
  requires: [],
  configSchema,

  async setup(config): Promise<Instance> {
    return { ...createRateLimitMemory(config), pending: new Map() };
  },

  attach: (limit, kestrel) =>
    kestrel.observe({
      runEnd(event) {
        const checked = limit.pending.get(event.runId);
        if (checked === undefined) return;
        limit.pending.delete(event.runId);
        for (const { bucket, key } of checked) {
          if (event.status < 400) limit.reset(bucket, key);
          else if ((event.status === 400 || event.status === 401) && !NOT_COUNTED_CODES.has(event.code ?? "")) limit.fail(bucket, key);
        }
      },
    }),

  steps: (limit) => ({
    check: stepFactory((bucket: string) => {
      const config = limit.bucketOf(bucket);
      return async (ctx: Context) => {
        const key = keyFor(config, ctx);
        const failuresOnly = config.counts === "failures";
        const decision = failuresOnly ? limit.peek(bucket, key) : limit.hit(bucket, key);
        if (!decision.allowed) {
          return ctx.fail("RATE_LIMITED", `too many requests, retry in ${decision.retryAfterSeconds}s`, { retryAfterSeconds: decision.retryAfterSeconds });
        }
        if (failuresOnly) limit.pending.set(ctx.runId, [...(limit.pending.get(ctx.runId) ?? []), { bucket, key }]);
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
        reads: kind === "identity" ? ["identity"] : ["ip?", "payload.username?", "payload.email?"],
        writes: [],
        input: { type: "object", properties: { username: { type: "string", maxLength: MAX_ACCOUNT_NAME }, email: { type: "string", maxLength: MAX_ACCOUNT_NAME } }, additionalProperties: true },
        errors: { 400: `an account name longer than ${MAX_ACCOUNT_NAME} characters`, 429: "too many requests" },
      };
    },
    sweep: { summary: "Drop expired rate-limit windows", reads: [], writes: ["result"], output: { type: "object", properties: { removed: { type: "number" } }, required: ["removed"] } },
  }),
});
