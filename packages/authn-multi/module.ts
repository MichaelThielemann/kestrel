import { z } from "zod";
import { AUTHN } from "@michaelthielemann/kestrel-contracts/authn";
import { AUTHZ } from "@michaelthielemann/kestrel-contracts/authz";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import "@michaelthielemann/kestrel-contracts/verifiedUser";
import { clearedSessionCookie, crossOriginRefusal, requestToken, sessionCookie, sessionCookieName } from "@michaelthielemann/kestrel-contracts/helpers/session";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule, type JsonSchema } from "@michaelthielemann/kestrel/defineModule";
import { customFailure } from "@michaelthielemann/kestrel/errors";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createAuthnMulti, type AuthnMulti } from "./impl.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadPath(ctx: Context, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => (isRecord(value) ? value[segment] : undefined), ctx.payload);
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USER_REFERENCE_SCHEMA: JsonSchema = { type: ["string", "object", "null"], properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id"] };

function nestedInputSchema(path: string, leaf: JsonSchema): JsonSchema {
  return path.split(".").reduceRight<JsonSchema>((acc, key) => ({ type: "object", properties: { [key]: acc }, additionalProperties: true }), leaf);
}

export const configSchema = z
  .object({
    identifier: z.enum(["username", "email"]).default("username"),
    minPasswordLength: z.number().int().min(8).default(12),
    sessionTtlSeconds: z.number().int().positive().default(86400),
    secureCookie: z.boolean().default(true).describe("Mark the session cookie Secure; turn off only to sign in over plain HTTP during development"),
    adminPermission: z.string().min(1).default("users.manage").describe("The permission that makes a user an admin; the last active holder of it cannot be deactivated, deleted or stripped of it"),
    bootstrap: z.object({ username: z.string().min(1), passwordHash: z.string().startsWith("scrypt$").describe("secret"), roles: z.array(z.string()).default([]) }).strict().optional(),
  })
  .strict();

function credentials(payload: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(payload).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The status `authn.requireRecentAuth` answers when the session's last password check is too old. */
export const REAUTH_REQUIRED_STATUS = 403;

function windowSeconds(arg: string): number {
  if (!/^[1-9]\d*$/.test(arg)) throw new Error(`authn.requireRecentAuth:${arg}: the window must be a positive whole number of seconds`);
  return Number(arg);
}

export default defineModule({
  name: "authn/multi",
  provides: [AUTHN],
  requires: [PERSISTENCE],
  optional: [AUTHZ],
  configSchema,

  async setup(config, deps): Promise<AuthnMulti> {
    return createAuthnMulti(config, deps.get(PERSISTENCE), Date.now, deps.find(AUTHZ));
  },

  steps: (authn) => ({
    login: async (ctx: Context) => {
      const session = await authn.login(credentials(ctx.payload));
      if (isErr(session)) return ctx.fail(session.error);
      if (!session.value) return ctx.fail("UNAUTHENTICATED", "invalid credentials", { username: credentials(ctx.payload)[authn.identifier] ?? "" });
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

    verifyUser: stepFactory((path: string) => async (ctx: Context) => {
      const raw = payloadPath(ctx, path);
      if (raw === null || raw === undefined) return ok({ ...ctx, verifiedUser: null });
      const id = typeof raw === "string" ? raw : isRecord(raw) && typeof raw.id === "string" ? raw.id : undefined;
      if (id === undefined) return ctx.fail("VALIDATION", `authn.verifyUser:${path}: expected a user id, { id }, or null`);
      const user = await authn.getUser(id);
      if (isErr(user)) return ctx.fail(user.error);
      if (!user.value) return ctx.fail("NOT_FOUND", `user ${id} not found`);
      if (!user.value.active) return ctx.fail("VALIDATION", `authn.verifyUser:${path}: user is not active`);
      return ok({ ...ctx, verifiedUser: { id: user.value.id, name: user.value.username } });
    }),
    requireAbsentUser: async (ctx: Context) => {
      const id = ctx.params.id;
      if (id === undefined) throw new Error("authn.requireAbsentUser: no params.id (boot's dataflow check already proved this route always provides it)");
      if (!USER_ID.test(id)) return ctx.fail("VALIDATION", "authn.requireAbsentUser: params.id is not a user id");
      const user = await authn.getUser(id);
      if (isErr(user)) return ctx.fail(user.error);
      if (user.value) return ctx.fail("CONFLICT", `user ${id} still exists`);
      return ok(ctx);
    },
    createUser: async (ctx: Context) => {
      const username = str(ctx.payload.username);
      const password = str(ctx.payload.password);
      if (!username || !password) return ctx.fail("VALIDATION", "username and password are required");
      const roles = Array.isArray(ctx.payload.roles) ? ctx.payload.roles.filter((r): r is string => typeof r === "string") : [];
      const created = await authn.createUser({ username, password, roles });
      if (isErr(created)) return ctx.fail(created.error);
      return ok({ ...ctx, result: created.value });
    },
    listUsers: async (ctx: Context) => {
      const users = await authn.listUsers();
      if (isErr(users)) return ctx.fail(users.error);
      return ok({ ...ctx, result: users.value });
    },
    getUser: async (ctx: Context) => {
      const id = ctx.params.id;
      if (id === undefined) throw new Error("authn.getUser: no params.id (boot's dataflow check already proved this route always provides it)");
      const user = await authn.getUser(id);
      if (isErr(user)) return ctx.fail(user.error);
      if (!user.value) return ctx.fail("NOT_FOUND", `user ${id} not found`);
      return ok({ ...ctx, result: user.value });
    },
    updateUser: async (ctx: Context) => {
      const id = ctx.params.id;
      if (id === undefined) throw new Error("authn.updateUser: no params.id (boot's dataflow check already proved this route always provides it)");
      const username = str(ctx.payload.username);
      const roles = Array.isArray(ctx.payload.roles) ? ctx.payload.roles.filter((r): r is string => typeof r === "string") : undefined;
      if (username === undefined && roles === undefined) return ctx.fail("VALIDATION", "username or roles is required");
      const updated = await authn.updateUser(id, { ...(username === undefined ? {} : { username }), ...(roles === undefined ? {} : { roles }) });
      if (isErr(updated)) return ctx.fail(updated.error);
      return ok({ ...ctx, result: updated.value });
    },
    deleteUser: async (ctx: Context) => {
      const id = ctx.params.id;
      if (id === undefined) throw new Error("authn.deleteUser: no params.id (boot's dataflow check already proved this route always provides it)");
      if (ctx.identity?.id === id) return ctx.fail("VALIDATION", "you cannot delete yourself");
      const wanted = ctx.payload.reassignTo;
      if (wanted !== undefined && wanted !== null && typeof wanted !== "string") return ctx.fail("VALIDATION", "reassignTo must be a user id or null");
      let reassignTo: { id: string; name: string } | null = null;
      if (typeof wanted === "string") {
        if (wanted === id) return ctx.fail("VALIDATION", "reassignTo must not be the deleted user");
        const target = await authn.getUser(wanted);
        if (isErr(target)) return ctx.fail(target.error);
        if (!target.value) return ctx.fail("NOT_FOUND", `user ${wanted} not found`);
        if (!target.value.active) return ctx.fail("VALIDATION", "reassignTo must be an active user");
        reassignTo = { id: target.value.id, name: target.value.username };
      }
      const result = await authn.deleteUser(id);
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: { ok: true, reassignTo } });
    },
    setPassword: async (ctx: Context) => {
      const id = ctx.params.id;
      if (id === undefined) throw new Error("authn.setPassword: no params.id (boot's dataflow check already proved this route always provides it)");
      if (ctx.identity?.id === id) return ctx.fail("VALIDATION", "change your own password with changePassword, which needs the current one");
      const password = str(ctx.payload.password);
      if (!password) return ctx.fail("VALIDATION", "password is required");
      const result = await authn.setPassword(id, password);
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: { ok: true } });
    },
    changePassword: async (ctx: Context) => {
      if (!ctx.identity) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      const current = str(ctx.payload.currentPassword);
      const next = str(ctx.payload.newPassword);
      if (!current || !next) return ctx.fail("VALIDATION", "currentPassword and newPassword are required");
      const result = await authn.changePassword(ctx.identity.id, current, next, ctx.token);
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: { ok: true } });
    },
    deactivateUser: async (ctx: Context) => {
      const id = ctx.params.id;
      if (id === undefined) throw new Error("authn.deactivateUser: no params.id (boot's dataflow check already proved this route always provides it)");
      if (ctx.identity?.id === id) return ctx.fail("VALIDATION", "you cannot deactivate yourself");
      const result = await authn.setActive(id, false);
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: { ok: true } });
    },
    activateUser: async (ctx: Context) => {
      const id = ctx.params.id;
      if (id === undefined) throw new Error("authn.activateUser: no params.id (boot's dataflow check already proved this route always provides it)");
      const result = await authn.setActive(id, true);
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: { ok: true } });
    },
    cleanupSessions: async (ctx: Context) => {
      const removed = await authn.cleanupSessions();
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok({ ...ctx, result: { removed: removed.value } });
    },
    endSessions: async (ctx: Context) => {
      const id = ctx.params.id;
      if (id === undefined) throw new Error("authn.endSessions: no params.id (boot's dataflow check already proved this route always provides it)");
      const ended = await authn.endSessions(id);
      if (isErr(ended)) return ctx.fail(ended.error);
      return ok({ ...ctx, result: { ok: true } });
    },
    requireRecentAuth: stepFactory((arg: string) => {
      const seconds = windowSeconds(arg);
      return async (ctx: Context) => {
        if (!ctx.token) return ctx.fail("UNAUTHENTICATED", "not authenticated");
        const recent = await authn.recentlyAuthenticated(ctx.token, seconds);
        if (isErr(recent)) return ctx.fail(recent.error);
        if (!recent.value) return ctx.fail(customFailure("REAUTH_REQUIRED", REAUTH_REQUIRED_STATUS, "confirm your password to continue", { details: { maxAgeSeconds: seconds } }));
        return ok(ctx);
      };
    }),
    confirmPassword: async (ctx: Context) => {
      if (!ctx.token) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      const password = str(ctx.payload.password);
      if (!password) return ctx.fail("VALIDATION", "password is required");
      const confirmed = await authn.confirmPassword(ctx.token, password);
      if (isErr(confirmed)) return ctx.fail(confirmed.error);
      if (!confirmed.value) return ctx.fail("VALIDATION", "the password is wrong");
      return ok({ ...ctx, result: { ok: true } });
    },
  }),

  describe: () => ({
    login: {
      summary: "Log in with credentials; the token comes back in the body and in an HttpOnly session cookie",
      reads: [],
      writes: ["token", "identity", "responseHeaders", "result"],
      input: { type: "object", properties: { username: { type: "string", maxLength: 320 }, email: { type: "string", maxLength: 320 }, password: { type: "string" }, code: { type: "string" } }, required: ["password"], additionalProperties: false },
      output: { type: "object", properties: { token: { type: "string" }, identity: { type: "object", properties: { id: { type: "string" }, claims: { type: "object", additionalProperties: true } }, required: ["id", "claims"] } }, required: ["token", "identity"] },
      errors: { 401: "invalid credentials" },
    },
    identifyUser: { summary: "Identify the caller if a valid token is present; a state-changing request authenticated by the session cookie must come from the same origin", reads: [], writes: ["token?", "identity?"], security: "optional", errors: { 403: "a state-changing request authenticated by the session cookie is not from the same origin" } },
    requireUser: { summary: "Require a valid session; a state-changing request authenticated by the session cookie must come from the same origin", reads: [], writes: ["token", "identity"], security: "required", errors: { 401: "not authenticated", 403: "a state-changing request authenticated by the session cookie is not from the same origin" } },
    loadIdentity: {
      summary: "Current identity",
      reads: ["identity"],
      writes: ["result"],
      output: { type: "object", properties: { id: { type: "string" }, claims: { type: "object", additionalProperties: true } }, required: ["id", "claims"] },
      errors: { 401: "not authenticated" },
    },
    logout: { summary: "End the current session and remove the session cookie", reads: ["token"], writes: ["responseHeaders", "result"], output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, errors: { 401: "not authenticated" } },
    verifyUser: (path: string) => ({
      summary: `Verify the user reference at payload.${path}: it must be a user id, { id }, or null. Writes its canonical { id, name } to verifiedUser, or null when there was none to verify. authn.verifyUser:reassignTo reads payload.reassignTo; authn.verifyUser:result.reassignTo reads payload.result.reassignTo, the shape an event hands over`,
      reads: [`payload.${path}`],
      writes: ["verifiedUser"],
      input: nestedInputSchema(path, USER_REFERENCE_SCHEMA),
      errors: { 400: "the value is neither a user id, { id } nor null, or the user is not active", 404: "user not found" },
      atomicSafe: true,
    }),
    requireAbsentUser: {
      summary: "Require that params.id is the id of no user, active or not; the guard of the routes that clean up after a deleted user. An id that is not a UUID, the form of every user id, is refused",
      reads: ["params.id"],
      writes: [],
      errors: { 400: "params.id is not a user id", 409: "the user still exists" },
      atomicSafe: true,
    },
    createUser: {
      summary: "Create a user",
      reads: [],
      writes: ["result"],
      input: { type: "object", properties: { username: { type: "string" }, password: { type: "string" }, roles: { type: "array", items: { type: "string" } } }, required: ["username", "password"], additionalProperties: false },
      output: { type: "object", properties: { id: { type: "string" }, username: { type: "string" }, roles: { type: "array", items: { type: "string" } }, active: { type: "boolean" }, createdAt: { type: "number" } }, required: ["id", "username", "roles", "active", "createdAt"] },
      errors: { 400: "invalid input", 409: "username already exists" },
    },
    listUsers: {
      summary: "List users",
      reads: [],
      writes: ["result"],
      output: { type: "array", items: { type: "object", properties: { id: { type: "string" }, username: { type: "string" }, roles: { type: "array", items: { type: "string" } }, active: { type: "boolean" }, createdAt: { type: "number" } }, required: ["id", "username", "roles", "active", "createdAt"] } },
    },
    getUser: {
      summary: "One user",
      reads: ["params.id"],
      writes: ["result"],
      output: { type: "object", properties: { id: { type: "string" }, username: { type: "string" }, roles: { type: "array", items: { type: "string" } }, active: { type: "boolean" }, createdAt: { type: "number" } }, required: ["id", "username", "roles", "active", "createdAt"] },
      errors: { 404: "user not found" },
    },
    updateUser: {
      summary: "Rename a user or set their roles (a role change ends their sessions)",
      reads: ["params.id"],
      writes: ["result"],
      input: { type: "object", properties: { username: { type: "string" }, roles: { type: "array", items: { type: "string" } } }, additionalProperties: false },
      output: { type: "object", properties: { id: { type: "string" }, username: { type: "string" }, roles: { type: "array", items: { type: "string" } }, active: { type: "boolean" }, createdAt: { type: "number" } }, required: ["id", "username", "roles", "active", "createdAt"] },
      errors: { 400: "neither username nor roles given, or an empty one", 404: "user not found", 409: "username already exists (`CONFLICT`), or the last active admin would lose the admin permission (`LAST_ADMIN`)" },
      atomicSafe: true,
    },
    deleteUser: {
      summary: "Delete a user and their sessions for good; `reassignTo` names the active user their authored history moves to, without it the history is anonymised",
      reads: ["identity", "params.id", "payload.reassignTo"],
      writes: ["result"],
      input: { type: "object", properties: { reassignTo: { type: ["string", "null"] } }, additionalProperties: false },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" }, reassignTo: { type: ["object", "null"], properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] } },
        required: ["ok", "reassignTo"],
      },
      errors: {
        400: "cannot delete yourself, or a `reassignTo` that is the deleted user, inactive or not a user id",
        404: "user not found, or `reassignTo` names no user",
        409: "the last active admin cannot be deleted (`LAST_ADMIN`)",
      },
      atomicSafe: true,
    },
    setPassword: {
      summary: "Set another user's password (ends their sessions); one's own password changes only through changePassword",
      reads: ["identity?", "params.id"],
      writes: ["result"],
      input: { type: "object", properties: { password: { type: "string" } }, required: ["password"], additionalProperties: false },
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      errors: { 400: "password missing or too short, or the caller's own account", 404: "user not found" },
    },
    changePassword: {
      summary: "Change own password",
      reads: ["identity"],
      writes: ["result"],
      input: { type: "object", properties: { currentPassword: { type: "string" }, newPassword: { type: "string" } }, required: ["currentPassword", "newPassword"], additionalProperties: false },
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      errors: { 400: "wrong current password, missing fields, or new one too short", 401: "not authenticated" },
    },
    deactivateUser: {
      summary: "Deactivate a user (ends their sessions)",
      reads: ["params.id"],
      writes: ["result"],
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      errors: { 400: "cannot deactivate yourself", 404: "user not found", 409: "the last active admin cannot be deactivated (`LAST_ADMIN`)" },
      atomicSafe: true,
    },
    activateUser: {
      summary: "Activate a user",
      reads: ["params.id"],
      writes: ["result"],
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      errors: { 404: "user not found" },
    },
    cleanupSessions: { summary: "Remove expired sessions", reads: [], writes: ["result"], output: { type: "object", properties: { removed: { type: "number" } }, required: ["removed"] } },
    endSessions: {
      summary: "End every session of the user in params.id, e.g. after its second factor was reset",
      reads: ["params.id"],
      writes: ["result"],
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    },
    requireRecentAuth: (arg: string) => ({
      summary: `Require that the session's password was checked within the last ${arg} seconds, at login or through authn.confirmPassword; otherwise 403 REAUTH_REQUIRED`,
      reads: ["token"],
      writes: [],
      errors: { 401: "not authenticated", 403: "the last password check is older than the window (`REAUTH_REQUIRED`)" },
    }),
    confirmPassword: {
      summary: "Confirm the caller's password; marks the session as freshly authenticated for authn.requireRecentAuth",
      reads: ["token"],
      writes: ["result"],
      input: { type: "object", properties: { password: { type: "string" } }, required: ["password"], additionalProperties: false },
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      errors: { 400: "the password is missing or wrong", 401: "not authenticated" },
    },
  }),
});
