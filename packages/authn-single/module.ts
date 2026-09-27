import { z } from "zod";
import { AUTHN } from "@michaelthielemann/kestrel-contracts/authn";
import { clearedSessionCookie, crossOriginRefusal, requestToken, sessionCookie, sessionCookieName } from "@michaelthielemann/kestrel-contracts/helpers/session";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createAuthnSingle, type AuthnSingle } from "./impl.ts";

export const configSchema = z
  .object({
    username: z.string().min(1),
    passwordHash: z.string().startsWith("scrypt$").describe("secret"),
    sessionTtlSeconds: z.number().int().positive().default(86400),
    secureCookie: z.boolean().default(true).describe("Mark the session cookie Secure; turn off only to sign in over plain HTTP during development"),
    roles: z.array(z.string()).default([]),
  })
  .strict();

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function credentials(payload: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(payload).filter((e): e is [string, string] => typeof e[1] === "string"));
}

export default defineModule({
  name: "authn/single",
  provides: [AUTHN],
  requires: [],
  configSchema,

  async setup(config): Promise<AuthnSingle> {
    return createAuthnSingle(config);
  },

  steps: (authn) => ({
    login: async (ctx: Context) => {
      const session = await authn.login(credentials(ctx.payload));
      if (isErr(session)) return ctx.fail(session.error);
      if (!session.value) return ctx.fail("UNAUTHENTICATED", "invalid credentials", { username: str(ctx.payload.username) });
      const responseHeaders = { "set-cookie": sessionCookie(session.value.token, authn.sessionCookie) };
      return ok({ ...ctx, token: session.value.token, identity: session.value.identity, responseHeaders, result: session.value });
    },
    identifyUser: async (ctx: Context) => {
      const found = requestToken(ctx.headers, sessionCookieName(authn.sessionCookie.secure));
      if (!found) return ok(ctx);
      const refused = found.source === "cookie" ? crossOriginRefusal(ctx.trigger, ctx.headers) : undefined;
      if (refused !== undefined) return ctx.fail("FORBIDDEN", refused);
      const token = found.token;
      const identity = await authn.resolve(token);
      if (isErr(identity)) return ctx.fail(identity.error);
      return ok(identity.value ? { ...ctx, token, identity: identity.value } : ctx);
    },
    requireUser: async (ctx: Context) => {
      const found = requestToken(ctx.headers, sessionCookieName(authn.sessionCookie.secure));
      if (!found) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      const refused = found.source === "cookie" ? crossOriginRefusal(ctx.trigger, ctx.headers) : undefined;
      if (refused !== undefined) return ctx.fail("FORBIDDEN", refused);
      const token = found.token;
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
      return ok({ ...ctx, responseHeaders: { "set-cookie": clearedSessionCookie(authn.sessionCookie) }, result: { ok: true } });
    },
  }),

  describe: () => ({
    login: { summary: "Log in with credentials; the token comes back in the body and in an HttpOnly session cookie", reads: [], writes: ["token", "identity", "responseHeaders", "result"], input: { type: "object", properties: { username: { type: "string", maxLength: 320 }, password: { type: "string" }, code: { type: "string" } }, required: ["username", "password"], additionalProperties: false }, output: { type: "object", properties: { token: { type: "string" }, identity: { type: "object", properties: { id: { type: "string" }, claims: { type: "object", additionalProperties: true } }, required: ["id", "claims"] } }, required: ["token", "identity"] }, errors: { 401: "invalid credentials" } },
    identifyUser: { summary: "Identify the caller if a valid token is present; a state-changing request authenticated by the session cookie must come from the same origin", reads: [], writes: ["token?", "identity?"], security: "optional", errors: { 403: "a state-changing request authenticated by the session cookie is not from the same origin" } },
    requireUser: { summary: "Require a valid session; a state-changing request authenticated by the session cookie must come from the same origin", reads: [], writes: ["token", "identity"], security: "required", errors: { 401: "not authenticated", 403: "a state-changing request authenticated by the session cookie is not from the same origin" } },
    loadIdentity: { summary: "Current identity", reads: ["identity"], writes: ["result"], output: { type: "object", properties: { id: { type: "string" }, claims: { type: "object", additionalProperties: true } }, required: ["id", "claims"] }, errors: { 401: "not authenticated" } },
    logout: { summary: "End the current session and remove the session cookie", reads: ["token"], writes: ["responseHeaders", "result"], output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, errors: { 401: "not authenticated" } },
  }),
});
