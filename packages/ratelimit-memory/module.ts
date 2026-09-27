import { z } from "zod";
import "@michaelthielemann/kestrel-contracts/knownDevice";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";
import { createDeviceCookies, deviceId, type DeviceCookies } from "./device.ts";
import { clientKey, createRateLimitMemory, usernameKey, type Bucket, type RateLimit } from "./impl.ts";

/** The longest account name a username bucket accepts; a longer one is refused before it is counted. */
export const MAX_ACCOUNT_NAME = 320;

const NOT_COUNTED_CODES = new Set(["RATE_LIMITED", "SECOND_FACTOR_REQUIRED", "SECOND_FACTOR_SETUP_REQUIRED"]);

/** The default lifetime of a device cookie: 30 days. */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 2_592_000;

type Instance = RateLimit & { pending: Map<string, Array<{ bucket: string; key: string }>>; devices: DeviceCookies | undefined };

const budgetSchema = z
  .object({
    limit: z.number().int().positive(),
    windowSeconds: z.number().int().positive(),
    maxBlockSeconds: z.number().int().positive().optional(),
  })
  .strict();

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
          knownDevices: budgetSchema.optional().describe("For a username bucket: the budget of each device with a valid device cookie for the account, counted in place of the account's budget; needs deviceCookies"),
        })
        .strict(),
    ),
    deviceCookies: z
      .object({
        secretKey: z.string().min(1).describe("secret"),
        previousSecretKeys: z.array(z.string().min(1)).default([]).describe("secret"),
        maxAgeSeconds: z.number().int().positive().default(DEVICE_COOKIE_MAX_AGE_SECONDS).describe("How long a device cookie stays valid after the sign-in that issued it"),
        secure: z.boolean().default(true).describe("Mark the device cookie Secure with the __Host- name; turn off only to sign in over plain HTTP during development"),
      })
      .strict()
      .optional()
      .describe("How ratelimit.rememberDevice signs the device cookies that let a known device sign in past an account's block"),
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
    const withDevices = Object.entries(config.buckets).find(([, bucket]) => bucket.knownDevices !== undefined);
    if (withDevices !== undefined && config.deviceCookies === undefined) throw new Error(`ratelimit/memory: bucket "${withDevices[0]}" has knownDevices, which needs deviceCookies`);
    const devices = config.deviceCookies === undefined ? undefined : createDeviceCookies(config.deviceCookies);
    return { ...createRateLimitMemory(config), pending: new Map(), devices };
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
          else limit.refund(bucket, key);
        }
      },
    }),

  steps: (limit) => ({
    check: stepFactory((bucket: string) => {
      const config = limit.bucketOf(bucket);
      const devices = limit.deviceBucketOf(bucket);
      const failuresOnly = config.counts === "failures";
      const take = (name: string, key: string, runId: string): ReturnType<RateLimit["hit"]> => {
        const decision = failuresOnly ? limit.reserve(name, key) : limit.hit(name, key);
        if (decision.allowed && failuresOnly) limit.pending.set(runId, [...(limit.pending.get(runId) ?? []), { bucket: name, key }]);
        return decision;
      };
      return async (ctx: Context) => {
        const key = keyFor(config, ctx);
        const device = devices === undefined || key === "unknown" ? undefined : limit.devices?.verify(ctx.headers, key);
        if (devices !== undefined && device !== undefined && take(devices, device, ctx.runId).allowed) return ok({ ...ctx, knownDevice: { id: deviceId(device) } });
        const decision = take(bucket, key, ctx.runId);
        if (!decision.allowed) {
          return ctx.fail("RATE_LIMITED", `too many requests, retry in ${decision.retryAfterSeconds}s`, { retryAfterSeconds: decision.retryAfterSeconds });
        }
        return ok(ctx);
      };
    }),
    rememberDevice: stepFactory((bucket: string) => {
      const config = limit.bucketOf(bucket);
      const devices = limit.devices;
      if (limit.deviceBucketOf(bucket) === undefined || devices === undefined) throw new Error(`ratelimit.rememberDevice:${bucket}: the bucket has no knownDevices`);
      return async (ctx: Context) => {
        const key = keyFor(config, ctx);
        if (Reflect.get(ctx, "identity") === undefined || key === "unknown") return ok(ctx);
        return ok({ ...ctx, responseCookies: [...(ctx.responseCookies ?? []), devices.issue(key)] });
      };
    }),
    sweep: async (ctx: Context) => ok({ ...ctx, result: { removed: limit.sweep() } }),
  }),

  describe: (limit) => ({
    check: (bucket: string) => {
      const kind = bucket === "<arg>" ? "ip" : limit.keyOf(bucket);
      const devices = bucket !== "<arg>" && limit.deviceBucketOf(bucket) !== undefined;
      return {
        summary: `Rate limit bucket ${bucket}, counted by ${kind === "ip" ? "client address" : kind}${devices ? "; a device with a valid device cookie for the account is counted in its own budget instead" : ""}`,
        reads: kind === "identity" ? ["identity"] : ["ip?", "payload.username?", "payload.email?", "headers.cookie?"],
        writes: devices ? ["knownDevice?"] : [],
        input: { type: "object", properties: { username: { type: "string", maxLength: MAX_ACCOUNT_NAME }, email: { type: "string", maxLength: MAX_ACCOUNT_NAME } }, additionalProperties: true },
        errors: { 400: `an account name longer than ${MAX_ACCOUNT_NAME} characters`, 429: "too many requests" },
      };
    },
    rememberDevice: (bucket: string) => ({
      summary: `After a successful sign-in: hand the device a signed device cookie bound to the account bucket ${bucket} counts by, so its next sign-ins count against the device's own budget`,
      reads: ["identity", "payload.username?", "payload.email?"],
      writes: ["responseCookies?"],
      input: { type: "object", properties: { username: { type: "string", maxLength: MAX_ACCOUNT_NAME }, email: { type: "string", maxLength: MAX_ACCOUNT_NAME } }, additionalProperties: true },
    }),
    sweep: { summary: "Drop expired rate-limit windows", reads: [], writes: ["result"], output: { type: "object", properties: { removed: { type: "number" } }, required: ["removed"] } },
  }),
});
