import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { StepCatalogue, StepsOf } from "./catalogue.ts";
import { stepFactory, type Context } from "./context.ts";
import { defineModule, type ModuleDefinition, type StepDescription } from "./defineModule.ts";
import { definePipeline, pipelineDefiner } from "./definePipeline.ts";
import { ok } from "./result.ts";

const empty = z.object({});
const pass = async (ctx: Context) => ok(ctx);
const arg = stepFactory((value: string) => async (ctx: Context) => ok({ ...ctx, result: value }));
const flat = (summary: string): StepDescription => ({ summary, reads: [], writes: [] });

const authn = defineModule({
  name: "authn/single",
  provides: [],
  requires: [],
  configSchema: empty,
  setup: async () => ({}),
  steps: () => ({ login: pass, requireUser: pass }),
  describe: () => ({ login: flat("login"), requireUser: flat("requireUser") }),
});

const authz = defineModule({
  name: "authz/roles",
  provides: [],
  requires: [],
  configSchema: empty,
  setup: async () => ({}),
  steps: () => ({ require: arg }),
  describe: () => ({ require: (permission: string) => flat(`require ${permission}`) }),
});

const stepless = defineModule({
  name: "blobstore/filesystem",
  provides: [],
  requires: [],
  configSchema: empty,
  setup: async () => ({}),
});

const modules = [authn, authz, stepless] as const;

type Known = StepCatalogue<typeof modules>;
type Equals<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type CatalogueIsExact = Expect<Equals<Known, "authn.login" | "authn.requireUser" | `authz.require:${string}`>>;
type SingleModule = Expect<Equals<StepsOf<typeof authz>, `authz.require:${string}`>>;
type SteplessModuleAddsNothing = Expect<Equals<StepsOf<typeof stepless>, never>>;
type WidensToBareDefinition = Expect<Equals<typeof authn extends ModuleDefinition ? true : false, true>>;

export type Assertions = [CatalogueIsExact, SingleModule, SteplessModuleAddsNothing, WidensToBareDefinition];

const definePipelineFor = pipelineDefiner<Known>();

describe("step catalogue", () => {
  it("is derived from the module list handed to boot()", () => {
    expect(modules.map((m) => m.name)).toEqual(["authn/single", "authz/roles", "blobstore/filesystem"]);
  });

  it("accepts every registered step name, factories with an argument", () => {
    const pipeline = definePipelineFor({ name: "login", steps: ["authn.login", "authn.requireUser", "authz.require:pages.write"] });
    expect(pipeline.steps).toEqual(["authn.login", "authn.requireUser", "authz.require:pages.write"]);
  });

  it("rejects a typo in a step name", () => {
    // @ts-expect-error "authn.requireUsr" is not in the catalogue
    const pipeline = definePipelineFor({ name: "typo", steps: ["authn.requireUsr"] });
    expect(pipeline.steps).toEqual(["authn.requireUsr"]);
  });

  it("rejects a step of a module that is not loaded", () => {
    // @ts-expect-error "content/default" is not part of `modules`
    const pipeline = definePipelineFor({ name: "unloaded", steps: ["content.create:pages"] });
    expect(pipeline.steps).toEqual(["content.create:pages"]);
  });

  it("rejects a factory step without an argument and a plain step with one", () => {
    // @ts-expect-error a factory step needs ":<arg>"
    definePipelineFor({ name: "no-arg", steps: ["authz.require"] });
    // @ts-expect-error a plain step takes no argument
    definePipelineFor({ name: "extra-arg", steps: ["authn.login:x"] });
    expect(true).toBe(true);
  });

  it("leaves the unbound definePipeline open to any string", () => {
    expect(definePipeline({ name: "free", steps: ["anything.at.all"] }).name).toBe("free");
  });
});

describe("defineModule step typing", () => {
  it("keeps steps and describe in sync at the type level", () => {
    // @ts-expect-error steps without describe
    defineModule({ name: "broken/nodescribe", provides: [], requires: [], configSchema: empty, setup: async () => ({}), steps: () => ({ s: pass }) });
    // @ts-expect-error describe() is missing the "b" entry
    defineModule({ name: "broken/missing", provides: [], requires: [], configSchema: empty, setup: async () => ({}), steps: () => ({ a: pass, b: pass }), describe: () => ({ a: flat("a") }) });
    // @ts-expect-error a factory step needs a description function
    defineModule({ name: "broken/factory", provides: [], requires: [], configSchema: empty, setup: async () => ({}), steps: () => ({ a: arg }), describe: () => ({ a: flat("a") }) });
    // @ts-expect-error summary, reads and writes are required
    defineModule({ name: "broken/summary", provides: [], requires: [], configSchema: empty, setup: async () => ({}), steps: () => ({ a: pass }), describe: () => ({ a: { summary: "a" } }) });
    expect(authn.name).toBe("authn/single");
  });
});
