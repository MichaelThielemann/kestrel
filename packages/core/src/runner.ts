import { randomUUID } from "node:crypto";
import type { AtomicScope } from "./atomic.ts";
import { createContext, DONE, type Context, type ContextInput } from "./context.ts";
import type { Logger, StepLog } from "./logger.ts";
import type { RunEndEvent, RunObserver, RunStartEvent, StepStartEvent } from "./observer.ts";
import type { ResolvedStep } from "./registry.ts";
import { failure, isKestrelError, type KestrelError } from "./errors.ts";
import { isErr, type Result } from "./result.ts";
import { coerceQuery, resolveOutputSchema, validateSchema, type SchemaProblem } from "./schema.ts";
import { isRecord } from "./guards.ts";
import type { JsonSchema, StepDescription } from "./defineModule.ts";
import { logWarn } from "./logger.ts";
import { writeRoot } from "./writes.ts";

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

export interface RunPipelineOptions {
  /** Dev/test only: after every step that writes to `result`, validates it against the pipeline's `describe().output` folded up to that step; a mismatch throws naming the step and the JSON path. Off by default, so production pays nothing for it. */
  validateOutput?: boolean;
  /** Wraps an atomic group in one all-or-nothing scope; absent when no loaded module provides one, in which case no pipeline has a group (boot guarantees it). */
  atomicScope?: AtomicScope;
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
  if (!isRecord(value)) return false;
  if (value.ok === true) return "value" in value;
  return value.ok === false && isKestrelError(value.error);
}

function isContext(value: unknown): value is Context {
  if (!isRecord(value)) return false;
  const record = (v: unknown): boolean => typeof v === "object" && v !== null;
  return record(value.trigger) && record(value.payload) && record(value.params) && record(value.headers) && Array.isArray(value.files) && typeof value.fail === "function" && typeof value.done === "function";
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

function writesResult(step: ResolvedStep): boolean {
  return step.description.writes.some((path) => writeRoot(path) === "result");
}

function optionalResultWrite(step: ResolvedStep): boolean {
  return step.description.writes.includes("result?");
}

function withoutRequired(schema: JsonSchema): JsonSchema {
  const relaxed: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "required" && Array.isArray(value)) continue;
    relaxed[key] = relaxedValue(value);
  }
  return relaxed;
}

function relaxedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(relaxedValue);
  return isRecord(value) ? withoutRequired(value) : value;
}

function checkOutput(step: ResolvedStep, descriptionsSoFar: readonly StepDescription[], before: Context, after: Context): void {
  if (optionalResultWrite(step) && Object.is(before.result, after.result)) return;
  const folded = resolveOutputSchema(descriptionsSoFar);
  if (folded === undefined) return;
  const narrowed = descriptionsSoFar.some((d) => d.narrows !== undefined);
  const schema = narrowed ? withoutRequired(folded) : folded;
  const problems = validateSchema(schema, after.result);
  if (problems.length > 0) {
    throw new Error(`step "${step.name}": result does not match describe().output (${problems.map((p) => `${p.path} ${p.message}`).join("; ")})`);
  }
}

function declaresOnlyTerminal(description: StepDescription): boolean {
  return description.terminalOutput !== undefined && description.output === undefined && description.extendsOutput === undefined && description.extendsItems === undefined;
}

function checkOnlyTerminal(step: ResolvedStep, before: Context, after: Context): void {
  if (!declaresOnlyTerminal(step.description) || Object.is(before.result, after.result)) return;
  throw new Error(`step "${step.name}" changed result without ctx.done() but declares only terminalOutput`);
}

