import { describe, it, expect, expectTypeOf } from "vitest";
import type { Context, Step, StepResult } from "./context.ts";
import { customFailure } from "./errors.ts";
import { silentLogger, type Logger, type StepLog } from "./logger.ts";
import type { RunEndEvent, RunObserver } from "./observer.ts";
import { boundaryCast } from "./cast.ts";
import { ok } from "./result.ts";
import type { ResolvedStep } from "./registry.ts";
import { createRunTracker, runPipeline, type RunPipelineOptions, type RunResult } from "./runner.ts";

function collectingLogger() {
  const steps: StepLog[] = [];
  const errors: string[] = [];
  const logger: Logger = { step: (e) => steps.push(e), info() {}, error: (m) => errors.push(m) };
  return { logger, steps, errors };
}
const thrownStacks = new Map<string, string>();
const stackLogger: Logger = {
  step() {},
  info() {},
  error: (_message, data) => {
    if (typeof data?.runId === "string") thrownStacks.set(data.runId, String(data.stack));
  },
};
const thrownText = (res: RunResult): string => thrownStacks.get(res.runId) ?? "";
const description = { summary: "test", reads: [], writes: [] };
const writesResult = { summary: "test", reads: [], writes: ["result"] };
const input = { trigger: { kind: "http" as const, name: "POST /x" }, payload: { a: 1 } };

function looseStep(name: string, fn: (ctx: Context) => Promise<unknown>): ResolvedStep {
  return { name, description, fn: boundaryCast<Step>(fn, "host") };
}

