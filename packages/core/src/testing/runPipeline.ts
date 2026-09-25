import type { ContextInput, Step, StepFactory } from "../context.ts";
import type { AtomicScope } from "../atomic.ts";
import { stepPrefix, type ModuleDefinition } from "../defineModule.ts";
import type { PipelineDefinition } from "../definePipeline.ts";
import { resolveEntries } from "../resolveEntries.ts";
import { silentLogger, type Logger } from "../logger.ts";
import { StepRegistry } from "../registry.ts";
import { runPipeline as execute, type RunResult } from "../runner.ts";

export interface ModuleUnderTest {
  module: ModuleDefinition;
  instance: unknown;
}

export interface RunPipelineOptions {
  steps?: Record<string, Step | StepFactory>;
  writes?: Record<string, readonly string[]>;
  modules?: readonly ModuleUnderTest[];
  logger?: Logger;
  /** Wraps an atomic group in one all-or-nothing scope; no default, so a default cannot invert the core's dependency on the contracts package. A test whose pipeline has a group must pass one, e.g. `fake.scope`. */
  atomicScope?: AtomicScope;
}

/** Runs a pipeline through the real runner: `steps` are stand-ins registered with a bare description, `modules` register a module's own steps and `describe()` against a prepared instance, so their input and query schemas apply. Without `options.logger`, a step that throws answers `<pipeline>/<step>: <message>` instead of the runner's `unexpected <ErrorName>`, so a failing test names the cause; with one, the message goes to that logger. */
export function runPipeline(pipeline: PipelineDefinition, input: Partial<ContextInput>, options: RunPipelineOptions): Promise<RunResult> {
  const registry = new StepRegistry();
  for (const { module, instance } of options.modules ?? []) {
    if (!module.steps) throw new Error(`module "${module.name}" registers no steps`);
    registry.register(module.name, stepPrefix(module.name), module.steps(instance), module.describe?.(instance) ?? {});
  }
  const byPrefix = new Map<string, Record<string, Step | StepFactory>>();
  for (const [name, fn] of Object.entries(options.steps ?? {})) {
    const dot = name.indexOf(".");
    if (dot === -1) throw new Error(`fake step "${name}" must be named "<module>.<step>"`);
    const prefix = name.slice(0, dot);
    const group = byPrefix.get(prefix) ?? {};
    group[name.slice(dot + 1)] = fn;
    byPrefix.set(prefix, group);
  }
  for (const [prefix, group] of byPrefix) {
    const descriptions = Object.fromEntries(Object.keys(group).map((key) => [key, { summary: `${prefix}.${key}`, reads: [], writes: options.writes?.[`${prefix}.${key}`] ?? ["result?"] }]));
    registry.register("test", prefix, group, descriptions);
  }

  const resolved = { name: pipeline.name, steps: resolveEntries(pipeline.steps, (s) => registry.resolve(s, `pipelines/${pipeline.name}`)) };
  const thrown = new Map<string, string>();
  const logger: Logger = options.logger ?? {
    ...silentLogger,
    error(_message, data) {
      if (typeof data?.runId === "string" && typeof data.message === "string") thrown.set(data.runId, data.message);
    },
  };
  const run = execute(resolved, { trigger: { kind: "http", name: "test" }, ...input }, logger, {}, {
    validateOutput: true,
    ...(options.atomicScope === undefined ? {} : { atomicScope: options.atomicScope }),
  });
  return run.then((result) => {
    const message = thrown.get(result.runId);
    if (message === undefined || result.code !== "INTERNAL" || result.step === undefined) return result;
    return { ...result, error: `${pipeline.name}/${result.step}: ${message}` };
  });
}
