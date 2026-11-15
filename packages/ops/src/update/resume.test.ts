import { afterEach, describe, expect, it } from "vitest";
import { resume } from "./resume.ts";
import { continueRun, createScenario, deployUntil, guardStarts, rowsOf, runOf, scenarioContinue, type Scenario } from "./scenario.fixture.ts";
import { nextCommand } from "./status.ts";
import { UPDATE_EXIT, type DeployStep, type VerifyResult, type VerifyVerdict } from "./types.ts";

const scenarios: Scenario[] = [];
afterEach(async () => {
  for (const s of scenarios.splice(0)) await s.h.dispose();
});

async function scenario(): Promise<Scenario> {
  const s = await createScenario({ from: { renders: false } });
  scenarios.push(s);
  return s;
}

const verdict = (value: VerifyVerdict): (() => Promise<VerifyResult>) => async () => ({ verdict: value, checks: [], ready: value === "unverifiable" ? { outcome: "unverifiable", status: 403, reason: "forbidden" } : { outcome: value === "passed" ? "ready" : "not-ready", status: value === "passed" ? 200 : 503 }, ownGeneration: null });

describe("update resume", () => {
  for (const step of ["gate", "stage", "configuration", "precopy", "stop", "seal", "cutover-backup", "migrate", "promote", "swap", "start"] as const satisfies readonly DeployStep[]) {
    it(`continues a deploy interrupted after ${step} through the rest of its steps`, async () => {
      const s = await scenario();
      const violations = guardStarts(s);
      const deployed = await deployUntil(s, step);
      expect(deployed.end.failure).toBeNull();
      const { ctx, run } = await continueRun(s, deployed.runId, "update resume", { steps: { continueDeploy: scenarioContinue(s) } });
      const outcome = await resume(ctx, run);
      expect(outcome, outcome.message).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "verified" });
      expect(s.h.target.release.runtime).toBe("6.0.0");
      expect(violations).toEqual([]);
      const records = (await runOf(s, deployed.runId)).records;
      const resumed = records.findIndex((r) => r.step === "resume");
      expect(records[resumed]).toMatchObject({ state: "started", phase: "resume" });
      expect(records.filter((r) => r.step === "promote" && r.state === "done")).toHaveLength(1);
    });
  }

  it("verifies a halted run again and retires the previous droplet once it passes", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "start");
    await deployed.ctx.journal.record("verify", "done", { phase: "deploy", verdict: "unverifiable" });
    const { ctx, run } = await continueRun(s, deployed.runId, "update resume", { steps: { verify: verdict("passed") } });
    expect(run.state).toBe("halted");
    const outcome = await resume(ctx, run);
    expect(outcome).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "verified" });
    expect(s.h.target.droplets.has(s.previousDroplet)).toBe(false);
    const steps = (await runOf(s, deployed.runId)).records.map((r) => `${r.step} ${r.state} ${r.phase}`);
    expect(steps.slice(-3)).toEqual(["verify done verify", "retire started deploy", "retire done deploy"]);
  });

  it("stays halted while verification still cannot tell, and rolls back when it fails", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "start");
    await deployed.ctx.journal.record("verify", "done", { phase: "deploy", verdict: "unverifiable" });
    const again = await continueRun(s, deployed.runId, "update resume", { steps: { verify: verdict("unverifiable") } });
    expect(await resume(again.ctx, again.run)).toMatchObject({ exitCode: UPDATE_EXIT.refused, state: "halted" });
    expect(s.h.target.release.runtime).toBe("6.0.0");
    const failed = await continueRun(s, deployed.runId, "update resume", { steps: { verify: verdict("failed") } });
    expect(await resume(failed.ctx, failed.run)).toMatchObject({ exitCode: UPDATE_EXIT.rolledBack, state: "rolled-back" });
    expect(s.h.target.release.runtime).toBe("5.8.1");
    expect(s.h.target.droplets.has(s.previousDroplet)).toBe(true);
  });

  it("holds a halted run whose new release wrote since its start when verification fails again, keeps the release running and names update rollback", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "start");
    await deployed.ctx.journal.record("verify", "done", { phase: "deploy", verdict: "unverifiable" });
    const app = s.h.target.app;
    if (app === null) throw new Error("the new release does not run");
    app.run(`INSERT INTO pages VALUES ('halted', 'Written while halted', 'Kept')`);
    await app.export();
    await app.sync();
    const failed = await continueRun(s, deployed.runId, "update resume", { steps: { verify: verdict("failed") } });
    const outcome = await resume(failed.ctx, failed.run);
    expect(outcome, outcome.message).toMatchObject({ exitCode: UPDATE_EXIT.refused, state: "halted" });
    expect(outcome.message).toContain(`update rollback --env prod --run ${deployed.runId}`);
    expect(s.h.target.release.runtime).toBe("6.0.0");
    expect((await s.h.target.status()).state).toBe("started");
    expect(JSON.stringify(rowsOf(s.h.target.app?.file ?? ""))).toContain("Written while halted");
    expect(nextCommand(await runOf(s, deployed.runId), "update deploy")).toBe(`kestrel update rollback --env prod --run ${deployed.runId}`);
  });

  it("rolls back a run whose verification failed before its rollback began", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "start");
    await deployed.ctx.journal.record("verify", "done", { phase: "deploy", verdict: "failed" });
    const { ctx, run } = await continueRun(s, deployed.runId, "update resume");
    expect(run.state).toBe("rolling-back");
    expect(await resume(ctx, run)).toMatchObject({ exitCode: UPDATE_EXIT.rolledBack, state: "rolled-back" });
    expect(s.h.target.release.runtime).toBe("5.8.1");
  });

  it("runs an interrupted rollback again from its first step", async () => {
    const s = await scenario();
    const violations = guardStarts(s);
    const deployed = await deployUntil(s, "start");
    const target = s.h.target;
    const restore = target.restoreConfiguration.bind(target);
    let failures = 1;
    target.restoreConfiguration = async (recorded) => {
      if (failures-- > 0) throw new Error("connection reset");
      return restore(recorded);
    };
    const first = await continueRun(s, deployed.runId, "update rollback");
    await expect(first.ctx.steps.rollback(first.ctx, first.run, { kind: "automatic", failure: "verify failed" })).rejects.toThrow("connection reset");
    expect((await target.status()).state).toBe("stopped");
    const { ctx, run } = await continueRun(s, deployed.runId, "update resume");
    expect(run.state).toBe("rolling-back");
    expect(await resume(ctx, run)).toMatchObject({ exitCode: UPDATE_EXIT.rolledBack, state: "rolled-back" });
    expect(target.release.runtime).toBe("5.8.1");
    expect(violations).toEqual([]);
    const steps = (await runOf(s, deployed.runId)).records.map((r) => `${r.step} ${r.state}`);
    expect(steps.filter((x) => x === "re-promote done")).toHaveLength(2);
  });

  it("does not roll back a run whose rollback after accept was refused", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "retire");
    const { ctx } = await continueRun(s, deployed.runId, "update accept");
    await ctx.journal.record("accept", "done", { phase: "accept" });
    await continueRun(s, deployed.runId, "update rollback");
    const resumed = await continueRun(s, deployed.runId, "update resume");
    expect(await resume(resumed.ctx, resumed.run)).toMatchObject({ exitCode: UPDATE_EXIT.refused });
    expect(s.h.target.release.runtime).toBe("6.0.0");
  });

  it("refuses a run that needs nothing", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "retire");
    const { ctx, run } = await continueRun(s, deployed.runId, "update resume");
    expect(await resume(ctx, run)).toMatchObject({ exitCode: UPDATE_EXIT.refused, state: "verified" });
  });
});
