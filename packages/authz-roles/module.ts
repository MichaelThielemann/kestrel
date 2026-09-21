import { z } from "zod";
import "@michaelthielemann/kestrel-contracts/authn";
import { AUTHZ } from "@michaelthielemann/kestrel-contracts/authz";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createAuthzRoles, type AuthzRoles } from "./impl.ts";

export const configSchema = z
  .object({
    roles: z.record(z.array(z.string().regex(/^(\*|[a-z0-9_-]+(\.[a-z0-9_-]+)*(\.\*)?)$/))),
    roleClaim: z.string().min(1).default("roles"),
    anonymous: z.array(z.string()).default([]),
  })
  .strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadPath(ctx: Context, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => (isRecord(value) ? value[segment] : undefined), ctx.payload);
}

function resultBase(ctx: Context, step: string): Record<string, unknown> {
  if (ctx.result === undefined) return {};
  if (isRecord(ctx.result)) return ctx.result;
  throw new Error(`authz.${step}: expected ctx.result to be an object or undefined, got ${typeof ctx.result}`);
}

export default defineModule({
  name: "authz/roles",
  provides: [AUTHZ],
  requires: [],
  configSchema,

  async setup(cfg): Promise<AuthzRoles> {
    return createAuthzRoles(cfg);
  },

  attach: (authz, kestrel) => authz.attach(kestrel),

  steps: (authz: AuthzRoles) => ({
    require: stepFactory((permission: string) => async (ctx: Context) => {
      if (!ctx.identity) return authz.canAnonymous(permission) ? ok(ctx) : ctx.fail("UNAUTHENTICATED", "not authenticated");
      const allowed = await authz.can(ctx.identity, permission);
      if (isErr(allowed)) return ctx.fail(allowed.error);
      if (!allowed.value) return ctx.fail("FORBIDDEN", `missing permission ${permission}`);
      return ok(ctx);
    }),

    describeAccess: async (ctx: Context) => {
      if (!ctx.identity) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      const base = resultBase(ctx, "describeAccess");
      return ok({ ...ctx, result: { ...base, ...authz.describeAccess(ctx.identity) } });
    },

    listRoles: async (ctx: Context) => {
      const base = resultBase(ctx, "listRoles");
      return ok({ ...ctx, result: { ...base, roles: authz.listRoles() } });
    },

    validateRoles: stepFactory((path: string) => async (ctx: Context) => {
      const raw = payloadPath(ctx, path);
      if (raw === null || raw === undefined) return ok(ctx);
      if (!Array.isArray(raw) || !raw.every((role): role is string => typeof role === "string")) {
        return ctx.fail("VALIDATION", `authz.validateRoles:${path}: expected an array of role names`);
      }
      const known = new Set(authz.listRoles());
      const unknown = raw.filter((role) => !known.has(role));
      if (unknown.length > 0) return ctx.fail("VALIDATION", `authz.validateRoles:${path}: unknown role name(s)`, { unknown });
      return ok(ctx);
    }),
  }),

  describe: () => ({
    require: (permission: string) => ({ summary: `Requires permission ${permission}`, reads: [], writes: [], security: "required" as const, errors: { 401: "not authenticated", 403: `missing permission ${permission}` } }),
    describeAccess: {
      summary: "The caller's concrete permissions",
      reads: ["identity"],
      writes: ["result.permissions"],
      extendsOutput: { type: "object", properties: { permissions: { type: "array", items: { type: "string" } } }, required: ["permissions"] },
      security: "required" as const,
      errors: { 401: "not authenticated" },
    },
    listRoles: {
      summary: "The configured role names, in config order",
      reads: [],
      writes: ["result.roles"],
      extendsOutput: { type: "object", properties: { roles: { type: "array", items: { type: "string" } } }, required: ["roles"] },
    },
    validateRoles: (path: string) => ({
      summary: `Validate the role names at payload.${path} against the configured roles; an absent value passes. authz.validateRoles:roles reads payload.roles, the shape authn.createUser and authn.updateUser accept`,
      reads: [`payload.${path}`],
      writes: [],
      input: { type: "object", additionalProperties: true },
      errors: { 400: "the value is not an array of known role names" },
    }),
  }),
});
