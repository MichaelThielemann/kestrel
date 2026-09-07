import { z } from "zod";
import { AUTHN } from "@michaelthielemann/kestrel-contracts/authn";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createAuthnMulti, tokenFromHeaders, type AuthnMulti } from "./impl.ts";

export const configSchema = z
  .object({
    identifier: z.enum(["username", "email"]).default("username"),
    minPasswordLength: z.number().int().min(8).default(12),
    sessionTtlSeconds: z.number().int().positive().default(86400),
    bootstrap: z.object({ username: z.string().min(1), passwordHash: z.string().startsWith("scrypt$"), roles: z.array(z.string()).default([]) }).strict().optional(),
  })
  .strict();

function credentials(payload: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(payload).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default defineModule({
  name: "authn/multi",
  provides: [AUTHN],
  requires: [PERSISTENCE],
  configSchema,

  async setup(config, deps): Promise<AuthnMulti> {
    return createAuthnMulti(config, deps.get(PERSISTENCE));
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
    setPassword: async (ctx: Context) => {
      const id = ctx.params.id;
      if (id === undefined) throw new Error("authn.setPassword: no params.id (boot's dataflow check already proved this route always provides it)");
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
  }),

  describe: () => ({
    login: {
      summary: "Log in with credentials",
      reads: [],
      writes: ["token", "identity", "result"],
      input: { type: "object", properties: { username: { type: "string" }, email: { type: "string" }, password: { type: "string" } }, required: ["password"] },
      output: { type: "object", properties: { token: { type: "string" }, identity: { type: "object", properties: { id: { type: "string" }, claims: { type: "object", additionalProperties: true } }, required: ["id", "claims"] } }, required: ["token", "identity"] },
      errors: { 401: "invalid credentials" },
    },
    identifyUser: { summary: "Identify the caller if a valid token is present", reads: [], writes: ["token?", "identity?"], security: "optional" },
    requireUser: { summary: "Require a valid session", reads: [], writes: ["token", "identity"], security: "required", errors: { 401: "not authenticated" } },
    loadIdentity: {
      summary: "Current identity",
      reads: ["identity"],
      writes: ["result"],
      output: { type: "object", properties: { id: { type: "string" }, claims: { type: "object", additionalProperties: true } }, required: ["id", "claims"] },
      errors: { 401: "not authenticated" },
    },
    logout: { summary: "End the current session", reads: ["token"], writes: ["result"], output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, errors: { 401: "not authenticated" } },
    createUser: {
      summary: "Create a user",
      reads: [],
      writes: ["result"],
      input: { type: "object", properties: { username: { type: "string" }, password: { type: "string" }, roles: { type: "array", items: { type: "string" } } }, required: ["username", "password"] },
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
    setPassword: {
      summary: "Set a user's password (ends their sessions)",
      reads: ["params.id"],
      writes: ["result"],
      input: { type: "object", properties: { password: { type: "string" } }, required: ["password"] },
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      errors: { 400: "password missing or too short", 404: "user not found" },
    },
    changePassword: {
      summary: "Change own password",
      reads: ["identity"],
      writes: ["result"],
      input: { type: "object", properties: { currentPassword: { type: "string" }, newPassword: { type: "string" } }, required: ["currentPassword", "newPassword"] },
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      errors: { 400: "wrong current password, missing fields, or new one too short", 401: "not authenticated" },
    },
    deactivateUser: {
      summary: "Deactivate a user",
      reads: ["params.id"],
      writes: ["result"],
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      errors: { 400: "cannot deactivate yourself", 404: "user not found" },
    },
    activateUser: {
      summary: "Activate a user",
      reads: ["params.id"],
      writes: ["result"],
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      errors: { 404: "user not found" },
    },
    cleanupSessions: { summary: "Remove expired sessions", reads: [], writes: ["result"], output: { type: "object", properties: { removed: { type: "number" } } } },
  }),
});
