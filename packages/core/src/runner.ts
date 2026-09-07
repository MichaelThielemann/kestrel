import { randomUUID } from "node:crypto";
import { createContext, DONE, type Context, type ContextInput } from "./context.ts";
import type { Logger, StepLog } from "./logger.ts";
import type { ResolvedStep } from "./registry.ts";
import { failure, isKestrelError, type KestrelError } from "./errors.ts";
import type { JsonSchema } from "./defineModule.ts";
import { isErr, type Result } from "./result.ts";
import { validateSchema } from "./schema.ts";

export interface ResolvedPipeline {
  name: string;
  steps: readonly ResolvedStep[];
}

export interface RunResult {
  runId: string;
  requestId?: string;
  status: number;
  result?: unknown;
  error?: string;
  code?: string;
  retryable?: boolean;
  step?: string;
  details?: Record<string, unknown>;
}

export type Runner = (pipeline: string, input: ContextInput) => Promise<RunResult>;

export interface RunOptions {
  validateInput: boolean;
}

export interface RunTracker {
  track<T>(fn: () => Promise<T>): Promise<T>;
  active(): number;
  drain(timeoutMs: number): Promise<boolean>;
}

export function createRunTracker(): RunTracker {
  let active = 0;
  const idle = new Set<() => void>();
  return {
    async track(fn) {
      active++;
      try {
        return await fn();
      } finally {
        active--;
        if (active === 0) for (const resolve of [...idle]) resolve();
      }
    },
    active: () => active,
    drain(timeoutMs) {
      if (active === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const onIdle = () => {
          clearTimeout(timer);
          idle.delete(onIdle);
          resolve(true);
        };
        const timer = setTimeout(() => {
          idle.delete(onIdle);
          resolve(false);
        }, Math.max(0, timeoutMs));
        timer.unref();
        idle.add(onIdle);
      });
    },
  };
}

function isResult(value: unknown): value is Result<unknown, KestrelError> {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Result<unknown, KestrelError>;
  if (result.ok === true) return "value" in result;
  return result.ok === false && isKestrelError(result.error);
}

function isContext(value: unknown): value is Context {
  if (typeof value !== "object" || value === null) return false;
  const ctx = value as Context;
  const record = (v: unknown): boolean => typeof v === "object" && v !== null;
  return record(ctx.trigger) && record(ctx.payload) && record(ctx.params) && record(ctx.headers) && Array.isArray(ctx.files) && typeof ctx.fail === "function" && typeof ctx.done === "function";
}

// Query parameters are merged into the payload by the HTTP trigger, so an `additionalProperties:
// false` input schema has to accept them too.
function payloadSchema(description: ResolvedStep["description"]): JsonSchema | undefined {
  const input = description.input;
  if (input === undefined) return undefined;
  if (description.query === undefined) return input;
  const properties = typeof input.properties === "object" && input.properties !== null ? (input.properties as Record<string, unknown>) : {};
  return { ...input, properties: { ...properties, ...description.query } };
}

export async function runPipeline(pipeline: ResolvedPipeline, input: ContextInput, logger: Logger, options: RunOptions = { validateInput: false }): Promise<RunResult> {
  const runId = randomUUID();
  let ctx = createContext(input, runId);
  const requestId = ctx.requestId;
  const trace = (result: RunResult): RunResult => (requestId === undefined ? result : { ...result, requestId });

  for (const step of pipeline.steps) {
    const started = performance.now();
    const log = (outcome: StepLog["outcome"]) =>
      logger.step({
        runId,
        ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
        pipeline: pipeline.name,
        step: step.name,
        ms: Math.round((performance.now() - started) * 100) / 100,
        outcome,
      });
    if (options.validateInput) {
      const schema = payloadSchema(step.description);
      const problem = schema === undefined ? undefined : validateSchema(schema, ctx.payload)[0];
      if (problem !== undefined) {
        log("error");
        const error = failure("INTERNAL", `dev: payload of step "${step.name}" in pipeline "${pipeline.name}" does not match describe().input at ${problem.path}: ${problem.message}`);
        return trace({ runId, status: error.status, error: error.message, code: error.code, retryable: error.retryable, step: step.name });
      }
    }
    try {
      const out: unknown = await step.fn(ctx);
      if (!isResult(out)) {
        throw new Error(`step "${step.name}" returned ${typeof out} instead of a Result<Context>`);
      }
      if (isErr(out)) {
        const error = out.error;
        log(`fail(${error.code})`);
        if (error.cause !== undefined) {
          const cause = error.cause instanceof Error ? { stack: error.cause.stack ?? error.cause.message } : { cause: error.cause };
          logger.error(`pipeline "${pipeline.name}" step "${step.name}" failed with a cause`, { runId, code: error.code, ...cause });
        }
        return trace({
          runId,
          status: error.status,
          error: error.message,
          code: error.code,
          retryable: error.retryable,
          step: step.name,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
      }
      if (!isContext(out.value)) {
        throw new Error(`step "${step.name}" returned ${typeof out.value} instead of a Result<Context>`);
      }
      ctx = Object.freeze(out.value);
      log("ok");
      if (Reflect.get(ctx, DONE) === true) return trace({ runId, status: 200, result: ctx.result });
    } catch (thrown) {
      log("error");
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      logger.error(`pipeline "${pipeline.name}" step "${step.name}" threw`, { runId, stack: error.stack ?? error.message });
      return trace({ runId, status: 500, error: `${pipeline.name}/${step.name}: ${error.message}`, code: "INTERNAL", retryable: false, step: step.name });
    }
  }

  const done: RunResult = { runId, status: 200 };
  if (ctx.result !== undefined) done.result = ctx.result;
  return trace(done);
}