describe("runPipeline", () => {
  it("runs steps in order and returns ctx.result with status 200", async () => {
    const { logger, steps } = collectingLogger();
    const res = await runPipeline(
      {
        name: "p",
        steps: [
          { name: "one", description: writesResult, fn: async (ctx: Context) => ok({ ...ctx, result: [1] }) },
          { name: "two", description: writesResult, fn: async (ctx: Context) => ok({ ...ctx, result: [...boundaryCast<number[]>(ctx.result, "host"), 2] }) },
        ],
      },
      input,
      logger,
    );
    expect(res.status).toBe(200);
    expect(res.result).toEqual([1, 2]);
    expect(steps.map((s) => [s.step, s.outcome])).toEqual([["one", "ok"], ["two", "ok"]]);
    expect(steps.every((s) => s.runId === res.runId && s.pipeline === "p" && s.ms >= 0)).toBe(true);
  });

  it("an Err short-circuits the pipeline with status, code and retryable", async () => {
    const { logger, steps } = collectingLogger();
    let ran = false;
    const res = await runPipeline(
      {
        name: "p",
        steps: [
          { name: "deny", description, fn: async (ctx: Context) => ctx.fail("UNAUTHENTICATED", "not authenticated") },
          { name: "after", description, fn: async (ctx: Context) => { ran = true; return ok(ctx); } },
        ],
      },
      input,
      logger,
    );
    expect(res).toMatchObject({ status: 401, error: "not authenticated", code: "UNAUTHENTICATED", retryable: false, step: "deny" });
    expect(ran).toBe(false);
    expect(steps[0]?.outcome).toBe("fail(UNAUTHENTICATED)");
  });

  it("a retryable code reports retryable and its status", async () => {
    const { logger, steps } = collectingLogger();
    const res = await runPipeline(
      { name: "p", steps: [{ name: "io", description, fn: async (ctx: Context) => ctx.fail("TRANSIENT", "database is busy", { retryAfterSeconds: 3 }) }] },
      input,
      logger,
    );
    expect(res).toMatchObject({ status: 503, code: "TRANSIENT", retryable: true, details: { retryAfterSeconds: 3 } });
    expect(steps[0]?.outcome).toBe("fail(TRANSIENT)");
  });

  it("passes a contract error through ctx.fail unchanged", async () => {
    const { logger, steps } = collectingLogger();
    const error = customFailure("MIGRATION_FAILED", 500, "migration 003 failed", { details: { migration: "003" } });
    const res = await runPipeline({ name: "p", steps: [{ name: "apply", description, fn: async (ctx: Context) => ctx.fail(error) }] }, input, logger);
    expect(res).toMatchObject({ status: 500, error: "migration 003 failed", code: "MIGRATION_FAILED", retryable: false, step: "apply", details: { migration: "003" } });
    expect(steps[0]?.outcome).toBe("fail(MIGRATION_FAILED)");
  });

  it("never serializes the cause of a failure but logs it", async () => {
    const { logger, errors } = collectingLogger();
    const res = await runPipeline(
      { name: "p", steps: [{ name: "io", description, fn: async (ctx: Context) => ctx.fail({ code: "TRANSIENT", status: 503, message: "busy", retryable: true, cause: new Error("SQLITE_BUSY") }) }] },
      input,
      logger,
    );
    expect(res).not.toHaveProperty("cause");
    expect(errors[0]).toContain('step "io"');
  });

  it("unexpected throw becomes 500 INTERNAL naming the pipeline, the step and the error class, never the message", async () => {
    const { logger, steps, errors } = collectingLogger();
    const res = await runPipeline(
      { name: "p", steps: [{ name: "boom", description, fn: async () => { throw new TypeError("db down at 10.0.0.7"); } }] },
      input,
      logger,
    );
    expect(res).toMatchObject({ status: 500, error: "p/boom: unexpected TypeError", code: "INTERNAL", retryable: false, step: "boom" });
    expect(JSON.stringify(res)).not.toContain("db down");
    expect(steps[0]?.outcome).toBe("error");
    expect(errors[0]).toContain('step "boom"');
  });

  it("offers serving callers no option that puts a thrown step's message into the answer", () => {
    expectTypeOf<keyof RunPipelineOptions>().toEqualTypeOf<"validateOutput" | "atomicScope" | "stepLog">();
    expectTypeOf<RunPipelineOptions["stepLog"]>().toEqualTypeOf<"all" | "errors" | "off" | undefined>();
  });

  it("logs the message and the stack of an unexpected throw under the answer's runId", async () => {
    const logged: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const logger: Logger = { step() {}, info() {}, error: (message, data) => logged.push({ message, ...(data === undefined ? {} : { data }) }) };
    const res = await runPipeline({ name: "p", steps: [{ name: "boom", description, fn: async () => { throw new Error("db down"); } }] }, input, logger);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.data?.runId).toBe(res.runId);
    expect(String(logged[0]?.data?.stack)).toContain("Error: db down");
    expect(logged[0]?.data?.message).toBe("db down");
  });

  it("a step that returns no Result is an INTERNAL error", async () => {
        const res = await runPipeline({ name: "p", steps: [looseStep("bad", async () => undefined)] }, input, stackLogger);
    expect(res.status).toBe(500);
    expect(res.code).toBe("INTERNAL");
    expect(thrownText(res)).toContain("instead of a Result<Context>");
  });

  it("a step that returns a bare context instead of a Result is an INTERNAL error", async () => {
        const res = await runPipeline({ name: "p", steps: [looseStep("bare", async (ctx: Context) => ctx)] }, input, stackLogger);
    expect(res.status).toBe(500);
    expect(thrownText(res)).toContain('step "bare"');
    expect(thrownText(res)).toContain("instead of a Result<Context>");
  });

  it("an Ok whose value is not a context is an INTERNAL error", async () => {
        const res = await runPipeline({ name: "p", steps: [looseStep("half", async () => ok({ nope: true }))] }, input, stackLogger);
    expect(res.status).toBe(500);
    expect(thrownText(res)).toContain('step "half"');
    expect(thrownText(res)).toContain("instead of a Result<Context>");
  });

  it("ctx.done ends the pipeline with status 200 and the given result", async () => {
    const { logger, steps } = collectingLogger();
    let ran = false;
    const res = await runPipeline(
      {
        name: "p",
        steps: [
          { name: "one", description: { ...writesResult, terminalOutput: {} }, fn: async (ctx: Context) => ctx.done({ redirect: { to: "/x", status: 301 } }) },
          { name: "two", description, fn: async (ctx: Context) => { ran = true; return ok(ctx); } },
        ],
      },
      input,
      logger,
    );
    expect(res).toEqual({ runId: res.runId, status: 200, result: { redirect: { to: "/x", status: 301 } } });
    expect(ran).toBe(false);
    expect(steps.map((s) => [s.step, s.outcome])).toEqual([["one", "ok"]]);
  });

  it("ctx.done keeps what earlier steps wrote to the context", async () => {
    const { logger } = collectingLogger();
    const res = await runPipeline(
      {
        name: "p",
        steps: [
          { name: "one", description: { summary: "test", reads: [], writes: ["params.id"] }, fn: async (ctx: Context) => ok({ ...ctx, params: { ...ctx.params, id: "p1" } }) },
          { name: "two", description: { ...writesResult, terminalOutput: {} }, fn: async (ctx: Context) => ctx.done(ctx.params.id) },
        ],
      },
      input,
      logger,
    );
    expect(res.result).toBe("p1");
  });

  it("createContext returns a frozen context", async () => {
    const { createContext } = await import("./context.ts");
    const ctx = createContext(input);
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it("a step mutating ctx in place fails the pipeline with the step named", async () => {
    const { logger } = collectingLogger();
    const res = await runPipeline(
      {
        name: "p",
        steps: [
          {
            name: "mutator",
            description,
            fn: async (ctx: Context) => {
              Object.assign(ctx, { identity: "x" });
              return ok(ctx);
            },
          },
        ],
      },
      input,
      logger,
    );
    expect(res.status).toBe(500);
    expect(res.error).toMatch(/^p\/mutator:/);
  });

  it("puts the run id on the context and reports it as the run id", async () => {
    const { logger } = collectingLogger();
    let seen: string | undefined;
    const res = await runPipeline({ name: "p", steps: [{ name: "one", description, fn: async (ctx: Context) => { seen = ctx.runId; return ok(ctx); } }] }, input, logger);
    expect(seen).toBe(res.runId);
  });

  it("logs the parent run id on every step entry when the input carries one", async () => {
    const { logger, steps } = collectingLogger();
    await runPipeline(
      { name: "p", steps: [{ name: "one", description, fn: async (ctx: Context) => ok(ctx) }, { name: "two", description, fn: async (ctx: Context) => ok(ctx) }] },
      { trigger: { kind: "event", name: "page.created" }, parentRunId: "parent-1" },
      logger,
    );
    expect(steps.map((s) => s.parentRunId)).toEqual(["parent-1", "parent-1"]);
  });

  it("omits parentRunId when the run has no parent", async () => {
    const { logger, steps } = collectingLogger();
    await runPipeline({ name: "p", steps: [{ name: "one", description, fn: async (ctx: Context) => ok(ctx) }] }, input, logger);
    expect(steps[0]).not.toHaveProperty("parentRunId");
  });

  it("takes requestId from the x-request-id header and returns it, but never from the payload", async () => {
    const { logger } = collectingLogger();
    let seen: string | undefined;
    const step = { name: "one", description, fn: async (ctx: Context) => { seen = ctx.requestId; return ok(ctx); } };
    const res = await runPipeline({ name: "p", steps: [step] }, { trigger: { kind: "http", name: "GET /x" }, headers: { "x-request-id": "req-7" }, payload: { requestId: "spoof", runId: "spoof" } }, logger);
    expect(seen).toBe("req-7");
    expect(res.requestId).toBe("req-7");
    expect(res.runId).not.toBe("spoof");
  });

  it("returns the response headers and the further cookies the steps of a successful run set", async () => {
    const { logger } = collectingLogger();
    const setBoth = { name: "one", description: { summary: "test", reads: [], writes: ["responseHeaders", "responseCookies"] }, fn: async (ctx: Context) => ok({ ...ctx, responseHeaders: { "set-cookie": "a=1" }, responseCookies: ["b=2", "c=3"] }) };
    const res = await runPipeline({ name: "p", steps: [setBoth] }, input, logger);
    expect(res.headers).toEqual({ "set-cookie": "a=1" });
    expect(res.cookies).toEqual(["b=2", "c=3"]);
  });

  it("drops a request id that is not short printable ASCII", async () => {
    const { logger } = collectingLogger();
    const res = await runPipeline({ name: "p", steps: [{ name: "one", description, fn: async (ctx: Context) => ok(ctx) }] }, { trigger: { kind: "http", name: "GET /x" }, headers: { "x-request-id": "a".repeat(300) } }, logger);
    expect(res.requestId).toBeUndefined();
  });

  it("ctx.fail carries the step name and structured details", async () => {
    const { logger } = collectingLogger();
    const res = await runPipeline(
      { name: "p", steps: [{ name: "check", description, fn: async (ctx: Context) => ctx.fail("VALIDATION", "pages: slug must be unique", { fields: [{ field: "slug", message: "must be unique" }] }) }] },
      input,
      logger,
    );
    expect(res).toMatchObject({ status: 400, code: "VALIDATION", error: "pages: slug must be unique", step: "check", details: { fields: [{ field: "slug", message: "must be unique" }] } });
  });

  it("ctx.fail without details reports only the step name", async () => {
    const { logger } = collectingLogger();
    const res = await runPipeline({ name: "p", steps: [{ name: "deny", description, fn: async (ctx: Context) => ctx.fail("UNAUTHENTICATED", "not authenticated") }] }, input, logger);
    expect(res.step).toBe("deny");
    expect(res).not.toHaveProperty("details");
  });

  it("an unexpected throw of an error subclass answers with the subclass's name", async () => {
    class StoreFailure extends Error {
      override name = "StoreFailure";
    }
    const { logger } = collectingLogger();
    const res = await runPipeline({ name: "p", steps: [{ name: "boom", description, fn: async () => { throw new StoreFailure("row 7 locked"); } }] }, input, logger);
    expect(res.error).toBe("p/boom: unexpected StoreFailure");
    expect(res.step).toBe("boom");
  });

  it("a step returning a copy with changes works", async () => {
    const { logger } = collectingLogger();
    const res = await runPipeline(
      {
        name: "p",
        steps: [{ name: "one", description: writesResult, fn: async (ctx: Context) => ok({ ...ctx, result: 1 }) }],
      },
      input,
      logger,
    );
    expect(res.status).toBe(200);
    expect(res.result).toBe(1);
  });
});

describe("runPipeline payload validation", () => {
  const typed = { summary: "typed", reads: [], writes: ["result"], input: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false }, query: { limit: { type: "integer", minimum: 1 }, ids: { type: "array", items: { type: "string" } } } };
  const step = (fn: Step) => ({ name: "content.create", description: typed, fn });
  const pass: Step = async (ctx: Context) => ok({ ...ctx, result: "ran" });
  const http = { kind: "http" as const, name: "POST /pages" };

  it("fails the run before the step with VALIDATION and details.problems when the body does not match input", async () => {
    const { logger, steps } = collectingLogger();
    let ran = false;
    const res = await runPipeline({ name: "createPage", steps: [step(async (ctx: Context) => { ran = true; return ok(ctx); })] }, { trigger: http, body: { title: 1, extra: true }, query: {} }, logger);
    expect(res).toMatchObject({ status: 400, code: "VALIDATION", retryable: false, step: "content.create" });
    expect(res.details).toEqual({ problems: [{ path: "$.title", message: "expected string, got number" }, { path: "$.extra", message: "is not allowed by additionalProperties: false" }] });
    expect(res.error).toBe("content.create: payload does not match schema ($.title expected string, got number; $.extra is not allowed by additionalProperties: false)");
    expect(ran).toBe(false);
    expect(steps[0]?.outcome).toBe("fail(VALIDATION)");
  });

  it("validates declared query keys on a coerced copy, ignores undeclared ones and leaves the context strings alone", async () => {
    const { logger } = collectingLogger();
    let seen: Record<string, unknown> = {};
    const spy: Step = async (ctx: Context) => { seen = ctx.payload; return ok({ ...ctx, result: "ran" }); };
    const run = (query: Record<string, unknown>) => runPipeline({ name: "p", steps: [step(spy)] }, { trigger: http, body: { title: "x" }, query, payload: { ...query, title: "x" } }, logger);
    expect(await run({ limit: "2", ids: "a", cachebuster: "123" })).toMatchObject({ status: 200, result: "ran" });
    expect(seen.limit).toBe("2");
    expect(seen.ids).toBe("a");
    const bad = await run({ limit: "0" });
    expect(bad).toMatchObject({ status: 400, code: "VALIDATION", details: { problems: [{ path: "$.limit", message: "below minimum 1" }] } });
    expect((await run({ limit: "abc" })).details).toEqual({ problems: [{ path: "$.limit", message: "expected integer, got string" }] });
  });

  it("fails a run whose query carries a key the input schema describes and the step does not declare as a query key", async () => {
    const { logger } = collectingLogger();
    let ran = false;
    const spy: Step = async (ctx: Context) => { ran = true; return ok({ ...ctx, result: "ran" }); };
    const res = await runPipeline({ name: "p", steps: [step(spy)] }, { trigger: http, body: {}, query: { title: "x" }, payload: { title: "x" } }, logger);
    expect(res).toMatchObject({ status: 400, code: "VALIDATION", step: "content.create" });
    expect(res.details).toMatchObject({ problems: [{ path: "$.title", message: "is a body member and must not be sent in the query" }, expect.anything()] });
    expect(ran).toBe(false);
  });

  it("refuses such a query key even when the body carries the same member", async () => {
    const { logger } = collectingLogger();
    const res = await runPipeline({ name: "p", steps: [step(pass)] }, { trigger: http, body: { title: "a" }, query: { title: "b" }, payload: { title: "a" } }, logger);
    expect(res).toMatchObject({ status: 400, code: "VALIDATION" });
  });

  it("lets a key the step declares as a query key through even when the input schema describes it too", async () => {
    const { logger } = collectingLogger();
    const both = { ...typed, input: { type: "object", properties: { limit: { type: "integer" } }, additionalProperties: false } };
    const res = await runPipeline({ name: "p", steps: [{ name: "content.create", description: both, fn: pass }] }, { trigger: http, body: {}, query: { limit: "2" }, payload: { limit: "2" } }, logger);
    expect(res).toMatchObject({ status: 200, result: "ran" });
  });

  it("does not look at query keys the input schema does not describe, nor at Object.prototype names", async () => {
    const { logger } = collectingLogger();
    const query = Object.fromEntries([["_", "1"], ["role", "admin"], ["constructor", "x"], ["__proto__", "y"]]);
    const res = await runPipeline({ name: "p", steps: [step(pass)] }, { trigger: http, body: { title: "x" }, query, payload: { title: "x" } }, logger);
    expect(res).toMatchObject({ status: 200, result: "ran" });
  });

  it("does not apply the query rule to a step whose input schema has no properties", async () => {
    const { logger } = collectingLogger();
    const open = { ...typed, input: { type: "object", additionalProperties: true } };
    const res = await runPipeline({ name: "p", steps: [{ name: "content.create", description: open, fn: pass }] }, { trigger: http, body: {}, query: { anything: "1" }, payload: { anything: "1" } }, logger);
    expect(res).toMatchObject({ status: 200 });
  });

  it("validates the payload as body for triggers without an HTTP split and skips steps without schemas", async () => {
    const { logger } = collectingLogger();
    const bare = { name: "content.create", description: writesResult, fn: pass };
    expect(await runPipeline({ name: "p", steps: [bare] }, input, logger)).toMatchObject({ status: 200 });
    expect(await runPipeline({ name: "p", steps: [step(pass)] }, { trigger: { kind: "event", name: "x" }, payload: { title: "x" } }, logger)).toMatchObject({ status: 200, result: "ran" });
    expect(await runPipeline({ name: "p", steps: [step(pass)] }, { trigger: { kind: "event", name: "x" }, payload: { title: 3 } }, logger)).toMatchObject({ status: 400, code: "VALIDATION" });
  });
});

