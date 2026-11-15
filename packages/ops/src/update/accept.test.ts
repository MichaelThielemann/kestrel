import { afterEach, describe, expect, it } from "vitest";
import { accept } from "./accept.ts";
import { createUpdateHarness, type UpdateHarness } from "./harness.fixture.ts";
import { readUpdateRun } from "./journal.ts";
import type { UpdateContext } from "./types.ts";

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function runIn(h: UpdateHarness, verdict: "passed" | "failed" | "unverifiable" | null): Promise<UpdateContext> {
  const ctx = await h.context();
  for (const step of ["gate", "stage", "configuration", "precopy"]) await ctx.journal.record(step, "done", { phase: "deploy" });
  await ctx.journal.record("stop", "done", { phase: "deploy", stoppedAt: Date.now() });
  await ctx.journal.record("promote", "done", { phase: "deploy", generation: "20261115T010000Z", nonce: "n1" });
  await ctx.journal.record("start", "started", { phase: "deploy" });
  await ctx.journal.record("start", "done", { phase: "deploy", ready: true });
  if (verdict !== null) await ctx.journal.record("verify", "done", { phase: "deploy", verdict, checks: [] });
  return ctx;
}

describe("accepting a deploy", () => {
  it("accepts a verified run", async () => {
    const h = createUpdateHarness();
    harnesses.push(h);
    const ctx = await runIn(h, "passed");
    const run = await readUpdateRun(ctx, ctx.run.id);
    expect(run.state).toBe("verified");
    const accepting = await h.context({ run, command: "update accept" });
    const outcome = await accept(accepting, run);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.state).toBe("accepted");
    expect((await readUpdateRun(ctx, ctx.run.id)).state).toBe("accepted");
  });

  it.each([
    ["verifying", null],
    ["halted", "unverifiable"],
    ["rolling-back", "failed"],
  ] as const)("refuses a %s run with exit 1 and writes nothing", async (state, verdict) => {
    const h = createUpdateHarness();
    harnesses.push(h);
    const ctx = await runIn(h, verdict);
    const run = await readUpdateRun(ctx, ctx.run.id);
    expect(run.state).toBe(state);
    const outcome = await accept(await h.context({ run, command: "update accept" }), run);
    expect(outcome.exitCode).toBe(1);
    expect((await readUpdateRun(ctx, ctx.run.id)).lastSeq).toBe(run.lastSeq);
  });

  it("refuses an accepted run", async () => {
    const h = createUpdateHarness();
    harnesses.push(h);
    const ctx = await runIn(h, "passed");
    const first = await readUpdateRun(ctx, ctx.run.id);
    await accept(await h.context({ run: first }), first);
    const accepted = await readUpdateRun(ctx, ctx.run.id);
    expect((await accept(await h.context({ run: accepted }), accepted)).exitCode).toBe(1);
  });
});
