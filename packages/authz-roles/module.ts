import { z } from "zod";
import "@michaelthielemann/kestrel-contracts/authn";
import { AUTHZ } from "@michaelthielemann/kestrel-contracts/authz";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { cutAnswer, FIELD_PATH, parseFieldsArgument, RESOURCE, unsortableField } from "./fields.ts";
import { createAuthzRoles, DEFAULT_ROLELESS_PIPELINES, type AuthzRoles } from "./impl.ts";

const fieldGrants = z.record(
  z.string().regex(RESOURCE, 'a resource is a name such as "media"'),
  z.array(z.string().regex(FIELD_PATH, 'a field path is "name", "name.sub" or "name[].sub", e.g. "variants[].path"')).min(1),
);

export const configSchema = z
  .object({
    roles: z.record(z.string(), z.array(z.string().regex(/^(\*|[a-z0-9_-]+(\.[a-z0-9_-]+)*(\.\*)?)$/))),
    roleClaim: z.string().min(1).default("roles"),
    anonymous: z.array(z.string()).default([]),
    anonymousFields: fieldGrants.default({}),
    fields: z.record(z.string(), fieldGrants).default({}),
    rolelessPipelines: z.array(z.string().min(1)).default([...DEFAULT_ROLELESS_PIPELINES]).describe("Pipelines that need a signed-in caller but serve an account without a configured role; every other such pipeline must run authz.requireRole"),
  })
  .strict()
  .superRefine((config, issues) => {
    for (const role of Object.keys(config.fields)) {
      if (!Object.hasOwn(config.roles, role)) issues.addIssue({ code: "custom", path: ["fields", role], message: `fields names role "${role}", which roles does not define` });
    }
  });

function fieldsTarget(arg: string) {
  const target = parseFieldsArgument(arg);
  if (target === undefined) throw new Error(`authz/roles: authz.fields:${arg} – write authz.fields:<resource>?shape=<item|list|array|file>, e.g. authz.fields:media?shape=list`);
  return target;
}

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

    requireRole: async (ctx: Context) => {
      if (!ctx.identity) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      if (!authz.hasRole(ctx.identity)) return ctx.fail("FORBIDDEN", "this account has no role");
      return ok(ctx);
    },

    describePipelineAccess: async (ctx: Context) => {
      const base = resultBase(ctx, "describePipelineAccess");
      return ok({ ...ctx, result: { ...base, pipelineAccess: authz.describePipelineAccess(ctx.identity) } });
    },

    listRoles: async (ctx: Context) => {
      const base = resultBase(ctx, "listRoles");
      return ok({ ...ctx, result: { ...base, roles: authz.listRoles() } });
    },

    fields: stepFactory((arg: string) => {
      const { resource, shape } = fieldsTarget(arg);
      return async (ctx: Context) => {
        const tree = authz.fieldsFor(ctx.identity, resource);
        if (tree === "all") return ok(ctx);
        if (tree === undefined) return ctx.fail("FORBIDDEN", `no field grant on ${resource} for a caller without an identity or a configured role`);
        if (shape === "list") {
          const field = unsortableField(ctx.payload.sort, tree);
          if (field !== undefined) return ctx.fail("VALIDATION", `authz.fields:${resource}: cannot sort by "${field}"`);
        }
        if (ctx.result === undefined) return ok(ctx);
        return ok({ ...ctx, result: cutAnswer(ctx.result, shape, tree) });
      };
    }),

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

  describe: (authz: AuthzRoles) => ({
    require: (permission: string) => ({ summary: `Requires permission ${permission}`, reads: [], writes: [], security: "required" as const, errors: { 401: "not authenticated", 403: `missing permission ${permission}` } }),
    requireRole: {
      summary: "Requires a signed-in caller holding at least one configured role; an account without one may only run the pipelines rolelessPipelines names",
      reads: ["identity?"],
      writes: [],
      errors: { 401: "not authenticated", 403: "this account has no role" },
    },
    describePipelineAccess: {
      summary: "Per booted pipeline, whether the caller passes its authz.require steps",
      reads: ["identity?"],
      writes: ["result.pipelineAccess"],
      extendsOutput: {
        type: "object",
        properties: { pipelineAccess: { type: "object", additionalProperties: { type: "string", enum: ["granted", "denied", "unknown"] } } },
        required: ["pipelineAccess"],
      },
    },
    listRoles: {
      summary: "The configured role names, in config order",
      reads: [],
      writes: ["result.roles"],
      extendsOutput: { type: "object", properties: { roles: { type: "array", items: { type: "string" } } }, required: ["roles"] },
    },
    fields: (arg: string) => {
      const target = parseFieldsArgument(arg);
      const resource = target?.resource ?? arg;
      const summary = `Keep only the ${resource} fields the caller may see: anonymousFields.${resource} without an identity or a configured role; otherwise everything when one of its roles has no field grant for ${resource}, else the union of its roles' grants and the anonymous one`;
      const errors = { 403: `no field grant on ${resource} for a caller without an identity or a configured role` };
      if (target === undefined) return { summary, reads: ["identity?", "result?"], writes: ["result?"], errors };
      const narrows = { shape: target.shape, answers: authz.answersOf(target.resource) };
      if (target.shape !== "list") return { summary, reads: ["identity?", "result?"], writes: ["result?"], errors, narrows };
      return {
        summary: `${summary}; a caller kept to a grant may sort only by a field it names whole or by id, createdAt and updatedAt`,
        reads: ["identity?", "result?", "payload.sort?"],
        writes: ["result?"],
        query: { sort: { type: "string", description: "field name, prefix - for descending" } },
        errors,
        narrows,
      };
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