describe("runPipeline writes check", () => {
  const run = (writes: string[], fn: Step, terminalOutput?: Record<string, unknown>) => runPipeline({ name: "p", steps: [{ name: "one", description: { summary: "test", reads: [], writes, ...(terminalOutput === undefined ? {} : { terminalOutput }) }, fn }] }, input, stackLogger);

  it("a write of an undeclared key is an INTERNAL error naming step and key", async () => {
    const res = await run([], async (ctx: Context) => ok({ ...ctx, result: 1 }));
    expect(res).toMatchObject({ status: 500, code: "INTERNAL", retryable: false, step: "one" });
    expect(res.error).toBe("p/one: unexpected Error");
    expect(thrownText(res)).toContain('step "one" writes "result" without declaring it');
  });

  it("a declared write that never happened is an INTERNAL error pointing at the conditional form", async () => {
    const res = await run(["result"], async (ctx: Context) => ok(ctx));
    expect(res).toMatchObject({ status: 500, code: "INTERNAL", step: "one" });
    expect(thrownText(res)).toContain('step "one" declares writes "result" but did not write it (declare "result?" for a conditional write)');
  });

  it("a conditional write may stay unwritten", async () => {
    expect(await run(["result?"], async (ctx: Context) => ok(ctx))).toMatchObject({ status: 200 });
    expect(await run(["result?"], async (ctx: Context) => ok({ ...ctx, result: 1 }))).toMatchObject({ status: 200, result: 1 });
  });

  it("a nested path counts as written when the property exists, whatever its value", async () => {
    expect(await run(["result.x"], async (ctx: Context) => ok({ ...ctx, result: { x: 1 } }))).toMatchObject({ status: 200 });
    expect(await run(["result.x"], async (ctx: Context) => ok({ ...ctx, result: { x: null } }))).toMatchObject({ status: 200 });
    const missing = await run(["result.x"], async (ctx: Context) => ok({ ...ctx, result: { y: 1 } }));
    expect(missing.status).toBe(500);
    expect(thrownText(missing)).toContain('declares writes "result.x" but did not write it');
    const scalar = await run(["result.x"], async (ctx: Context) => ok({ ...ctx, result: "done" }));
    expect(scalar.status).toBe(500);
  });

  it("checks the context ctx.done() hands back", async () => {
    expect(await run(["result"], async (ctx: Context) => ctx.done({ id: "p1" }), {})).toMatchObject({ status: 200, result: { id: "p1" } });
    const undeclared = await run([], async (ctx: Context) => ctx.done({ id: "p1" }), {});
    expect(undeclared.status).toBe(500);
    expect(thrownText(undeclared)).toContain('writes "result" without declaring it');
  });

  it("ignores a key a step rewrote with the same value", async () => {
    expect(await run([], async (ctx: Context) => ok({ ...ctx, payload: ctx.payload }))).toMatchObject({ status: 200 });
  });
});

