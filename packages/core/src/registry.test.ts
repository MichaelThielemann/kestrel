import { describe, it, expect } from "vitest";
import { stepFactory, type Context, type StepMap } from "./context.ts";
import type { StepDescription } from "./defineModule.ts";
import { KestrelBootError } from "./errors.ts";
import { StepRegistry } from "./registry.ts";
import { ok } from "./result.ts";

const pass = async (ctx: Context) => ok(ctx);
const flat = (summary: string): StepDescription => ({ summary, reads: [], writes: [] });

function context(): Context {
  return {
    runId: "test",
    trigger: { kind: "http", name: "t" },
    payload: {},
    body: {},
    query: {},
    params: {},
    headers: {},
    files: [],
    fail: () => {
      throw new Error();
    },
    done: () => {
      throw new Error();
    },
  };
}

describe("StepRegistry", () => {
  it("registers under <prefix>.<key>", () => {
    const r = new StepRegistry();
    r.register("authn/single", "authn", { requireUser: pass }, { requireUser: flat("requireUser") });
    expect(r.has("authn.requireUser")).toBe(true);
    expect(r.resolve("authn.requireUser").name).toBe("authn.requireUser");
  });

  it("rejects duplicate step names", () => {
    const r = new StepRegistry();
    r.register("a/x", "a", { s: pass }, { s: flat("s") });
    expect(() => r.register("a/y", "a", { s: pass }, { s: flat("s") })).toThrow(KestrelBootError);
  });

  it("unknown step is a boot error naming the pipeline", () => {
    const r = new StepRegistry();
    expect(() => r.resolve("nope.step", "pipelines/p")).toThrow(/\[pipelines\/p\] unknown step "nope.step"/);
  });

  it("builds factory steps with the argument at resolve time", async () => {
    const r = new StepRegistry();
    r.register("authz/roles", "authz", { require: stepFactory((perm: string) => async (ctx: Context) => ok({ ...ctx, result: perm })) }, { require: (perm) => flat(`require ${perm}`) });
    const step = r.resolve("authz.require:pages.write");
    const out = await step.fn(context());
    expect(out.ok && (out.value.result as string)).toBe("pages.write");
  });

  it("argument on a plain step is a boot error and never calls the step", () => {
    const r = new StepRegistry();
    let called = false;
    r.register("a/x", "a", {
      s: async (ctx: Context) => {
        called = true;
        return ok(ctx);
      },
    }, { s: flat("s") });
    expect(() => r.resolve("a.s:arg")).toThrow(/\[pipeline\] step "a.s" does not accept an argument/);
    expect(called).toBe(false);
  });

  it("a factory step without an argument is a boot error", () => {
    const r = new StepRegistry();
    r.register("authz/roles", "authz", { require: stepFactory((perm: string) => async (ctx: Context) => ok({ ...ctx, result: perm })) }, { require: () => flat("require") });
    expect(() => r.resolve("authz.require", "pipelines/p")).toThrow(/\[pipelines\/p\] step "authz.require" requires an argument/);
  });

  it("empty argument is a boot error", () => {
    const r = new StepRegistry();
    r.register("a/x", "a", { s: pass }, { s: flat("s") });
    expect(() => r.resolve("a.s:")).toThrow(/empty argument/);
  });

  it("attaches step descriptions, per argument for factories", () => {
    const r = new StepRegistry();
    r.register("a/x", "a", { plain: pass, withArg: stepFactory((arg: string) => async (ctx: Context) => ok({ ...ctx, result: arg })) }, {
      plain: flat("plain"),
      withArg: (arg) => flat(`with ${arg}`),
    });
    expect(r.resolve("a.plain").description).toEqual({ summary: "plain", reads: [], writes: [] });
    expect(r.resolve("a.withArg:pages").description).toEqual({ summary: "with pages", reads: [], writes: [] });
    expect(() => r.register("b/x", "b", { s: pass }, { s: flat("s"), nope: flat("nope") })).toThrow(/does not exist/);
  });

  it("registers steps provided via the prototype chain (class-instance step maps)", async () => {
    class Steps {
      async requireUser(ctx: Context) {
        return ok(ctx);
      }
    }
    const r = new StepRegistry();
    const instance: object = new Steps();
    r.register("authn/single", "authn", instance as StepMap, { requireUser: flat("requireUser") });
    expect(r.has("authn.requireUser")).toBe(true);
    const step = r.resolve("authn.requireUser");
    const ctx = context();
    expect(await step.fn(ctx)).toEqual(ok(ctx));
  });

  it("rejects a step without a describe() entry", () => {
    const r = new StepRegistry();
    expect(() => r.register("a/x", "a", { s: pass })).toThrow(/\[a\/x\] step "a\.s" has no describe\(\) entry/);
  });

  it("rejects a function describe() entry for a step that takes no argument", () => {
    const r = new StepRegistry();
    expect(() => r.register("a/x", "a", { s: pass }, { s: () => flat("s") })).toThrow(/its describe\(\) entry is a function/);
  });

  it("accepts reads and writes that follow the path grammar", () => {
    const r = new StepRegistry();
    r.register("a/x", "a", { s: pass }, { s: { summary: "s", reads: ["payload.id", "result.items", "identity"], writes: ["result.llms", "identity?", "params.slug-2"] } });
    expect(r.resolve("a.s").description.writes).toEqual(["result.llms", "identity?", "params.slug-2"]);
  });

  it("rejects an invalid write path naming module and step", () => {
    const r = new StepRegistry();
    expect(() => r.register("a/x", "a", { s: pass }, { s: { summary: "s", reads: [], writes: ["result..id"] } })).toThrow(/\[a\/x\] step "a\.s" declares an invalid write path "result\.\.id"/);
    expect(() => r.register("b/x", "b", { s: pass }, { s: { summary: "s", reads: [], writes: ["1result"] } })).toThrow(/invalid write path "1result"/);
  });

  it("rejects an invalid read path and a trailing ? in reads", () => {
    const r = new StepRegistry();
    expect(() => r.register("a/x", "a", { s: pass }, { s: { summary: "s", reads: ["result identity"], writes: [] } })).toThrow(/invalid read path "result identity"/);
    expect(() => r.register("b/x", "b", { s: pass }, { s: { summary: "s", reads: ["identity?"], writes: [] } })).toThrow(/step "b\.s" reads "identity\?"; the trailing "\?" is allowed in writes only/);
  });

  it("checks the path grammar of a factory description when it is built", () => {
    const r = new StepRegistry();
    r.register("a/x", "a", { withArg: stepFactory((arg: string) => async (ctx: Context) => ok({ ...ctx, result: arg })) }, { withArg: (arg) => ({ summary: arg, reads: [`payload.${arg}!`], writes: [] }) });
    expect(() => r.resolve("a.withArg:pages", "pipelines/p")).toThrow(/\[a\/x\] step "a\.withArg:pages" declares an invalid read path "payload\.pages!"/);
  });
});
