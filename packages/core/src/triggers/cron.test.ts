import { afterEach, describe, it, expect, vi } from "vitest";
import type { Logger } from "../logger.ts";
import type { Runner } from "../runner.ts";
import { createCronEntry, startCron } from "./cron.ts";

function collectingLogger() {
  const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const errors: string[] = [];
  const logger: Logger = { step() {}, info() {}, warn: (message, data) => warnings.push({ message, ...(data === undefined ? {} : { data }) }), error: (message) => errors.push(message) };
  return { logger, warnings, errors };
}

describe("startCron", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips a tick while the previous run of the same pipeline is still going", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { logger, warnings } = collectingLogger();
    let started = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run: Runner = async () => {
      started++;
      await gate;
      return { runId: `r${started}`, status: 200 };
    };

    const stop = startCron([createCronEntry("* * * * *", "sync")], run, logger);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/pipeline "sync" is still running/);

    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toBe(2);
    expect(warnings).toHaveLength(1);
    stop();
  });

  it("logs a failing run and keeps ticking", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { logger, errors } = collectingLogger();
    const run: Runner = async () => ({ runId: "r1", status: 500, error: "boom" });

    const stop = startCron([createCronEntry("* * * * *", "sync")], run, logger);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/ended with 500/);
    stop();
  });

  it("logs a rejecting run instead of leaving the rejection unhandled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { logger, errors } = collectingLogger();
    const run: Runner = () => Promise.reject(new Error("unknown pipeline"));

    const stop = startCron([createCronEntry("* * * * *", "sync")], run, logger);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors[0]).toMatch(/threw$/);
    stop();
  });
});