describe("runPipeline output validation", () => {
  const A_SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  const B_SCHEMA = { type: "object", properties: { b: { type: "string" } }, required: ["b"] };

  it("skips a step whose write is declared optional (result?) and left ctx.result unchanged", async () => {
    const res = await runPipeline(
      { name: "p", steps: [{ name: "maybe", description: { summary: "test", reads: [], writes: ["result?"], output: A_SCHEMA }, fn: async (ctx: Context) => ok(ctx) }] },
      input,
      stackLogger,
      {},
      { validateOutput: true },
    );
    expect(res.status).toBe(200);
  });

  it("does not skip a step whose optional write is a sub-path (result.x?), even when ctx.result is unchanged", async () => {
    const seed: ResolvedStep = { name: "seed", description: { summary: "test", reads: [], writes: ["result"], output: A_SCHEMA }, fn: boundaryCast<Step>(async (ctx: Context) => ok({ ...ctx, result: { a: "x" } }), "host") };
    const extend: ResolvedStep = { name: "extend", description: { summary: "test", reads: ["result"], writes: ["result.x?"], extendsOutput: B_SCHEMA }, fn: boundaryCast<Step>(async (ctx: Context) => ok(ctx), "host") };
    const res = await runPipeline({ name: "p", steps: [seed, extend] }, input, stackLogger, {}, { validateOutput: true });
    expect(res.status).toBe(500);
    expect(thrownText(res)).toContain('step "extend": result does not match describe().output');
    expect(thrownText(res)).toContain("$.b is required");
  });
});

