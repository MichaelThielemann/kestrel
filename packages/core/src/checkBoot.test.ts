import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { boot, checkBoot, type BootInput } from "./boot.ts";
import type { Context } from "./context.ts";
import { defineContract } from "./defineContract.ts";
import { defineModule, type ModuleDefinition } from "./defineModule.ts";
import { definePipeline } from "./definePipeline.ts";
import { KestrelBootError } from "./errors.ts";
import { silentLogger } from "./logger.ts";
import { ok } from "./result.ts";

const GOOD = defineContract<{ ping(): string }>()("good@1", ["ping"]);
const MISSING = defineContract<{ x(): void }>()("missing@1", ["x"]);

function goodProvider() {
  return defineModule({
    name: "good/store",
    provides: [GOOD],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return { ping: () => "pong" };
    },
    steps: () => ({
      create: async (ctx: Context) => ok({ ...ctx, result: { id: "x" } }),
      readFoo: async (ctx: Context) => ok(ctx),
      ping: async (ctx: Context) => ok({ ...ctx, result: "pong" }),
    }),
    describe: () => ({
      create: { summary: "create without a declared output", reads: [], writes: ["result"] },
      readFoo: { summary: "reads foo; nothing writes it", reads: ["foo"], writes: [] },
      ping: { summary: "a clean step", reads: [], writes: ["result"], output: { type: "string" } },
    }),
  });
}

function badModule(name: string) {
  return defineModule({
    name,
    provides: [],
    requires: [],
    configSchema: z.object({ file: z.string() }).strict(),
    async setup() {
      return {};
    },
  });
}

function orphanModule() {
  return defineModule({
    name: "orphan/consumer",
    provides: [],
    requires: [MISSING],
    configSchema: z.object({}).strict(),
    async setup() {
      return {};
    },
  });
}

function sevenProblemsInput(): BootInput {
  const good = goodProvider();
  const badOne = badModule("bad/one");
  const badTwo = badModule("bad/two");
  const orphan = orphanModule();
  const outputPipeline = definePipeline({ name: "outputPipeline", steps: ["good.create"] });
  const readPipeline = definePipeline({ name: "readPipeline", steps: ["good.readFoo"] });
  const unknownPipeline = definePipeline({ name: "unknownPipeline", steps: ["nope.step"] });
  const routeA = definePipeline({ name: "routeA", steps: ["good.ping"] });
  const routeB = definePipeline({ name: "routeB", steps: ["good.ping"] });
  return {
    config: {
      modules: [{ use: "./good-store", config: {} }, { use: "./bad-one", config: { file: 42 } }, { use: "./bad-two", config: { file: 42 } }, { use: "./orphan-consumer", config: {} }],
      triggers: [
        { http: "GET /dup-a", pipeline: "routeA" },
        { http: "GET /dup-a", pipeline: "routeB" },
      ],
      http: { port: 0 },
    },
    modules: [good, badOne, badTwo, orphan],
    pipelines: [outputPipeline, readPipeline, unknownPipeline, routeA, routeB],
    logger: silentLogger,
  };
}

