import { randomUUID } from "node:crypto";
import type { Context, Step } from "@michaelthielemann/kestrel/context";
import { isErr, ok, type Result } from "@michaelthielemann/kestrel/result";
import type { Authn, AuthnError, Identity, Session } from "../authn.ts";
import { clearedSessionCookie, crossOriginRefusal, requestToken, sessionCookie, sessionCookieName } from "../helpers/session.ts";


function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Accepts exactly one seeded username/password pair; there is no user store to manage. */
export function createAuthnFake(username = "alice", password = "long-enough"): Authn {
  const sessions = new Map<string, Identity>();
  return {
    async login(creds): Promise<Result<Session | null, AuthnError>> {
      if (creds.username !== username || creds.password !== password) return ok(null);
      const token = randomUUID();
      const identity: Identity = { id: username, claims: {} };
      sessions.set(token, identity);
      return ok({ token, identity });
    },
    async resolve(token): Promise<Result<Identity | null, AuthnError>> {
      return ok(sessions.get(token) ?? null);
    },
    async logout(token): Promise<Result<void, AuthnError>> {
      sessions.delete(token);
      return ok();
    },
  };
}

/** The session lifetime the fake's session cookie carries as `Max-Age`. */
export const FAKE_SESSION_TTL_SECONDS = 3600;

/** What each of `fakeAuthnSteps()`'s steps writes onto the context, for `runPipeline`'s dataflow check. */
export const FAKE_AUTHN_WRITES: Readonly<Record<string, readonly string[]>> = {
  "authn.login": ["token", "identity", "responseHeaders", "result"],
  "authn.identifyUser": ["token?", "identity?"],
  "authn.requireUser": ["token", "identity"],
  "authn.loadIdentity": ["result"],
  "authn.logout": ["responseHeaders", "result"],
};

/** The same five steps authn-single and authn-multi register, wired to a fake `Authn` for the shared step-contract suite. */
export function fakeAuthnSteps(authn: Authn): Record<string, Step> {
  const cookie = { maxAgeSeconds: FAKE_SESSION_TTL_SECONDS, secure: true };
  return {
    "authn.login": async (ctx: Context) => {
      const session = await authn.login({ username: str(ctx.payload.username), password: str(ctx.payload.password) });
      if (isErr(session)) return ctx.fail(session.error);
      if (!session.value) return ctx.fail("UNAUTHENTICATED", "invalid credentials");
      const responseHeaders = { "set-cookie": sessionCookie(session.value.token, cookie) };
      return ok({ ...ctx, token: session.value.token, identity: session.value.identity, responseHeaders, result: session.value });
    },
    "authn.identifyUser": async (ctx: Context) => {
      const found = requestToken(ctx.headers, sessionCookieName(cookie.secure));
      if (!found) return ok(ctx);
      const refused = found.source === "cookie" ? crossOriginRefusal(ctx.trigger, ctx.headers) : undefined;
      if (refused !== undefined) return ctx.fail("FORBIDDEN", refused);
      const token = found.token;
      const identity = await authn.resolve(token);
      if (isErr(identity)) return ctx.fail(identity.error);
      return ok(identity.value ? { ...ctx, token, identity: identity.value } : ctx);
    },
    "authn.requireUser": async (ctx: Context) => {
      const found = requestToken(ctx.headers, sessionCookieName(cookie.secure));
      if (!found) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      const refused = found.source === "cookie" ? crossOriginRefusal(ctx.trigger, ctx.headers) : undefined;
      if (refused !== undefined) return ctx.fail("FORBIDDEN", refused);
      const token = found.token;
      const identity = await authn.resolve(token);
      if (isErr(identity)) return ctx.fail(identity.error);
      if (!identity.value) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      return ok({ ...ctx, token, identity: identity.value });
    },
    "authn.loadIdentity": async (ctx: Context) => {
      if (!ctx.identity) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      return ok({ ...ctx, result: ctx.identity });
    },
    "authn.logout": async (ctx: Context) => {
      if (!ctx.token) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      const result = await authn.logout(ctx.token);
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, responseHeaders: { "set-cookie": clearedSessionCookie(cookie) }, result: { ok: true } });
    },
  };
}
