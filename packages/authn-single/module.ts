import { z } from "zod";
import { AUTHN, type Authn } from "@michaelthielemann/kestrel-contracts/authn";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createAuthnSingle, tokenFromHeaders } from "./impl.ts";

export const configSchema = z
  .object({
    username: z.string().min(1),
    passwordHash: z.string().startsWith("scrypt$"),
    sessionTtlSeconds: z.number().int().positive().default(86400),
    roles: z.array(z.string()).default([]),
  })
  .strict();

function credentials(payload: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(payload).filter((e): e is [string, string] => typeof e[1] === "string"));
}

export default defineModule({
  name: "authn/single",
  provides: [AUTHN],
  requires: [],
  configSchema,

  async setup(config): Promise<Authn> {
    return createAuthnSingle(config);
  },

  steps: (authn) => ({
    login: async (ctx: Context) => {
      const session = await authn.login(credentials(ctx.payload));
      if (isErr(session)) return ctx.fail(session.error);
      if (!session.value) return ctx.fail("UNAUTHENTICATED", "invalid credentials");
      return ok({ ...ctx, token: session.value.token, identity: session.value.identity, result: session.value });
    },
    identifyUser: async (ctx: Context) => {
      const token = tokenFromHeaders(ctx.headers);
      if (!token) return ok(ctx);
      const identity = await authn.resolve(token);
      if (isErr(identity)) return ctx.fail(identity.error);
      return ok(identity.value ? { ...ctx, token, identity: identity.value } : ctx);
    },
    requireUser: async (ctx: Context) => {
      const token = tokenFromHeaders(ctx.headers);
      if (!token) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      const identity = await authn.resolve(token);
      if (isErr(identity)) return ctx.fail(identity.error);
      if (!identity.value) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      return ok({ ...ctx, token, identity: identity.value });
    },
    loadIdentity: async (ctx: Context) => {
      if (!ctx.identity) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      return ok({ ...ctx, result: ctx.identity });
    },
    logout: async (ctx: Context) => {
      if (!ctx.token) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      const result = await authn.logout(ctx.token);
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: { ok: true } });
    },
  }),

  describe: () => ({
    login: { summary: "Log in with credentials", reads: [], writes: ["token", "identity", "result"], input: { type: "object", properties: { username: { type: "string" }, password: { type: "string" } }, required: ["username", "password"] }, output: { type: "object", properties: { token: { type: "string" }, identity: { type: "object", properties: { id: { type: "string" }, claims: { type: "object", additionalProperties: true } }, required: ["id", "claims"] } }, required: ["token", "identity"] }, errors: { 401: "invalid credentials" } },
    identifyUser: { summary: "Identify the caller if a valid token is present", reads: [], writes: ["token?", "identity?"], security: "optional" },
    requireUser: { summary: "Require a valid session", reads: [], writes: ["token", "identity"], security: "required", errors: { 401: "not authenticated" } },
    loadIdentity: { summary: "Current identity", reads: ["identity"], writes: ["result"], output: { type: "object", properties: { id: { type: "string" }, claims: { type: "object", additionalProperties: true } }, required: ["id", "claims"] }, errors: { 401: "not authenticated" } },
    logout: { summary: "End the current session", reads: ["token"], writes: ["result"], output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, errors: { 401: "not authenticated" } },
  }),
});
