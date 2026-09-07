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

export default defineModule({
  name: "authz/roles",
  provides: [AUTHZ],
  requires: [],
  configSchema,

  async setup(cfg): Promise<AuthzRoles> {
    return createAuthzRoles(cfg);
  },

  steps: (authz: AuthzRoles) => ({
    require: stepFactory((permission: string) => async (ctx: Context) => {
      if (!ctx.identity) return authz.canAnonymous(permission) ? ok(ctx) : ctx.fail("UNAUTHENTICATED", "not authenticated");
      const allowed = await authz.can(ctx.identity, permission);
      if (isErr(allowed)) return ctx.fail(allowed.error);
      if (!allowed.value) return ctx.fail("FORBIDDEN", `missing permission ${permission}`);
      return ok(ctx);
    }),
  }),

  describe: () => ({
    require: (permission: string) => ({ summary: `Requires permission ${permission}`, reads: [], writes: [], security: "required" as const, errors: { 401: "not authenticated", 403: `missing permission ${permission}` } }),
  }),
});
