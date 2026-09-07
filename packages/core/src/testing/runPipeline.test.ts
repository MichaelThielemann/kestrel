import { describe, it, expect } from "vitest";
import { stepFactory, type Context } from "../context.ts";
import { ok } from "../result.ts";
import { definePipeline } from "../definePipeline.ts";
import { runPipeline } from "./runPipeline.ts";

const createPage = definePipeline({ name: "createPage", steps: ["authn.requireUser", "authz.require:pages.write", "page.save"] });

const fakeSteps = {
  "authn.requireUser": async (ctx: Context) => (ctx.headers.authorization === "Bearer ok" ? ok({ ...ctx, params: { ...ctx.params, user: "u1" } }) : ctx.fail("UNAUTHENTICATED", "not authenticated")),
  "authz.require": stepFactory((perm: string) => async (ctx: Context) => (perm === "pages.write" ? ok(ctx) : ctx.fail("FORBIDDEN", perm))),
  "page.save": async (ctx: Context) => ok({ ...ctx, result: { id: "p1", ...ctx.payload } }),
};

describe("testing/runPipeline", () => {
  it("rejects without identity", async () => {
    const res = await runPipeline(createPage, { payload: { title: "x" } }, { steps: fakeSteps });
    expect(res.status).toBe(401);
  });

  it("runs through with a token", async () => {
    const res = await runPipeline(createPage, { payload: { title: "x" }, headers: { authorization: "Bearer ok" } }, { steps: fakeSteps });
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ id: "p1", title: "x" });
  });

  it("unknown step in the pipeline fails loudly", async () => {
    const p = definePipeline({ name: "p", steps: ["nope.step"] });
    expect(() => runPipeline(p, {}, { steps: fakeSteps })).toThrow(/unknown step "nope.step"/);
  });
});
