import { describe, it, expect } from "vitest";
import type { Context, Step } from "./context.ts";
import { customFailure } from "./errors.ts";
import type { Logger, StepLog } from "./logger.ts";
import { ok } from "./result.ts";
import type { ResolvedStep } from "./registry.ts";
import { createRunTracker, runPipeline } from "./runner.ts";

function collectingLogger() {
  const steps: StepLog[] = [];
  const errors: string[] = [];
  const logger: Logger = { step: (e) => steps.push(e), info() {}, error: (m) => errors.push(m) };
  return { logger, steps, errors };
}
const description = { summary: "test", reads: [], writes: [] };
const input = { trigger: { kind: "http" as const, name: "POST /x" }, payload: { a: 1 } };

/** A step whose return value the runner has to reject; `Step` is the narrower of the two types. */
function looseStep(name: string, fn: (ctx: Context) => Promise<unknown>): ResolvedStep {
  return { name, description, fn: fn as Step };
}

describe("runPipeline", () => {
  it("runs steps in order and returns ctx.result with status 200", async () => {
    const { logger, steps } = collectingLogger();
    const res = await runPipeline(
      {
        name: "p",
        steps: [
          { name: "one", description, fn: async (ctx: Context) => ok({ ...ctx, result: [1] }) },
          { name: "two", description, fn: async (ctx: Context) => ok({ ...ctx, result: [...(ctx.result as number[]), 2] }) },
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

  it("unexpected throw becomes 500 INTERNAL with pipeline and step name", async () => {
    const { logger, steps, errors } = collectingLogger();
    const res = await runPipeline(
      { name: "p", steps: [{ name: "boom", description, fn: async () => { throw new Error("db down"); } }] },
      input,
      logger,
    );
    expect(res).toMatchObject({ status: 500, error: "p/boom: db down", code: "INTERNAL", retryable: false, step: "boom" });
    expect(steps[0]?.outcome).toBe("error");
    expect(errors[0]).toContain('step "boom"');
  });

  it("a step that returns no Result is an INTERNAL error", async () => {
    const { logger } = collectingLogger();
    const res = await runPipeline({ name: "p", steps: [looseStep("bad", async () => undefined)] }, input, logger);
    expect(res.status).toBe(500);
    expect(res.code).toBe("INTERNAL");
    expect(res.error).toContain("instead of a Result<Context>");
  });

  it("a step that returns a bare context instead of a Result is an INTERNAL error", async () => {
    const { logger } = collectingLogger();
    const res = await runPipeline({ name: "p", steps: [looseStep("bare", async (ctx: Context) => ctx)] }, input, logger);
    expect(res.status).toBe(500);
    expect(res.error).toContain('step "bare"');
    expect(res.error).toContain("instead of a Result<Context>");
  });

  it("an Ok whose value is not a context is an INTERNAL error", async () => {
    const { logger } = collectingLogger();
    const res = await runPipeline({ name: "p", steps: [looseStep("half", async () => ok({ nope: true }))] }, input, logger);
    expect(res.status).toBe(500);
    expect(res.error).toContain('step "half"');
    expect(res.error).toContain("instead of a Result<Context>");
  });

  it("ctx.done ends the pipeline with status 200 and the given result", async () => {
    const { logger, steps } = collectingLogger();
    let ran = false;
    const res = await runPipeline(
      {
        name: "p",
        steps: [
          { name: "one", description, fn: async (ctx: Context) => ctx.done({ redirect: { to: "/x", status: 301 } }) },
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
          { name: "one", description, fn: async (ctx: Context) => ok({ ...ctx, params: { ...ctx.params, id: "p1" } }) },
          { name: "two", description, fn: async (ctx: Context) => ctx.done(ctx.params.id) },
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

  it("an unexpected throw reports the step name next to the unchanged message", async () => {
    const { logger } = collectingLogger();
    const res = await runPipeline({ name: "p", steps: [{ name: "boom", description, fn: async () => { throw new Error("db down"); } }] }, input, logger);
    expect(res.error).toBe("p/boom: db down");
    expect(res.step).toBe("boom");
  });

  it("a step returning a copy with changes works", async () => {
    const { logger } = collectingLogger();
    const res = await runPipeline(
      {
        name: "p",
        steps: [{ name: "one", description, fn: async (ctx: Context) => ok({ ...ctx, result: 1 }) }],
      },
      input,
      logger,
    );
    expect(res.status).toBe(200);
    expect(res.result).toBe(1);
  });
});

describe("runPipeline payload validation", () => {
  const typed = { summary: "typed", reads: [], writes: [], input: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false }, query: { limit: { type: "integer", minimum: 1 }, ids: { type: "array", items: { type: "string" } } } };
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

  it("validates the payload as body for triggers without an HTTP split and skips steps without schemas", async () => {
    const { logger } = collectingLogger();
    const bare = { name: "content.create", description, fn: pass };
    expect(await runPipeline({ name: "p", steps: [bare] }, input, logger)).toMatchObject({ status: 200 });
    expect(await runPipeline({ name: "p", steps: [step(pass)] }, { trigger: { kind: "event", name: "x" }, payload: { title: "x" } }, logger)).toMatchObject({ status: 200, result: "ran" });
    expect(await runPipeline({ name: "p", steps: [step(pass)] }, { trigger: { kind: "event", name: "x" }, payload: { title: 3 } }, logger)).toMatchObject({ status: 400, code: "VALIDATION" });
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