function checkTerminalOutput(step: ResolvedStep, after: Context): void {
  const schema = step.description.terminalOutput;
  if (schema === undefined) {
    throw new Error(`step "${step.name}" ended the run with ctx.done() without declaring describe().terminalOutput`);
  }
  const problems = validateSchema(schema, after.result);
  if (problems.length > 0) {
    throw new Error(`step "${step.name}": result does not match describe().terminalOutput (${problems.map((p) => `${p.path} ${p.message}`).join("; ")})`);
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

type StepOutcome =
  | { kind: "ok"; ctx: Context }
  | { kind: "done"; result: RunResult }
  | { kind: "err"; result: RunResult }
  | { kind: "throw"; result: RunResult; thrownMessage: string };

async function runStep(
  step: ResolvedStep,
  ctx: Context,
  pipelineName: string,
  runId: string,
  parentRunId: string | undefined,
  logger: Logger,
  observer: RunObserver,
  validateOutput: boolean,
  descriptionsSoFar: StepDescription[],
): Promise<StepOutcome> {
  const started = performance.now();
  const stepEvent: StepStartEvent = { runId, pipeline: pipelineName, step: step.name, at: Date.now() };
  observer.stepStart?.(stepEvent);
  const log = (outcome: StepLog["outcome"], status: number) => {
    const ms = elapsed(started);
    logger.step({
      runId,
      ...(parentRunId === undefined ? {} : { parentRunId }),
      pipeline: pipelineName,
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
    return { kind: "err", result: { runId, status: error.status, error: error.message, code: error.code, retryable: error.retryable, step: step.name, details: { problems } } };
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
        logger.error(`pipeline "${pipelineName}" step "${step.name}" failed with a cause`, { runId, code: error.code, ...cause });
      }
      return {
        kind: "err",
        result: {
          runId,
          status: error.status,
          error: error.message,
          code: error.code,
          retryable: error.retryable,
          step: step.name,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      };
    }
    if (!isContext(out.value)) {
      throw new Error(`step "${step.name}" returned ${typeof out.value} instead of a Result<Context>`);
    }
    checkWrites(step, ctx, out.value);
    const before = ctx;
    const after = Object.freeze(out.value);
    const ended = Reflect.get(after, DONE) === true;
    if (validateOutput) {
      if (ended) {
        checkTerminalOutput(step, after);
      } else {
        descriptionsSoFar.push(step.description);
        checkOnlyTerminal(step, before, after);
        if (writesResult(step)) checkOutput(step, descriptionsSoFar, before, after);
      }
    }
    log("ok", 200);
    if (ended) return { kind: "done", result: { runId, status: 200, result: after.result } };
    return { kind: "ok", ctx: after };
  } catch (caught) {
    log("error", 500);
    const error = caught instanceof Error ? caught : new Error(String(caught));
    logger.error(`pipeline "${pipelineName}" step "${step.name}" threw`, { runId, stack: error.stack ?? error.message });
    return {
      kind: "throw",
      thrownMessage: `${pipelineName}/${step.name}: unexpected ${error.name}`,
      result: { runId, status: 500, error: `${pipelineName}/${step.name}: ${error.message}`, code: "INTERNAL", retryable: false, step: step.name },
    };
  }
}

function errorResult(runId: string, step: string, error: KestrelError): RunResult {
  return {
    runId,
    status: error.status,
    error: error.message,
    code: error.code,
    retryable: error.retryable,
    step,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

export async function runPipeline(pipeline: ResolvedPipeline, input: ContextInput, logger: Logger, observer: RunObserver = {}, options: RunPipelineOptions = {}): Promise<RunResult> {
  const runId = randomUUID();
  const descriptionsSoFar: StepDescription[] = [];
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
  const runOne = (step: ResolvedStep, currentCtx: Context): Promise<StepOutcome> =>
    runStep(step, currentCtx, pipeline.name, runId, input.parentRunId, logger, observer, options.validateOutput === true, descriptionsSoFar);
  const takeOutcome = (outcome: { kind: "err" | "throw"; result: RunResult; thrownMessage?: string }): RunResult => {
    if (outcome.kind === "throw") {
      thrown = true;
      thrownMessage = outcome.thrownMessage;
    }
    return outcome.result;
  };

  let i = 0;
  while (i < pipeline.steps.length) {
    const step = pipeline.steps[i]!;
    if (step.atomic === undefined) {
      const outcome = await runOne(step, ctx);
      if (outcome.kind === "ok") {
        ctx = outcome.ctx;
        i++;
        continue;
      }
      if (outcome.kind === "done") return finish(trace(outcome.result));
      return finish(trace(takeOutcome(outcome)));
    }

    const groupOrdinal = step.atomic;
    const groupSteps: ResolvedStep[] = [];
    let j = i;
    while (j < pipeline.steps.length && pipeline.steps[j]!.atomic === groupOrdinal) {
      groupSteps.push(pipeline.steps[j]!);
      j++;
    }
    const firstStepName = groupSteps[0]!.name;
    const lastStepName = groupSteps[groupSteps.length - 1]!.name;
    const { atomicScope } = options;
    if (atomicScope === undefined) {
      throw new Error(`pipeline "${pipeline.name}" step "${firstStepName}" is in an atomic group but no atomic scope was provided`);
    }

    let runningStep = firstStepName;
    let groupCtx = ctx;
    let doneResult: RunResult | undefined;
    let cause: { kind: "err" | "throw"; result: RunResult; thrownMessage?: string } | undefined;

    const outcome = await atomicScope({ pipeline: pipeline.name, group: groupOrdinal }, async () => {
      for (const s of groupSteps) {
        runningStep = s.name;
        const stepOutcome = await runOne(s, groupCtx);
        if (stepOutcome.kind === "ok") {
          groupCtx = stepOutcome.ctx;
          continue;
        }
        if (stepOutcome.kind === "done") {
          doneResult = stepOutcome.result;
          return "commit";
        }
        cause = stepOutcome;
        return "rollback";
      }
      return "commit";
    });

    if (outcome.kind === "failed") {
      if (outcome.phase === "begin") {
        logWarn(logger, "atomic group could not begin", { pipeline: pipeline.name, step: firstStepName, runId });
        return finish(trace(errorResult(runId, firstStepName, outcome.error)));
      }
      if (outcome.phase === "timeout") {
        logger.error("atomic group timed out", { pipeline: pipeline.name, step: runningStep, runId });
        return finish(trace(errorResult(runId, runningStep, outcome.error)));
      }
      if (outcome.phase === "commit") {
        logger.error("atomic group failed to commit", { pipeline: pipeline.name, step: lastStepName, runId });
        return finish(trace(errorResult(runId, lastStepName, outcome.error)));
      }
      logger.error("atomic group failed to roll back", {
        pipeline: pipeline.name,
        step: cause?.result.step ?? lastStepName,
        runId,
        stack: outcome.error.message,
        code: cause?.result.code ?? outcome.original?.code,
      });
      if (cause !== undefined) return finish(trace(takeOutcome(cause)));
      const original = outcome.original ?? outcome.error;
      return finish(trace(errorResult(runId, lastStepName, original)));
    }

    if (outcome.verdict === "rollback") {
      logWarn(logger, "atomic group rolled back", { pipeline: pipeline.name, step: cause?.result.step ?? lastStepName, runId, code: cause?.result.code });
      if (cause !== undefined) return finish(trace(takeOutcome(cause)));
      return finish(trace(errorResult(runId, lastStepName, failure("INTERNAL", "atomic group rolled back with no recorded cause"))));
    }

    if (doneResult !== undefined) return finish(trace(doneResult));
    ctx = groupCtx;
    i = j;
  }

  const done: RunResult = { runId, status: 200 };
  if (ctx.result !== undefined) done.result = ctx.result;
  return finish(trace(done));
}

function elapsed(since: number): number {
  return Math.round((performance.now() - since) * 100) / 100;
}
