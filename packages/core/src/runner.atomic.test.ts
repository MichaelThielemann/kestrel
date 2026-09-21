import { describe, expect, it, vi } from "vitest";
import type { AtomicOutcome, AtomicScope, AtomicScopeInfo, AtomicVerdict } from "./atomic.ts";
import { boundaryCast } from "./cast.ts";
import type { Context, Step } from "./context.ts";
import type { StepDescription } from "./defineModule.ts";
import { failure } from "./errors.ts";
import { silentLogger, type Logger, type StepLog } from "./logger.ts";
import { ok } from "./result.ts";
import type { ResolvedStep } from "./registry.ts";
import { runPipeline } from "./runner.ts";

function collectingLogger() {
  const steps: StepLog[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    step: (e) => steps.push(e),
    info() {},
    warn: (m) => warnings.push(m),
    error: (m) => errors.push(m),
  };
  return { logger, steps, warnings, errors };
}

const description: StepDescription = { summary: "test", reads: [], writes: [] };
const writesResult: StepDescription = { summary: "test", reads: [], writes: ["result"] };
const input = { trigger: { kind: "http" as const, name: "POST /x" }, payload: {} };

function looseStep(name: string, atomic: number | undefined, fn: (ctx: Context) => Promise<unknown>, writes = description): ResolvedStep {
  return { name, description: writes, fn: boundaryCast<Step>(fn, "host"), ...(atomic === undefined ? {} : { atomic }) };
}

function realScope(rows: string[]): AtomicScope {
  return async (_info: AtomicScopeInfo, body: () => Promise<AtomicVerdict>): Promise<AtomicOutcome> => {
    const before = [...rows];
    const verdict = await body();
    if (verdict === "rollback") {
      rows.length = 0;
      rows.push(...before);
    }
    return { kind: "settled", verdict };
  };
}

