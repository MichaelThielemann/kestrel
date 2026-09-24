import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, checkBoot, type BootInput } from "./boot.ts";
import { boundaryCast } from "./cast.ts";
import { stepFactory, type Context } from "./context.ts";
import { defineContract } from "./defineContract.ts";
import type { KestrelConfigInput } from "./defineConfig.ts";
import type { ModuleDefinition } from "./defineModule.ts";
import { definePipeline, type PipelineDefinition } from "./definePipeline.ts";
import type { BootErrorCode } from "./errors.ts";
import { KestrelBootError } from "./errors.ts";
import { silentLogger } from "./logger.ts";
import { ok } from "./result.ts";

function simpleModule(name: string, overrides: Partial<ModuleDefinition> = {}): ModuleDefinition {
  return {
    name,
    provides: [],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return {};
    },
    ...overrides,
  };
}

const A = defineContract<{ a(): void }>()("a@1", ["a"]);
const B = defineContract<{ b(): void }>()("b@1", ["b"]);

interface BootCase {
  code: BootErrorCode;
  build: () => BootInput;
}

const cases: BootCase[] = [
  {
    code: "invalid-config",
    build: () => ({ config: boundaryCast<KestrelConfigInput>({ modules: "not-an-array" }, "host"), modules: [], pipelines: [], logger: silentLogger }),
  },
  {
    code: "module-count",
    build: () => ({ config: { modules: [], triggers: [] }, modules: [simpleModule("solo/one")], pipelines: [], logger: silentLogger }),
  },
  {
    code: "module-listed-twice",
    build: () => {
      const dup = simpleModule("dup/one");
      return { config: { modules: [{ use: "./dup-one" }, { use: "./dup-one" }], triggers: [] }, modules: [dup, dup], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "module-entry-mismatch",
    build: () => {
      const modA = simpleModule("foo/a");
      const modB = simpleModule("bar/b");
      return { config: { modules: [{ use: "./bar-b" }, { use: "./foo-a" }], triggers: [] }, modules: [modA, modB], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "contract-provided-twice",
    build: () => {
      const first = simpleModule("a/one", { provides: [A] });
      const second = simpleModule("a/two", { provides: [A] });
      return { config: { modules: [{ use: "./a-one" }, { use: "./a-two" }], triggers: [] }, modules: [first, second], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "before-and-requires",
    build: () => {
      const mod = simpleModule("a/one", { requires: [A], before: [A] });
      const provider = simpleModule("a/provider", { provides: [A] });
      return { config: { modules: [{ use: "./a-one" }, { use: "./a-provider" }], triggers: [] }, modules: [mod, provider], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "missing-provider",
    build: () => {
      const consumer = simpleModule("a/consumer", { requires: [A] });
      return { config: { modules: [{ use: "./a-consumer" }], triggers: [] }, modules: [consumer], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "provides-itself",
    build: () => {
      const mod = simpleModule("a/one", { provides: [A], requires: [A] });
      return { config: { modules: [{ use: "./a-one" }], triggers: [] }, modules: [mod], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "dependency-cycle",
    build: () => {
      const modA = simpleModule("a/one", { provides: [A], requires: [B] });
      const modB = simpleModule("b/one", { provides: [B], requires: [A] });
      return { config: { modules: [{ use: "./a-one" }, { use: "./b-one" }], triggers: [] }, modules: [modA, modB], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "module-name-contract",
    build: () => {
      const mod = simpleModule("mismatch/name", { provides: [A] });
      return { config: { modules: [{ use: "./mismatch-name" }], triggers: [] }, modules: [mod], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "invalid-module-config",
    build: () => {
      const mod = simpleModule("strict/one", { configSchema: z.object({ file: z.string() }).strict() });
      return { config: { modules: [{ use: "./strict-one", config: { file: 42 } }], triggers: [] }, modules: [mod], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "setup-failed",
    build: () => {
      const mod = simpleModule("throwing/one", {
        async setup() {
          throw new Error("boom");
        },
      });
      return { config: { modules: [{ use: "./throwing-one" }], triggers: [] }, modules: [mod], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "missing-methods",
    build: () => {
      const mod = simpleModule("a/one", {
        provides: [A],
        async setup() {
          return {};
        },
      });
      return { config: { modules: [{ use: "./a-one" }], triggers: [] }, modules: [mod], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "invalid-read-path",
    build: () => {
      const mod: ModuleDefinition = {
        name: "bad/reads",
        provides: [],
        requires: [],
        configSchema: z.object({}).strict(),
        async setup() {
          return {};
        },
        steps: () => ({ go: async (ctx: Context) => ok(ctx) }),
        describe: () => ({ go: { summary: "x", reads: ["1bad"], writes: [] } }),
      };
      return { config: { modules: [{ use: "./bad-reads" }], triggers: [] }, modules: [mod], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "invalid-write-path",
    build: () => {
      const mod: ModuleDefinition = {
        name: "bad/writes",
        provides: [],
        requires: [],
        configSchema: z.object({}).strict(),
        async setup() {
          return {};
        },
        steps: () => ({ go: async (ctx: Context) => ok(ctx) }),
        describe: () => ({ go: { summary: "x", reads: [], writes: ["1bad"] } }),
      };
      return { config: { modules: [{ use: "./bad-writes" }], triggers: [] }, modules: [mod], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "step-not-function",
    build: () => {
      const mod: ModuleDefinition = {
        name: "bad/step",
        provides: [],
        requires: [],
        configSchema: z.object({}).strict(),
        async setup() {
          return {};
        },
        steps: () => boundaryCast({ go: "not a function" }, "host"),
      };
      return { config: { modules: [{ use: "./bad-step" }], triggers: [] }, modules: [mod], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "step-registered-twice",
    build: () => {
      const first = simpleModule("dup/a", { steps: () => ({ go: async (ctx: Context) => ok(ctx) }), describe: () => ({ go: { summary: "x", reads: [], writes: [] } }) });
      const second = simpleModule("dup/b", { steps: () => ({ go: async (ctx: Context) => ok(ctx) }), describe: () => ({ go: { summary: "y", reads: [], writes: [] } }) });
      return { config: { modules: [{ use: "./dup-a" }, { use: "./dup-b" }], triggers: [] }, modules: [first, second], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "step-undescribed",
    build: () => {
      const mod: ModuleDefinition = {
        name: "undescribed/one",
        provides: [],
        requires: [],
        configSchema: z.object({}).strict(),
        async setup() {
          return {};
        },
        steps: () => ({ go: async (ctx: Context) => ok(ctx) }),
        describe: () => ({}),
      };
      return { config: { modules: [{ use: "./undescribed-one" }], triggers: [] }, modules: [mod], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "describe-shape",
    build: () => {
      const mod = simpleModule("bad/shape", {
        steps: () => ({ go: async (ctx: Context) => ok(ctx) }),
        describe: () => ({ go: () => ({ summary: "x", reads: [], writes: [] }) }),
      });
      return { config: { modules: [{ use: "./bad-shape" }], triggers: [] }, modules: [mod], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "describe-threw",
    build: () => {
      const go = stepFactory((arg: string) => async (ctx: Context) => ok({ ...ctx, result: arg }));
      const mod = simpleModule("throwing/describe", {
        steps: () => ({ go }),
        describe: () => ({
          go: () => {
            throw new Error("describe boom");
          },
        }),
      });
      return { config: { modules: [{ use: "./throwing-describe" }], triggers: [] }, modules: [mod], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "describe-unknown-step",
    build: () => {
      const mod = simpleModule("extra/describe", {
        steps: () => ({ go: async (ctx: Context) => ok(ctx) }),
        describe: () => ({ go: { summary: "x", reads: [], writes: [] }, ghost: { summary: "y", reads: [], writes: [] } }),
      });
      return { config: { modules: [{ use: "./extra-describe" }], triggers: [] }, modules: [mod], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "pipeline-defined-twice",
    build: () => {
      const mod = simpleModule("noop/one", { steps: () => ({ go: async (ctx: Context) => ok(ctx) }), describe: () => ({ go: { summary: "x", reads: [], writes: [] } }) });
      const p1 = definePipeline({ name: "dup", steps: ["noop.go"] });
      const p2 = definePipeline({ name: "dup", steps: ["noop.go"] });
      return { config: { modules: [{ use: "./noop-one" }], triggers: [] }, modules: [mod], pipelines: [p1, p2], logger: silentLogger };
    },
  },
  {
    code: "pipeline-empty",
    build: () => {
      const p: PipelineDefinition = { name: "empty", steps: [] };
      return { config: { modules: [], triggers: [] }, modules: [], pipelines: [p], logger: silentLogger };
    },
  },
  {
    code: "unknown-step",
    build: () => {
      const p = definePipeline({ name: "usesUnknown", steps: ["nope.step"] });
      return { config: { modules: [], triggers: [] }, modules: [], pipelines: [p], logger: silentLogger };
    },
  },
  {
    code: "step-argument",
    build: () => {
      const go = stepFactory((arg: string) => async (ctx: Context) => ok({ ...ctx, result: arg }));
      const mod = simpleModule("factory/one", { steps: () => ({ go }), describe: () => ({ go: () => ({ summary: "x", reads: [], writes: [] }) }) });
      const p = definePipeline({ name: "noArg", steps: ["factory.go"] });
      return { config: { modules: [{ use: "./factory-one" }], triggers: [] }, modules: [mod], pipelines: [p], logger: silentLogger };
    },
  },
  {
    code: "atomic-unsafe-step",
    build: () => {
      const scopeMod = simpleModule("scope/one", { atomicScope: async (_instance, _info, body) => ({ kind: "settled", verdict: await body() }) });
      const mod = simpleModule("unsafe/one", { steps: () => ({ go: async (ctx: Context) => ok(ctx) }), describe: () => ({ go: { summary: "x", reads: [], writes: [] } }) });
      const p = definePipeline({ name: "grouped", steps: [{ atomic: ["unsafe.go"] }] });
      return { config: { modules: [{ use: "./scope-one" }, { use: "./unsafe-one" }], triggers: [] }, modules: [scopeMod, mod], pipelines: [p], logger: silentLogger };
    },
  },
  {
    code: "svg-without-sanitizer",
    build: () => ({ config: { modules: [], triggers: [], http: { inlineTypes: ["image/svg+xml"] } }, modules: [], pipelines: [], logger: silentLogger }),
  },
  {
    code: "invalid-allowlist",
    build: () => ({ config: { modules: [], triggers: [], http: { allow: ["not-an-ip"] } }, modules: [], pipelines: [], logger: silentLogger }),
  },
  {
    code: "unknown-trigger-pipeline",
    build: () => ({ config: { modules: [], triggers: [{ http: "GET /x", pipeline: "ghost" }] }, modules: [], pipelines: [], logger: silentLogger }),
  },
  {
    code: "invalid-trigger",
    build: () => {
      const mod = simpleModule("noop/one", { steps: () => ({ go: async (ctx: Context) => ok(ctx) }), describe: () => ({ go: { summary: "x", reads: [], writes: [] } }) });
      const p = definePipeline({ name: "wild", steps: ["noop.go"] });
      return { config: { modules: [{ use: "./noop-one" }], triggers: [{ http: "GET /a/*/b", pipeline: "wild" }] }, modules: [mod], pipelines: [p], logger: silentLogger };
    },
  },
  {
    code: "duplicate-route",
    build: () => {
      const mod = simpleModule("noop/one", { steps: () => ({ go: async (ctx: Context) => ok(ctx) }), describe: () => ({ go: { summary: "x", reads: [], writes: [] } }) });
      const p1 = definePipeline({ name: "routeA", steps: ["noop.go"] });
      const p2 = definePipeline({ name: "routeB", steps: ["noop.go"] });
      return {
        config: { modules: [{ use: "./noop-one" }], triggers: [{ http: "GET /dup", pipeline: "routeA" }, { http: "GET /dup", pipeline: "routeB" }] },
        modules: [mod],
        pipelines: [p1, p2],
        logger: silentLogger,
      };
    },
  },
  {
    code: "unsatisfied-read",
    build: () => {
      const mod = simpleModule("reader/one", { steps: () => ({ go: async (ctx: Context) => ok(ctx) }), describe: () => ({ go: { summary: "x", reads: ["missingKey"], writes: [] } }) });
      const p = definePipeline({ name: "reads", steps: ["reader.go"] });
      return { config: { modules: [{ use: "./reader-one" }], triggers: [] }, modules: [mod], pipelines: [p], logger: silentLogger };
    },
  },
  {
    code: "optional-read-order",
    build: () => {
      const mod = simpleModule("readwrite/one", {
        steps: () => ({
          early: async (ctx: Context) => ok(ctx),
          late: async (ctx: Context) => ok(ctx),
        }),
        describe: () => ({
          early: { summary: "x", reads: ["late?"], writes: [] },
          late: { summary: "y", reads: [], writes: ["late"] },
        }),
      });
      const p = definePipeline({ name: "order", steps: ["readwrite.early", "readwrite.late"] });
      return { config: { modules: [{ use: "./readwrite-one" }], triggers: [] }, modules: [mod], pipelines: [p], logger: silentLogger };
    },
  },
  {
    code: "event-hooks-twice",
    build: () => {
      const hookA = simpleModule("hook/a", { triggers: { event: () => () => {} } });
      const hookB = simpleModule("hook/b", { triggers: { event: () => () => {} } });
      return { config: { modules: [{ use: "./hook-a" }, { use: "./hook-b" }], triggers: [] }, modules: [hookA, hookB], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "event-hook-missing",
    build: () => {
      const mod = simpleModule("noop/one", { steps: () => ({ go: async (ctx: Context) => ok(ctx) }), describe: () => ({ go: { summary: "x", reads: [], writes: [] } }) });
      const p = definePipeline({ name: "onEvent", steps: ["noop.go"] });
      return { config: { modules: [{ use: "./noop-one" }], triggers: [{ event: "x", pipeline: "onEvent" }] }, modules: [mod], pipelines: [p], logger: silentLogger };
    },
  },
  {
    code: "atomic-scope-twice",
    build: () => {
      const scopeA = simpleModule("scope/a", { atomicScope: async (_instance, _info, body) => ({ kind: "settled", verdict: await body() }) });
      const scopeB = simpleModule("scope/b", { atomicScope: async (_instance, _info, body) => ({ kind: "settled", verdict: await body() }) });
      return { config: { modules: [{ use: "./scope-a" }, { use: "./scope-b" }], triggers: [] }, modules: [scopeA, scopeB], pipelines: [], logger: silentLogger };
    },
  },
  {
    code: "atomic-scope-missing",
    build: () => {
      const mod = simpleModule("unsafe/one", { steps: () => ({ go: async (ctx: Context) => ok(ctx) }), describe: () => ({ go: { summary: "x", reads: [], writes: [], atomicSafe: true } }) });
      const p = definePipeline({ name: "grouped", steps: [{ atomic: ["unsafe.go"] }] });
      return { config: { modules: [{ use: "./unsafe-one" }], triggers: [] }, modules: [mod], pipelines: [p], logger: silentLogger };
    },
  },
  {
    code: "undeclared-output",
    build: () => {
      const mod = simpleModule("writer/one", { steps: () => ({ go: async (ctx: Context) => ok({ ...ctx, result: "x" }) }), describe: () => ({ go: { summary: "x", reads: [], writes: ["result"] } }) });
      const p = definePipeline({ name: "writes", steps: ["writer.go"] });
      return { config: { modules: [{ use: "./writer-one" }], triggers: [] }, modules: [mod], pipelines: [p], logger: silentLogger };
    },
  },
  {
    code: "undeclared-required",
    build: () => {
      const mod = simpleModule("writer/one", {
        steps: () => ({ go: async (ctx: Context) => ok({ ...ctx, result: { id: "x" } }) }),
        describe: () => ({ go: { summary: "x", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } } } } }),
      });
      const p = definePipeline({ name: "writes", steps: ["writer.go"] });
      return { config: { modules: [{ use: "./writer-one" }], triggers: [] }, modules: [mod], pipelines: [p], logger: silentLogger };
    },
  },
  {
    code: "output-fold-contradiction",
    build: () => {
      const mod = simpleModule("writer/one", {
        steps: () => ({ go: async (ctx: Context) => ok({ ...ctx, result: "x" }) }),
        describe: () => ({ go: { summary: "x", reads: [], writes: ["result"], extendsOutput: { type: "string" } } }),
      });
      const p = definePipeline({ name: "writes", steps: ["writer.go"] });
      return { config: { modules: [{ use: "./writer-one" }], triggers: [] }, modules: [mod], pipelines: [p], logger: silentLogger };
    },
  },
  {
    code: "terminal-output-misplaced",
    build: () => {
      const mod = simpleModule("noop/one", {
        steps: () => ({ go: async (ctx: Context) => ok(ctx) }),
        describe: () => ({ go: { summary: "x", reads: [], writes: [], terminalOutput: { type: "string" } } }),
      });
      const p = definePipeline({ name: "noWrite", steps: ["noop.go"] });
      return { config: { modules: [{ use: "./noop-one" }], triggers: [] }, modules: [mod], pipelines: [p], logger: silentLogger };
    },
  },
  {
    code: "attach-failed",
    build: () => {
      const mod = simpleModule("attaching/one", {
        attach: () => {
          throw new Error("attach boom");
        },
      });
      return { config: { modules: [{ use: "./attaching-one" }], triggers: [] }, modules: [mod], pipelines: [], logger: silentLogger };
    },
  },
];

describe("bootCases: every sink-reachable BootErrorCode, pinned and checked for parity", () => {
  it("covers exactly the 42 codes the sink can report", () => {
    const seen = new Set(cases.map((c) => c.code));
    expect(seen.size).toBe(cases.length);
    expect(cases.length).toBe(42);
  });

  for (const { code, build } of cases) {
    it(`${code}: checkBoot reports it, and boot() throws with the same code`, async () => {
      const check = await checkBoot(build(), { setup: "all" });
      expect(check.errors.map((e) => e.code)).toContain(code);

      await expect(boot(build())).rejects.toThrow(KestrelBootError);
      try {
        await boot(build());
        expect.unreachable("boot() should have thrown");
      } catch (err) {
        if (!(err instanceof KestrelBootError)) throw err;
        expect(err.code).toBe(code);
      }
    });
  }
});