describe("checkBoot: collecting every problem", () => {
  it("finds exactly seven independent problems with no cascade duplicates", async () => {
    const check = await checkBoot(sevenProblemsInput(), { setup: "all" });
    expect(check.errors).toHaveLength(7);
    expect(check.errors.map((e) => e.code).sort()).toEqual(["duplicate-route", "invalid-module-config", "invalid-module-config", "missing-provider", "undeclared-output", "unknown-step", "unsatisfied-read"]);
  });

  it("marks a module excluded by a sort problem, and a pipeline with an unresolved step, as not checked instead of a second error", async () => {
    const check = await checkBoot(sevenProblemsInput(), { setup: "all" });
    expect(check.notChecked).toContainEqual(expect.objectContaining({ kind: "module", name: "orphan/consumer" }));
    expect(check.notChecked).toContainEqual(expect.objectContaining({ kind: "pipeline", name: "unknownPipeline" }));
  });

  it("boot() throws the same problem checkBoot() reports first", async () => {
    const check = await checkBoot(sevenProblemsInput(), { setup: "all" });
    const first = check.errors[0]!;
    await expect(boot(sevenProblemsInput())).rejects.toThrow(new KestrelBootError(first.owner, first.reason, first.code));
  });

  it("a clean boot returns no errors, no warnings and nothing left unchecked", async () => {
    const good = goodProvider();
    const pipeline = definePipeline({ name: "ping", steps: ["good.ping"] });
    const input: BootInput = { config: { modules: [{ use: "./good-store", config: {} }], triggers: [], http: null }, modules: [good], pipelines: [pipeline], logger: silentLogger };
    const check = await checkBoot(input, { setup: "all" });
    expect(check).toEqual({ errors: [], warnings: [], notChecked: [] });
  });

  it("a module requiring a contract from one with an invalid config is not checked either, without a second error", async () => {
    const providerBad = defineModule({
      name: "good/broken",
      provides: [GOOD],
      requires: [],
      configSchema: z.object({ file: z.string() }).strict(),
      async setup() {
        return { ping: () => "pong" };
      },
    });
    const dependent = defineModule({
      name: "dependent/one",
      provides: [],
      requires: [GOOD],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
    });
    const input: BootInput = {
      config: { modules: [{ use: "./good-broken", config: { file: 1 } }, { use: "./dependent-one", config: {} }], triggers: [] },
      modules: [providerBad, dependent],
      pipelines: [],
      logger: silentLogger,
    };
    const check = await checkBoot(input, { setup: "all" });
    expect(check.errors).toHaveLength(1);
    expect(check.errors[0]?.code).toBe("invalid-module-config");
    expect(check.notChecked).toEqual([
      { kind: "module", name: "good/broken", because: "invalid config" },
      { kind: "module", name: "dependent/one", because: 'depends on "good@1" whose provider was not set up' },
    ]);
  });

  it("setup: none runs no module code and reports every module as not checked", async () => {
    const setupSpy = vi.fn(async () => ({ ping: () => "pong" }));
    const good = { ...goodProvider(), setup: setupSpy };
    const pipeline = definePipeline({ name: "ping", steps: ["good.ping"] });
    const input: BootInput = { config: { modules: [{ use: "./good-store", config: {} }], triggers: [], http: null }, modules: [good], pipelines: [pipeline], logger: silentLogger };
    const check = await checkBoot(input, { setup: "none" });
    expect(setupSpy).not.toHaveBeenCalled();
    expect(check.errors).toEqual([]);
    expect(check.notChecked).toContainEqual({ kind: "module", name: "good/store", because: "not selected to run setup()" });
    expect(check.notChecked).toContainEqual(expect.objectContaining({ kind: "pipeline", name: "ping" }));
  });

  it("setup: { only } runs setup() only for the named use entries", async () => {
    const runSpy = vi.fn();
    const good = goodProvider();
    const other = defineModule({
      name: "other/module",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        runSpy();
        return {};
      },
    });
    const input: BootInput = { config: { modules: [{ use: "./good-store", config: {} }, { use: "./other-module", config: {} }], triggers: [], http: null }, modules: [good, other], pipelines: [], logger: silentLogger };
    const check = await checkBoot(input, { setup: { only: ["./good-store"] } });
    expect(runSpy).not.toHaveBeenCalled();
    expect(check.notChecked).toContainEqual({ kind: "module", name: "other/module", because: "not selected to run setup()" });
    expect(check.notChecked).not.toContainEqual(expect.objectContaining({ name: "good/store" }));
  });

  it("never starts a trigger: an event hook is never asked to subscribe", async () => {
    const eventSpy = vi.fn(() => () => {});
    const hookModule = defineModule({
      name: "hook/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({ noop: async (ctx: Context) => ok(ctx) }),
      describe: () => ({ noop: { summary: "no-op", reads: [], writes: [] } }),
      triggers: { event: eventSpy },
    });
    const onEvent = definePipeline({ name: "onEvent", steps: ["hook.noop"] });
    const input: BootInput = {
      config: { modules: [{ use: "./hook-fake", config: {} }], triggers: [{ event: "x", pipeline: "onEvent" }] },
      modules: [hookModule],
      pipelines: [onEvent],
      logger: silentLogger,
    };
    const check = await checkBoot(input, { setup: "all" });
    expect(check.errors).toEqual([]);
    expect(eventSpy).not.toHaveBeenCalled();
  });

  it("tears down every module that was set up, even when a later problem is found", async () => {
    const teardownOne = vi.fn();
    const teardownTwo = vi.fn();
    const first = defineModule({
      name: "clean/one",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      teardown: teardownOne,
    });
    const second = defineModule({
      name: "clean/two",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      teardown: teardownTwo,
    });
    const badPipeline = definePipeline({ name: "broken", steps: ["nope.step"] });
    const input: BootInput = { config: { modules: [{ use: "./clean-one", config: {} }, { use: "./clean-two", config: {} }], triggers: [] }, modules: [first, second], pipelines: [badPipeline], logger: silentLogger };
    const check = await checkBoot(input, { setup: "all" });
    expect(check.errors).toHaveLength(1);
    expect(teardownOne).toHaveBeenCalledTimes(1);
    expect(teardownTwo).toHaveBeenCalledTimes(1);
  });

  it("skips attach() while an error exists, and reports it as not checked", async () => {
    const attachSpy = vi.fn();
    const withAttach = defineModule({
      name: "attach/one",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      attach: attachSpy,
    });
    const badPipeline = definePipeline({ name: "broken", steps: ["nope.step"] });
    const input: BootInput = { config: { modules: [{ use: "./attach-one", config: {} }], triggers: [] }, modules: [withAttach], pipelines: [badPipeline], logger: silentLogger };
    const check = await checkBoot(input, { setup: "all" });
    expect(attachSpy).not.toHaveBeenCalled();
    expect(check.notChecked).toContainEqual({ kind: "attach", name: "attach/one", because: "a boot problem exists, or a module was not set up" });
  });

  it("runs attach() and its detach when the boot is clean, then hands nothing back to keep running", async () => {
    const detach = vi.fn();
    const attachSpy = vi.fn(() => detach);
    const withAttach = defineModule({
      name: "attach/one",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      attach: attachSpy,
    });
    const input: BootInput = { config: { modules: [{ use: "./attach-one", config: {} }], triggers: [], http: null }, modules: [withAttach], pipelines: [], logger: silentLogger };
    const check = await checkBoot(input, { setup: "all" });
    expect(attachSpy).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(check.errors).toEqual([]);
  });

  it("parity: setup() throwing is the same error checkBoot and boot() report", async () => {
    const throwing = defineModule({
      name: "throwing/one",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        throw new Error("cannot connect");
      },
    });
    const build = (): BootInput => ({ config: { modules: [{ use: "./throwing-one", config: {} }], triggers: [] }, modules: [defineModule({ ...throwing })], pipelines: [], logger: silentLogger });
    const check = await checkBoot(build(), { setup: "all" });
    expect(check.errors).toHaveLength(1);
    expect(check.errors[0]).toMatchObject({ code: "setup-failed", owner: "throwing/one" });
    await expect(boot(build())).rejects.toThrow(new KestrelBootError("throwing/one", check.errors[0]!.reason, "setup-failed"));
  });

  it("parity: a step whose describe() is missing produces the same finding in both", async () => {
    const undescribed: ModuleDefinition = {
      name: "undescribed/one",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({ create: async (ctx: Context) => ok(ctx) }),
      describe: () => ({}),
    };
    const build = (): BootInput => ({ config: { modules: [{ use: "./undescribed-one", config: {} }], triggers: [] }, modules: [undescribed], pipelines: [], logger: silentLogger });
    const check = await checkBoot(build(), { setup: "all" });
    expect(check.errors).toHaveLength(1);
    expect(check.errors[0]).toMatchObject({ code: "step-undescribed", owner: "undescribed/one" });
    await expect(boot(build())).rejects.toThrow(new KestrelBootError("undescribed/one", check.errors[0]!.reason, "step-undescribed"));
  });

  it("a hand-built pipeline definition with no steps is reported and left out of further checks", async () => {
    const empty = { name: "empty", steps: [] };
    const input: BootInput = { config: { modules: [], triggers: [] }, modules: [], pipelines: [empty], logger: silentLogger };
    const check = await checkBoot(input, { setup: "all" });
    expect(check.errors).toEqual([expect.objectContaining({ code: "pipeline-empty" })]);
  });
});