describe("runPipeline terminal output validation", () => {
  const TERMINAL = { type: "object", properties: { redirect: { type: "string" } }, required: ["redirect"] };

  it("a ctx.done() without terminalOutput fails the run naming the step", async () => {
    const step = { name: "maybe", description: { summary: "test", reads: [], writes: ["result?"] }, fn: async (ctx: Context) => ctx.done({ redirect: "/x" }) };
    const res = await runPipeline({ name: "p", steps: [step] }, input, stackLogger, {}, { validateOutput: true });
    expect(res.status).toBe(500);
    expect(thrownText(res)).toContain('step "maybe" ended the run with ctx.done() without declaring describe().terminalOutput');
  });

  it("without validateOutput, the same ctx.done() fails the run too and never answers its result", async () => {
    const step = { name: "maybe", description: { summary: "test", reads: [], writes: ["result?"] }, fn: async (ctx: Context) => ctx.done({ redirect: "/x" }) };
    const res = await runPipeline({ name: "p", steps: [step] }, input, stackLogger);
    expect(res).toMatchObject({ status: 500, code: "INTERNAL", error: "p/maybe: unexpected Error" });
    expect(res).not.toHaveProperty("result");
    expect(thrownText(res)).toContain('step "maybe" ended the run with ctx.done() without declaring describe().terminalOutput');
  });

  it("without validateOutput, a ctx.done() with a declared terminalOutput ends the run with its result", async () => {
    const step = { name: "maybe", description: { summary: "test", reads: [], writes: ["result?"], terminalOutput: TERMINAL }, fn: async (ctx: Context) => ctx.done({ redirect: "/x" }) };
    expect(await runPipeline({ name: "p", steps: [step] }, input, stackLogger)).toMatchObject({ status: 200, result: { redirect: "/x" } });
  });

  it("a done result that does not match terminalOutput fails, naming the path", async () => {
    const step = { name: "maybe", description: { summary: "test", reads: [], writes: ["result?"], terminalOutput: TERMINAL }, fn: async (ctx: Context) => ctx.done({ redirect: 1 }) };
    const res = await runPipeline({ name: "p", steps: [step] }, input, stackLogger, {}, { validateOutput: true });
    expect(res.status).toBe(500);
    expect(thrownText(res)).toContain('step "maybe": result does not match describe().terminalOutput');
    expect(thrownText(res)).toContain("$.redirect expected string, got number");
  });

  it("a done result matching terminalOutput passes", async () => {
    const step = { name: "maybe", description: { summary: "test", reads: [], writes: ["result?"], terminalOutput: TERMINAL }, fn: async (ctx: Context) => ctx.done({ redirect: "/x" }) };
    const res = await runPipeline({ name: "p", steps: [step] }, input, stackLogger, {}, { validateOutput: true });
    expect(res).toMatchObject({ status: 200, result: { redirect: "/x" } });
  });

  it("a step declaring only terminalOutput that changes result without ctx.done() fails", async () => {
    const step = { name: "sneaky", description: { summary: "test", reads: [], writes: ["result?"], terminalOutput: TERMINAL }, fn: async (ctx: Context) => ok({ ...ctx, result: { redirect: "/x" } }) };
    const res = await runPipeline({ name: "p", steps: [step] }, input, stackLogger, {}, { validateOutput: true });
    expect(res.status).toBe(500);
    expect(thrownText(res)).toContain('step "sneaky" changed result without ctx.done() but declares only terminalOutput');
  });

  it("a step declaring only terminalOutput that leaves result unchanged passes", async () => {
    const step = { name: "quiet", description: { summary: "test", reads: [], writes: ["result?"], terminalOutput: TERMINAL }, fn: async (ctx: Context) => ok(ctx) };
    const res = await runPipeline({ name: "p", steps: [step] }, input, stackLogger, {}, { validateOutput: true });
    expect(res.status).toBe(200);
  });
});

