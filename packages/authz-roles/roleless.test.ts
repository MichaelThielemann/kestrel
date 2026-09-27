import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, defineModule, type Kestrel } from "@michaelthielemann/kestrel";
import type { Identity } from "@michaelthielemann/kestrel-contracts/authn";
import type { Context } from "@michaelthielemann/kestrel/context";
import { definePipeline, type PipelineDefinition } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import module from "./module.ts";

const ROLELESS: Identity = { id: "nobody", claims: { roles: [] } };
const UNKNOWN_ROLE: Identity = { id: "stranger", claims: { roles: ["visitor"] } };
const EDITOR: Identity = { id: "ed", claims: { roles: ["editor"] } };

function probeFor(identity: Identity | null) {
  return defineModule({
    name: "probe/test",
    provides: [],
    requires: [],
    configSchema: z.object({}),
    async setup() {
      return {};
    },
    steps: () => ({
      requireUser: async (ctx: Context) => (identity === null ? ctx.fail("UNAUTHENTICATED", "not authenticated") : ok({ ...ctx, identity })),
      identifyUser: async (ctx: Context) => ok(identity === null ? ctx : { ...ctx, identity }),
      answer: async (ctx: Context) => ok({ ...ctx, result: { ok: true } }),
    }),
    describe: () => ({
      requireUser: { summary: "A signed-in caller", reads: [], writes: ["identity"], security: "required" as const },
      identifyUser: { summary: "The caller, if signed in", reads: [], writes: ["identity?"], security: "optional" as const },
      answer: { summary: "Answers", reads: [], writes: ["result"], output: { type: "object" } },
    }),
  });
}

const ADMIN_PIPELINES = [
  definePipeline({ name: "listMediaFolders", steps: ["probe.requireUser", "authz.requireRole", "authz.require:media.read", "probe.answer"] }),
  definePipeline({ name: "adminSchemaModel", steps: ["probe.requireUser", "authz.requireRole", "probe.answer"] }),
];
const OPEN_TO_ANY_ACCOUNT = [
  definePipeline({ name: "me", steps: ["probe.requireUser", "probe.answer"] }),
  definePipeline({ name: "logout", steps: ["probe.requireUser", "probe.answer"] }),
];
const PUBLIC = [definePipeline({ name: "readPage", steps: ["probe.identifyUser", "authz.require:pages.read", "probe.answer"] })];

function start(identity: Identity | null, pipelines: readonly PipelineDefinition[], authz: Record<string, unknown> = {}): Promise<Kestrel> {
  return boot({
    config: {
      modules: [
        { use: "./probe.ts", config: {} },
        { use: "@michaelthielemann/kestrel-authz-roles", config: { roles: { admin: ["*"], editor: ["pages.*", "media.*"] }, anonymous: ["pages.read", "media.read"], ...authz } },
      ],
      triggers: [],
      http: null,
    },
    modules: [probeFor(identity), module],
    pipelines: [...pipelines],
    logger: silentLogger,
  });
}

const trigger = { kind: "http" as const, name: "test" };

describe("authz/roles: an account without a configured role", () => {
  it("is refused 403 on every pipeline that needs a signed-in caller, but may run me and logout", async () => {
    for (const identity of [ROLELESS, UNKNOWN_ROLE]) {
      const kestrel = await start(identity, [...ADMIN_PIPELINES, ...OPEN_TO_ANY_ACCOUNT]);
      for (const pipeline of ADMIN_PIPELINES) {
        const run = await kestrel.run(pipeline.name, { trigger });
        expect(run.status, `${identity.id} on ${pipeline.name}`).toBe(403);
        expect(run.code).toBe("FORBIDDEN");
      }
      for (const pipeline of OPEN_TO_ANY_ACCOUNT) expect((await kestrel.run(pipeline.name, { trigger })).status, pipeline.name).toBe(200);
      await kestrel.stop();
    }
  });

  it("gets the same answer as an anonymous visitor on a public pipeline", async () => {
    const roleless = await start(ROLELESS, PUBLIC);
    const anonymous = await start(null, PUBLIC);
    const asRoleless = await roleless.run("readPage", { trigger });
    const asAnonymous = await anonymous.run("readPage", { trigger });
    expect(asRoleless.status).toBe(200);
    expect({ status: asRoleless.status, result: asRoleless.result }).toEqual({ status: asAnonymous.status, result: asAnonymous.result });
    await roleless.stop();
    await anonymous.stop();
  });

  it("lets an account with a configured role through authz.requireRole", async () => {
    const kestrel = await start(EDITOR, ADMIN_PIPELINES);
    for (const pipeline of ADMIN_PIPELINES) expect((await kestrel.run(pipeline.name, { trigger })).status, pipeline.name).toBe(200);
    await kestrel.stop();
  });

  it("answers 401 on authz.requireRole without a signed-in caller", async () => {
    const kestrel = await start(null, [definePipeline({ name: "probe", steps: ["probe.identifyUser", "authz.requireRole", "probe.answer"] })]);
    expect((await kestrel.run("probe", { trigger })).status).toBe(401);
    await kestrel.stop();
  });

  it("fails boot for a pipeline that needs a signed-in caller but does not require a role, naming it", async () => {
    const leaky = definePipeline({ name: "listUsers", steps: ["probe.requireUser", "probe.answer"] });
    await expect(start(EDITOR, [leaky])).rejects.toThrow(/pipeline "listUsers".*authz\.requireRole/);
    const beforeAuthn = definePipeline({ name: "listUsers", steps: ["authz.requireRole", "probe.requireUser", "probe.answer"] });
    await expect(start(EDITOR, [beforeAuthn])).rejects.toThrow(/listUsers/);
  });

  it("fails boot when authz.requireRole comes only after a step that does the work", async () => {
    const late = definePipeline({ name: "listUsers", steps: ["probe.requireUser", "probe.answer", "authz.requireRole"] });
    await expect(start(EDITOR, [late])).rejects.toThrow(/pipeline "listUsers".*authz\.requireRole/);
  });

  it("lets config name further pipelines open to any signed-in account", async () => {
    const own = definePipeline({ name: "myProfile", steps: ["probe.requireUser", "probe.answer"] });
    const kestrel = await start(ROLELESS, [own], { rolelessPipelines: ["myProfile"] });
    expect((await kestrel.run("myProfile", { trigger })).status).toBe(200);
    await kestrel.stop();
  });
});