describe("runPipeline: atomic groups", () => {
  it("ctx.done() inside a group commits", async () => {
    const rows: string[] = [];
    const { logger } = collectingLogger();
    const res = await runPipeline(
      {
        name: "p",
        steps: [
          looseStep(
            "a",
            1,
            async (ctx) => {
              rows.push("a");
              return ctx.done("early");
            },
            writesResult,
          ),
          looseStep("b", 1, async (ctx) => {
            rows.push("b");
            return ok(ctx);
          }),
        ],
      },
      input,
      logger,
      {},
      { atomicScope: realScope(rows) },
    );
    expect(res.status).toBe(200);
    expect(res.result).toBe("early");
    expect(rows).toEqual(["a"]);
  });

  it("a throw inside a group rolls back and reports 500 INTERNAL", async () => {
    const rows: string[] = [];
    const { logger, errors } = collectingLogger();
    const res = await runPipeline(
      {
        name: "p",
        steps: [
          looseStep("a", 1, async (ctx) => {
            rows.push("a");
            return ok(ctx);
          }),
          looseStep("b", 1, async () => {
            throw new Error("boom");
          }),
        ],
      },
      input,
      logger,
      {},
      { atomicScope: realScope(rows) },
    );
    expect(res.status).toBe(500);
    expect(res.code).toBe("INTERNAL");
    expect(res.step).toBe("b");
    expect(rows).toEqual([]);
    expect(errors.some((m) => m.includes("threw"))).toBe(true);
  });

  it("an Err inside a group rolls back and reports the step's own error", async () => {
    const rows: string[] = [];
    const { logger, warnings } = collectingLogger();
    const res = await runPipeline(
      {
        name: "p",
        steps: [
          looseStep("a", 1, async (ctx) => {
            rows.push("a");
            return ok(ctx);
          }),
          looseStep("b", 1, async (ctx) => ctx.fail("TRANSIENT", "database is busy")),
        ],
      },
      input,
      logger,
      {},
      { atomicScope: realScope(rows) },
    );
    expect(res.status).toBe(503);
    expect(res.code).toBe("TRANSIENT");
    expect(res.step).toBe("b");
    expect(rows).toEqual([]);
    expect(warnings.some((m) => m.includes("atomic group rolled back"))).toBe(true);
  });

  it("the scope timeout rolls back and answers 503, no rows", async () => {
    const rows: string[] = [];
    const { logger, errors } = collectingLogger();
    const scope: AtomicScope = async () => {
      rows.length = 0;
      return { kind: "failed", phase: "timeout", error: failure("TRANSIENT", "atomic scope timed out") };
    };
    const res = await runPipeline(
      { name: "p", steps: [looseStep("a", 1, async (ctx) => ok(ctx))] },
      input,
      logger,
      {},
      { atomicScope: scope },
    );
    expect(res.status).toBe(503);
    expect(res.retryable).toBe(true);
    expect(rows).toEqual([]);
    expect(errors.some((m) => m.includes("atomic group timed out"))).toBe(true);
  });

  it("a commit failure answers a failed request and stores nothing observable to the caller", async () => {
    const { logger, errors } = collectingLogger();
    const scope: AtomicScope = async () => ({ kind: "failed", phase: "commit", error: failure("INTERNAL", "commit failed") });
    const res = await runPipeline(
      { name: "p", steps: [looseStep("a", 1, async (ctx) => ok(ctx)), looseStep("b", 1, async (ctx) => ok(ctx))] },
      input,
      logger,
      {},
      { atomicScope: scope },
    );
    expect(res.status).toBe(500);
    expect(res.code).toBe("INTERNAL");
    expect(res.step).toBe("b");
    expect(errors.some((m) => m.includes("atomic group failed to commit"))).toBe(true);
  });

  it("a failed rollback logs error and returns the ORIGINAL outcome to the client", async () => {
    const { logger, errors } = collectingLogger();
    const scope: AtomicScope = async (_info, body) => {
      await body();
      return {
        kind: "failed",
        phase: "rollback",
        error: failure("INTERNAL", "rollback failed"),
        original: failure("TRANSIENT", "database is busy"),
      };
    };
    const res = await runPipeline(
      { name: "p", steps: [looseStep("a", 1, async (ctx) => ctx.fail("TRANSIENT", "database is busy"))] },
      input,
      logger,
      {},
      { atomicScope: scope },
    );
    expect(res.status).toBe(503);
    expect(res.code).toBe("TRANSIENT");
    expect(errors.some((m) => m.includes("atomic group failed to roll back"))).toBe(true);
  });

  it("a group could not begin -> 503, naming the group's first step", async () => {
    const { logger, warnings } = collectingLogger();
    const scope: AtomicScope = async () => ({ kind: "failed", phase: "begin", error: failure("TRANSIENT", "busy", { details: { retryAfterSeconds: 1 } }) });
    const res = await runPipeline(
      { name: "p", steps: [looseStep("first", 1, async (ctx) => ok(ctx)), looseStep("second", 1, async (ctx) => ok(ctx))] },
      input,
      logger,
      {},
      { atomicScope: scope },
    );
    expect(res.status).toBe(503);
    expect(res.step).toBe("first");
    expect(warnings.some((m) => m.includes("atomic group could not begin"))).toBe(true);
  });

  it("outside a group, nothing changes: no atomicScope is ever called", async () => {
    const { logger } = collectingLogger();
    const scope = vi.fn<AtomicScope>();
    const res = await runPipeline(
      { name: "p", steps: [looseStep("a", undefined, async (ctx) => ok({ ...ctx, result: "x" }), writesResult)] },
      input,
      logger,
      {},
      { atomicScope: scope },
    );
    expect(res.status).toBe(200);
    expect(scope).not.toHaveBeenCalled();
  });

  it("a grouped pipeline run without atomicScope throws (a composition bug, not a client-facing error)", async () => {
    await expect(
      runPipeline({ name: "p", steps: [looseStep("a", 1, async (ctx) => ok(ctx))] }, input, silentLogger),
    ).rejects.toThrow(/atomic group but no atomic scope was provided/);
  });
});