describe("runPipeline observer", () => {
  function recording() {
    const events: string[] = [];
    const observer: RunObserver = {
      runStart: (e) => events.push(`runStart ${e.pipeline} ${e.trigger.kind}`),
      runEnd: (e) => events.push(`runEnd ${e.pipeline} ${e.status} ${e.outcome} ${e.code ?? "-"} ${e.step ?? "-"} ${e.ms >= 0 ? "timed" : "untimed"}`),
      stepStart: (e) => events.push(`stepStart ${e.step}`),
      stepEnd: (e) => events.push(`stepEnd ${e.step} ${e.status} ${e.outcome}`),
    };
    return { events, observer };
  }

  it("reports ok runs with every step", async () => {
    const { events, observer } = recording();
    await runPipeline({ name: "p", steps: [{ name: "one", description, fn: async (ctx: Context) => ok(ctx) }, { name: "two", description, fn: async (ctx: Context) => ok(ctx) }] }, input, silentLogger, observer);
    expect(events).toEqual(["runStart p http", "stepStart one", "stepEnd one 200 ok", "stepStart two", "stepEnd two 200 ok", "runEnd p 200 ok - - timed"]);
  });

  it("calls stepStart synchronously before the step body runs, with the run's own runId, and stepEnd after every outcome", async () => {
    const open = new Set<string>();
    const seenByBody: boolean[] = [];
    const tracking: RunObserver = {
      stepStart: (e) => {
        open.add(e.runId);
      },
      stepEnd: (e) => {
        open.delete(e.runId);
      },
    };
    const body = (end: (ctx: Context) => Promise<StepResult>): ResolvedStep => ({
      name: "watched",
      description,
      fn: async (ctx: Context) => {
        seenByBody.push(open.has(ctx.runId));
        return end(ctx);
      },
    });
    await runPipeline({ name: "p", steps: [body(async (ctx) => ok(ctx))] }, input, silentLogger, tracking);
    await runPipeline({ name: "p", steps: [body(async (ctx) => ctx.fail("FORBIDDEN", "no"))] }, input, silentLogger, tracking);
    await runPipeline({ name: "p", steps: [body(async () => Promise.reject(new Error("x")))] }, input, silentLogger, tracking);
    await runPipeline({ name: "p", steps: [{ ...body(async (ctx) => ok(ctx)), description: { ...description, input: { type: "object", properties: { a: { type: "string" } } } } }] }, input, silentLogger, tracking);
    expect(seenByBody).toEqual([true, true, true]);
    expect(open.size).toBe(0);
  });

  it("reports an Err as fail with the code and the step", async () => {
    const { events, observer } = recording();
    await runPipeline({ name: "p", steps: [{ name: "deny", description, fn: async (ctx: Context) => ctx.fail("FORBIDDEN", "no") }] }, input, silentLogger, observer);
    expect(events).toEqual(["runStart p http", "stepStart deny", "stepEnd deny 403 fail(FORBIDDEN)", "runEnd p 403 fail FORBIDDEN deny timed"]);
  });

  it("tells who and where a run came from: the client address, the identity known at its end and the failure details", async () => {
    const ended: RunEndEvent[] = [];
    const observer: RunObserver = { runEnd: (e) => ended.push(e) };
    const identify = { name: "identify", description: { ...description, writes: ["identity"] }, fn: async (ctx: Context) => ok({ ...ctx, identity: { id: "u1", claims: {} } }) };
    const deny = { name: "deny", description, fn: async (ctx: Context) => ctx.fail("FORBIDDEN", "no", { reason: "role" }) };
    await runPipeline({ name: "p", steps: [identify, deny] }, { ...input, ip: "203.0.113.7" }, silentLogger, observer);
    await runPipeline({ name: "q", steps: [identify] }, input, silentLogger, observer);
    expect(ended[0]).toMatchObject({ pipeline: "p", status: 403, ip: "203.0.113.7", identityId: "u1", details: { reason: "role" } });
    expect(ended[1]?.ip).toBeUndefined();
    expect(ended[1]?.details).toBeUndefined();
    expect(ended[1]?.identityId).toBe("u1");
  });

  it("reports a throw as error with status 500", async () => {
    const { events, observer } = recording();
    await runPipeline({ name: "p", steps: [{ name: "boom", description, fn: async () => { throw new Error("x"); } }] }, input, silentLogger, observer);
    expect(events).toEqual(["runStart p http", "stepStart boom", "stepEnd boom 500 error", "runEnd p 500 error INTERNAL boom timed"]);
  });

  it("reports an undeclared write as error with status 500", async () => {
    const { events, observer } = recording();
    await runPipeline({ name: "p", steps: [{ name: "one", description, fn: async (ctx: Context) => ok({ ...ctx, result: 1 }) }] }, input, silentLogger, observer);
    expect(events).toEqual(["runStart p http", "stepStart one", "stepEnd one 500 error", "runEnd p 500 error INTERNAL one timed"]);
  });

  it("reports a schema violation as a failed step that never ran", async () => {
    const { events, observer } = recording();
    const guarded: ResolvedStep = { name: "guarded", description: { ...description, input: { type: "object", properties: { a: { type: "string" } } } }, fn: async (ctx: Context) => ok(ctx) };
    await runPipeline({ name: "p", steps: [guarded] }, input, silentLogger, observer);
    expect(events).toEqual(["runStart p http", "stepStart guarded", "stepEnd guarded 400 fail(VALIDATION)", "runEnd p 400 fail VALIDATION guarded timed"]);
  });

  it("carries the failure message, but only the error name of a throw", async () => {
    const ends: Array<RunEndEvent> = [];
    const collect: RunObserver = { runEnd: (e) => ends.push(e) };
    await runPipeline({ name: "p", steps: [{ name: "one", description, fn: async (ctx: Context) => ok(ctx) }] }, input, silentLogger, collect);
    await runPipeline({ name: "p", steps: [{ name: "deny", description, fn: async (ctx: Context) => ctx.fail("FORBIDDEN", "no") }] }, input, silentLogger, collect);
    await runPipeline({ name: "p", steps: [{ name: "boom", description, fn: async () => { throw new TypeError("secret=hunter2"); } }] }, input, silentLogger, collect);
    expect(ends.map((e) => e.message)).toEqual([undefined, "no", "p/boom: unexpected TypeError"]);
  });

  it("truncates a long failure message", async () => {
    let end: RunEndEvent | undefined;
    await runPipeline({ name: "p", steps: [{ name: "deny", description, fn: async (ctx: Context) => ctx.fail("VALIDATION", "x".repeat(600)) }] }, input, silentLogger, { runEnd: (e) => { end = e; } });
    expect(end?.message).toBe(`${"x".repeat(500)}…`);
  });

  it("carries parentRunId and requestId on the run events", async () => {
    let start: { parentRunId?: string; requestId?: string } | undefined;
    await runPipeline({ name: "p", steps: [{ name: "one", description, fn: async (ctx: Context) => ok(ctx) }] }, { ...input, parentRunId: "parent", headers: { "x-request-id": "req-1" } }, silentLogger, { runStart: (e) => { start = e; } });
    expect(start).toMatchObject({ parentRunId: "parent", requestId: "req-1" });
  });
});

