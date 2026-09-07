import type { ContextInput, Step, StepFactory } from "../context.ts";
import type { PipelineDefinition } from "../definePipeline.ts";
import { silentLogger, type Logger } from "../logger.ts";
import { StepRegistry } from "../registry.ts";
import { runPipeline as execute, type RunResult } from "../runner.ts";

export interface RunPipelineOptions {
  steps: Record<string, Step | StepFactory>;
  logger?: Logger;
}

export function runPipeline(pipeline: PipelineDefinition, input: Partial<ContextInput>, options: RunPipelineOptions): Promise<RunResult> {
  const registry = new StepRegistry();
  const byPrefix = new Map<string, Record<string, Step | StepFactory>>();
  for (const [name, fn] of Object.entries(options.steps)) {
    const dot = name.indexOf(".");
    if (dot === -1) throw new Error(`fake step "${name}" must be named "<module>.<step>"`);
    const prefix = name.slice(0, dot);
    const group = byPrefix.get(prefix) ?? {};
    group[name.slice(dot + 1)] = fn;
    byPrefix.set(prefix, group);
  }
  for (const [prefix, group] of byPrefix) {
    const descriptions = Object.fromEntries(Object.keys(group).map((key) => [key, { summary: `${prefix}.${key}`, reads: [], writes: ["result"] }]));
    registry.register("test", prefix, group, descriptions);
  }

  const resolved = { name: pipeline.name, steps: pipeline.steps.map((s) => registry.resolve(s, `pipelines/${pipeline.name}`)) };
  return execute(resolved, { trigger: { kind: "http", name: "test" }, ...input }, options.logger ?? silentLogger);
}
