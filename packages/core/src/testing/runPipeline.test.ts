import { describe, it, expect } from "vitest";
import { z } from "zod";
import { stepFactory, type Context } from "../context.ts";
import type { ModuleDefinition } from "../defineModule.ts";
import { ok } from "../result.ts";
import { definePipeline } from "../definePipeline.ts";
import type { Logger } from "../logger.ts";
import { runPipeline } from "./runPipeline.ts";

function stackLogger(): { logger: Logger; stacks: string[] } {
  const stacks: string[] = [];
  return { logger: { step() {}, info() {}, error: (_message, data) => stacks.push(String(data?.stack)) }, stacks };
}

const createPage = definePipeline({ name: "createPage", steps: ["authn.requireUser", "authz.require:pages.write", "page.save"] });

const fakeSteps = {
  "authn.requireUser": async (ctx: Context) => (ctx.headers.authorization === "Bearer ok" ? ok({ ...ctx, params: { ...ctx.params, user: "u1" } }) : ctx.fail("UNAUTHENTICATED", "not authenticated")),
  "authz.require": stepFactory((perm: string) => async (ctx: Context) => (perm === "pages.write" ? ok(ctx) : ctx.fail("FORBIDDEN", perm))),
  "page.save": async (ctx: Context) => ok({ ...ctx, result: { id: "p1", ...ctx.payload } }),
};
const fakeWrites = { "authn.requireUser": ["params.user"] };

describe("testing/runPipeline", () => {
  it("rejects without identity", async () => {
    const res = await runPipeline(createPage, { payload: { title: "x" } }, { steps: fakeSteps, writes: fakeWrites });
    expect(res.status).toBe(401);
  });

  it("runs through with a token", async () => {
    const res = await runPipeline(createPage, { payload: { title: "x" }, headers: { authorization: "Bearer ok" } }, { steps: fakeSteps, writes: fakeWrites });
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ id: "p1", title: "x" });
  });

  it("a stand-in that writes an undeclared key fails the run", async () => {
    const { logger, stacks } = stackLogger();
    const res = await runPipeline(createPage, { payload: { title: "x" }, headers: { authorization: "Bearer ok" } }, { steps: fakeSteps, logger });
    expect(res).toMatchObject({ status: 500, error: "createPage/authn.requireUser: unexpected Error" });
    expect(stacks.join("\n")).toContain('writes "params" without declaring it');
  });

  it("answers a thrown step's message when no logger is passed, so a failing test names the cause", async () => {
    const res = await runPipeline(createPage, { payload: { title: "x" }, headers: { authorization: "Bearer ok" } }, { steps: fakeSteps });
    expect(res).toMatchObject({ status: 500, code: "INTERNAL", error: 'createPage/authn.requireUser: step "authn.requireUser" writes "params" without declaring it' });
  });

  it("unknown step in the pipeline fails loudly", async () => {
    const p = definePipeline({ name: "p", steps: ["nope.step"] });
    expect(() => runPipeline(p, {}, { steps: fakeSteps })).toThrow(/unknown step "nope.step"/);
  });

  it("fails a step whose result does not match its declared describe().output", async () => {
    const module: ModuleDefinition = {
      name: "widgets",
      provides: [],
      requires: [],
      configSchema: z.object({}),
      setup: async () => ({}),
      steps: () => ({ get: async (ctx: Context) => ok({ ...ctx, result: { name: "x" } }) }),
      describe: () => ({
        get: { summary: "get", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      }),
    };
    const p = definePipeline({ name: "getWidget", steps: ["widgets.get"] });
    const { logger, stacks } = stackLogger();
    const res = await runPipeline(p, {}, { modules: [{ module, instance: {} }], logger });
    expect(res).toMatchObject({ status: 500, error: "getWidget/widgets.get: unexpected Error" });
    expect(stacks.join("\n")).toContain('step "widgets.get": result does not match describe().output ($.id is required)');
  });
});
