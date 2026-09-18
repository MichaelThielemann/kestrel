import { randomUUID } from "node:crypto";
import { createContext, DONE, type Context, type ContextInput } from "./context.ts";
import type { Logger, StepLog } from "./logger.ts";
import type { RunEndEvent, RunObserver, RunStartEvent, StepStartEvent } from "./observer.ts";
import type { ResolvedStep } from "./registry.ts";
import { failure, isKestrelError, type KestrelError } from "./errors.ts";
import { isErr, type Result } from "./result.ts";
import { coerceQuery, validateSchema, type SchemaProblem } from "./schema.ts";
import { isRecord } from "./guards.ts";

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
  if (!isRecord(value)) return false;
  if (value.ok === true) return "value" in value;
  return value.ok === false && isKestrelError(value.error);
}

function isContext(value: unknown): value is Context {
  if (!isRecord(value)) return false;
  const record = (v: unknown): boolean => typeof v === "object" && v !== null;
  return record(value.trigger) && record(value.payload) && record(value.params) && record(value.headers) && Array.isArray(value.files) && typeof value.fail === "function" && typeof value.done === "function";
}

function writeRoot(path: string): string {
  const dot = path.indexOf(".");
  const root = dot === -1 ? path : path.slice(0, dot);
  return root.endsWith("?") ? root.slice(0, -1) : root;
}

function wrote(after: Context, path: string): boolean {
  let value: unknown = after;
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, segment)) return false;
    value = Reflect.get(value, segment);
  }
  return true;
}

function checkWrites(step: ResolvedStep, before: Context, after: Context): void {
  const declared = step.description.writes;
  const roots = new Set(declared.map(writeRoot));
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (Object.is(Reflect.get(before, key), Reflect.get(after, key))) continue;
    if (!roots.has(key)) throw new Error(`step "${step.name}" writes "${key}" without declaring it`);
  }
  for (const path of declared) {
    if (path.endsWith("?") || wrote(after, path)) continue;
    throw new Error(`step "${step.name}" declares writes "${path}" but did not write it (declare "${path}?" for a conditional write)`);
  }
}

function inputProblems(description: ResolvedStep["description"], ctx: Context): SchemaProblem[] {
  const problems: SchemaProblem[] = description.input === undefined ? [] : validateSchema(description.input, ctx.body);
  const query = description.query;
  if (query !== undefined) {
    const coerced = coerceQuery(query, ctx.query);
    for (const [key, schema] of Object.entries(query)) {
      if (!Object.hasOwn(coerced, key)) continue;
      for (const problem of validateSchema(schema, coerced[key])) problems.push({ path: `$.${key}${problem.path.slice(1)}`, message: problem.message });
    }
  }
  return problems;
}

function runOutcome(result: RunResult, thrown: boolean): RunEndEvent["outcome"] {
  if (thrown) return "error";
  return result.status < 400 ? "ok" : "fail";
}

const MESSAGE_LIMIT = 500;

function truncate(message: string): string {
  return message.length > MESSAGE_LIMIT ? `${message.slice(0, MESSAGE_LIMIT)}…` : message;
}

export async function runPipeline(pipeline: ResolvedPipeline, input: ContextInput, logger: Logger, observer: RunObserver = {}): Promise<RunResult> {
  const runId = randomUUID();
  let ctx = createContext(input, runId);
  const requestId = ctx.requestId;
  const trace = (result: RunResult): RunResult => (requestId === undefined ? result : { ...result, requestId });
  const runStarted = performance.now();
  const runEvent: RunStartEvent = { runId, pipeline: pipeline.name, trigger: input.trigger, at: Date.now() };
  if (input.parentRunId !== undefined) runEvent.parentRunId = input.parentRunId;
  if (requestId !== undefined) runEvent.requestId = requestId;
  observer.runStart?.(runEvent);
  let thrown = false;
  let thrownMessage: string | undefined;
  const finish = (result: RunResult): RunResult => {
    const end: RunEndEvent = { ...runEvent, ms: elapsed(runStarted), status: result.status, outcome: runOutcome(result, thrown) };
    if (result.code !== undefined) end.code = result.code;
    if (result.step !== undefined) end.step = result.step;
    const message = thrownMessage ?? (result.status < 400 ? undefined : result.error);
    if (message !== undefined) end.message = truncate(message);
    observer.runEnd?.(end);
    return result;
  };

  for (const step of pipeline.steps) {
    const started = performance.now();
    const stepEvent: StepStartEvent = { runId, pipeline: pipeline.name, step: step.name, at: Date.now() };
    observer.stepStart?.(stepEvent);
    const log = (outcome: StepLog["outcome"], status: number) => {
      const ms = elapsed(started);
      logger.step({
        runId,
        ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
        pipeline: pipeline.name,
        step: step.name,
        ms,
        outcome,
      });
      observer.stepEnd?.({ ...stepEvent, ms, status, outcome });
    };
    const problems = inputProblems(step.description, ctx);
    if (problems.length > 0) {
      const error = failure("VALIDATION", `${step.name}: payload does not match schema (${problems.map((p) => `${p.path} ${p.message}`).join("; ")})`, { details: { problems } });
      log("fail(VALIDATION)", error.status);
      return finish(trace({ runId, status: error.status, error: error.message, code: error.code, retryable: error.retryable, step: step.name, details: { problems } }));
    }
    try {
      const out: unknown = await step.fn(ctx);
      if (!isResult(out)) {
        throw new Error(`step "${step.name}" returned ${typeof out} instead of a Result<Context>`);
      }
      if (isErr(out)) {
        const error = out.error;
        log(`fail(${error.code})`, error.status);
        if (error.cause !== undefined) {
          const cause = error.cause instanceof Error ? { stack: error.cause.stack ?? error.cause.message } : { cause: error.cause };
          logger.error(`pipeline "${pipeline.name}" step "${step.name}" failed with a cause`, { runId, code: error.code, ...cause });
        }
        return finish(
          trace({
            runId,
            status: error.status,
            error: error.message,
            code: error.code,
            retryable: error.retryable,
            step: step.name,
            ...(error.details === undefined ? {} : { details: error.details }),
          }),
        );
      }
      if (!isContext(out.value)) {
        throw new Error(`step "${step.name}" returned ${typeof out.value} instead of a Result<Context>`);
      }
      checkWrites(step, ctx, out.value);
      ctx = Object.freeze(out.value);
      log("ok", 200);
      if (Reflect.get(ctx, DONE) === true) return finish(trace({ runId, status: 200, result: ctx.result }));
    } catch (caught) {
      thrown = true;
      log("error", 500);
      const error = caught instanceof Error ? caught : new Error(String(caught));
      logger.error(`pipeline "${pipeline.name}" step "${step.name}" threw`, { runId, stack: error.stack ?? error.message });
      thrownMessage = `${pipeline.name}/${step.name}: unexpected ${error.name}`;
      return finish(trace({ runId, status: 500, error: `${pipeline.name}/${step.name}: ${error.message}`, code: "INTERNAL", retryable: false, step: step.name }));
    }
  }

  const done: RunResult = { runId, status: 200 };
  if (ctx.result !== undefined) done.result = ctx.result;
  return finish(trace(done));
}

function elapsed(since: number): number {
  return Math.round((performance.now() - since) * 100) / 100;
}
