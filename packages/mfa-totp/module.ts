import { z } from "zod";
import { AUTHN, type Authn } from "@michaelthielemann/kestrel-contracts/authn";
import { AUTHZ } from "@michaelthielemann/kestrel-contracts/authz";
import { customFailure } from "@michaelthielemann/kestrel-contracts/errors";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createMfaTotp, type MfaTotp } from "./impl.ts";

export const configSchema = z
  .object({
    issuer: z.string().min(1).default("Kestrel").describe("The name an authenticator app shows next to the account"),
    secretKey: z.string().min(1).describe("secret"),
    enforce: z
      .union([z.enum(["all", "none"]), z.object({ permissions: z.array(z.string().min(1)).min(1) }).strict()])
      .default("all")
      .describe("Who must set up a second factor before signing in: all, none, or { permissions } for the accounts holding one of them"),
    recoveryCodes: z.number().int().min(5).max(20).default(10),
  })
  .strict();

/** The status of every refusal that concerns the second factor rather than the password. */
export const SECOND_FACTOR_STATUS = 401;

type Instance = MfaTotp & { authn: Authn };

function credentials(payload: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(payload).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function usernameOf(ctx: Context): string {
  const claimed = ctx.identity?.claims.username;
  if (typeof claimed === "string") return claimed;
  const given = ctx.payload.username ?? ctx.payload.email;
  return typeof given === "string" ? given : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CREDENTIALS_INPUT = { type: "object", properties: { username: { type: "string" }, email: { type: "string" }, password: { type: "string" } }, required: ["password"], additionalProperties: false } as const;

export default defineModule({
  name: "mfa/totp",
  provides: [],
  requires: [PERSISTENCE, AUTHN],
  optional: [AUTHZ],
  configSchema,

  async setup(config, deps): Promise<Instance> {
    const mfa = await createMfaTotp(config, deps.get(PERSISTENCE), Date.now, deps.find(AUTHZ));
    return { ...mfa, authn: deps.get(AUTHN) };
  },

  steps: (mfa) => ({
    check: async (ctx: Context) => {
      if (!ctx.identity || !ctx.token) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      const code = typeof ctx.payload.code === "string" ? ctx.payload.code : undefined;
      const checked = await mfa.check(ctx.identity, code);
      if (isErr(checked)) return ctx.fail(checked.error);
      const outcome = checked.value;
      if (outcome.kind === "pass") {
        if (outcome.recoveryCodes === undefined) return ok(ctx);
        const base = isRecord(ctx.result) ? ctx.result : {};
        return ok({ ...ctx, result: { ...base, recoveryCodes: outcome.recoveryCodes } });
      }
      const ended = await mfa.authn.logout(ctx.token);
      if (isErr(ended)) return ctx.fail(ended.error);
      const username = usernameOf(ctx);
      if (outcome.reason === "required") return ctx.fail(customFailure("SECOND_FACTOR_REQUIRED", SECOND_FACTOR_STATUS, "enter the code of your second factor", { details: { username } }));
      if (outcome.reason === "setup-required") return ctx.fail(customFailure("SECOND_FACTOR_SETUP_REQUIRED", SECOND_FACTOR_STATUS, "set up a second factor to sign in", { details: { username } }));
      return ctx.fail("UNAUTHENTICATED", "invalid credentials", { username });
    },
    startSetup: async (ctx: Context) => {
      const given = credentials(ctx.payload);
      const session = await mfa.authn.login(given);
      if (isErr(session)) return ctx.fail(session.error);
      if (!session.value) return ctx.fail("UNAUTHENTICATED", "invalid credentials", { username: usernameOf(ctx) });
      const ended = await mfa.authn.logout(session.value.token);
      if (isErr(ended)) return ctx.fail(ended.error);
      const started = await mfa.startSetup(session.value.identity);
      if (isErr(started)) return ctx.fail(started.error);
      return ok({ ...ctx, result: started.value });
    },
    reset: async (ctx: Context) => {
      const id = ctx.params.id;
      if (id === undefined) throw new Error("mfa.reset: no params.id (boot's dataflow check already proved this route always provides it)");
      if (ctx.identity?.id === id) return ctx.fail("VALIDATION", "you cannot reset your own second factor; sign in with a recovery code instead");
      const reset = await mfa.reset(id);
      if (isErr(reset)) return ctx.fail(reset.error);
      return ok({ ...ctx, result: { ok: true } });
    },
    forget: async (ctx: Context) => {
      const id = ctx.params.id ?? (typeof ctx.payload.id === "string" ? ctx.payload.id : undefined);
      if (id === undefined) return ctx.fail("VALIDATION", "mfa.forget: no user id in params.id or the event payload");
      const reset = await mfa.reset(id);
      if (isErr(reset)) return ctx.fail(reset.error);
      return ok(ctx);
    },
    listEnrolled: async (ctx: Context) => {
      const withFactor = await mfa.usersWithFactor();
      if (isErr(withFactor)) return ctx.fail(withFactor.error);
      return ok({ ...ctx, result: [...withFactor.value].sort() });
    },
  }),

  describe: () => ({
    check: {
      summary: "After authn.login: check the second factor with payload.code (a time-based or a recovery code). A refusal ends the session the login opened; a code that confirms a new factor adds result.recoveryCodes, shown once",
      reads: ["identity", "token"],
      writes: ["result?"],
      input: { type: "object", properties: { code: { type: "string" } }, additionalProperties: true },
      extendsOutput: { type: "object", properties: { recoveryCodes: { type: "array", items: { type: "string" } } } },
      errors: { 401: "the code is wrong or used (`UNAUTHENTICATED`), a code is needed (`SECOND_FACTOR_REQUIRED`), or the account must set up a second factor first (`SECOND_FACTOR_SETUP_REQUIRED`)" },
    },
    startSetup: {
      summary: "Check the password through authn@1 and start setting up a second factor: answers the new secret and its otpauth URI; the next login with a code for it confirms it",
      reads: [],
      writes: ["result"],
      input: CREDENTIALS_INPUT,
      output: { type: "object", properties: { secret: { type: "string" }, uri: { type: "string" } }, required: ["secret", "uri"] },
      errors: { 401: "invalid credentials", 409: "the account already has a second factor" },
    },
    reset: {
      summary: "Remove another user's second factor; follow it with a step that ends that user's sessions",
      reads: ["identity?", "params.id"],
      writes: ["result"],
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      errors: { 400: "the caller's own account" },
    },
    forget: {
      summary: "Remove the second factor of the user in params.id or the event payload's id, e.g. on user.deleted",
      reads: ["params.id?", "payload.id?"],
      writes: [],
      input: { type: "object", properties: { id: { type: ["string", "null"] } }, additionalProperties: true },
      errors: { 400: "no user id" },
    },
    listEnrolled: {
      summary: "The ids of the users with a confirmed second factor",
      reads: [],
      writes: ["result"],
      output: { type: "array", items: { type: "string" } },
    },
  }),
});
