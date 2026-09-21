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
      const access = authz.describeAccess(ctx.identity);
      const previous = isRecord(ctx.result) ? ctx.result : {};
      return ok({ ...ctx, result: { ...previous, ...access } });
    },
  }),

  describe: () => ({
    require: (permission: string) => ({ summary: `Requires permission ${permission}`, reads: [], writes: [], security: "required" as const, errors: { 401: "not authenticated", 403: `missing permission ${permission}` } }),
    describeAccess: {
      summary: "The caller's concrete permissions and the configured role names",
      reads: ["identity"],
      writes: ["result.permissions", "result.roles"],
      extendsOutput: { type: "object", properties: { permissions: { type: "array", items: { type: "string" } }, roles: { type: "array", items: { type: "string" } } }, required: ["permissions", "roles"] },
      security: "required" as const,
      errors: { 401: "not authenticated" },
    },
  }),
});