describe("createRunTracker", () => {
  it("counts active runs and drains when the last one settles", async () => {
    const tracker = createRunTracker();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = tracker.track(async () => { await gate; return 1; });
    expect(tracker.active()).toBe(1);
    const drained = tracker.drain(1000);
    release();
    await run;
    expect(await drained).toBe(true);
    expect(tracker.active()).toBe(0);
  });

  it("reports not drained when a run outlives the deadline", async () => {
    const tracker = createRunTracker();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = tracker.track(async () => { await gate; });
    expect(await tracker.drain(10)).toBe(false);
    release();
    await run;
  });

  it("counts a throwing run down again", async () => {
    const tracker = createRunTracker();
    await expect(tracker.track(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(tracker.active()).toBe(0);
    expect(await tracker.drain(0)).toBe(true);
  });
});

describe("runPipeline stepLog", () => {
  const validated = { summary: "test", reads: [], writes: [], input: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } };
  const pipelines = {
    ok: { name: "ok", steps: [{ name: "pass", description, fn: async (ctx: Context) => ok(ctx) }] },
    notFound: { name: "notFound", steps: [{ name: "find", description, fn: async (ctx: Context) => ctx.fail({ code: "NOT_FOUND", status: 404, message: "gone", retryable: false, cause: new Error("lookup missed") }) }] },
    validation: { name: "validation", steps: [{ name: "check", description: validated, fn: async (ctx: Context) => ok(ctx) }] },
    thrown: { name: "thrown", steps: [{ name: "boom", description, fn: async () => { throw new Error("broken"); } }] },
  };

  async function runAll(stepLog?: "all" | "errors" | "off") {
    const steps: string[] = [];
    const errors: string[] = [];
    const ends: string[] = [];
    const logger: Logger = { step: (e) => steps.push(`${e.pipeline} ${e.step} ${e.outcome}`), info() {}, error: (m) => errors.push(m) };
    const observer: RunObserver = { stepEnd: (e) => ends.push(`${e.pipeline} ${e.step} ${e.status} ${e.outcome}`) };
    const options: RunPipelineOptions = stepLog === undefined ? {} : { stepLog };
    for (const pipeline of Object.values(pipelines)) await runPipeline(pipeline, input, logger, observer, options);
    return { steps, errors, ends };
  }

  it("logs every step by default and with all", async () => {
    const expected = ["ok pass ok", "notFound find fail(NOT_FOUND)", "validation check fail(VALIDATION)", "thrown boom error"];
    expect((await runAll()).steps).toEqual(expected);
    expect((await runAll("all")).steps).toEqual(expected);
  });

  it("with errors logs every step whose outcome is not ok", async () => {
    expect((await runAll("errors")).steps).toEqual(["notFound find fail(NOT_FOUND)", "validation check fail(VALIDATION)", "thrown boom error"]);
  });

  it("with off logs no step", async () => {
    expect((await runAll("off")).steps).toEqual([]);
  });

  it("leaves the observer's step ends and the error lines for a cause and a throw the same in every mode", async () => {
    const reference = await runAll("all");
    expect(reference.ends).toEqual(["ok pass 200 ok", "notFound find 404 fail(NOT_FOUND)", "validation check 400 fail(VALIDATION)", "thrown boom 500 error"]);
    expect(reference.errors).toEqual(['pipeline "notFound" step "find" failed with a cause', 'pipeline "thrown" step "boom" threw']);
    for (const mode of ["errors", "off"] as const) {
      const { ends, errors } = await runAll(mode);
      expect(ends).toEqual(reference.ends);
      expect(errors).toEqual(reference.errors);
    }
  });
});
