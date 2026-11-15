import { afterEach, describe, expect, it } from "vitest";
import { listBackups } from "../backup.ts";
import { resume } from "./resume.ts";
import { waitForSeal } from "./seal.ts";
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

async function writeRow(s: Scenario, id: string): Promise<void> {
  const app = s.h.target.app;
  if (app === null) throw new Error("the new release does not run");
  app.run(`INSERT INTO pages VALUES ('${id}', 'Written by the new release', 'Kept')`);
  await app.export();
  await app.sync();
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

  it("holds a verifying run whose new release wrote since its start when the resumed verification fails, keeps the release running and names update rollback", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "start");
    await writeRow(s, "resumed");
    const { ctx, run } = await continueRun(s, deployed.runId, "update resume", { steps: { verify: verdict("failed") } });
    expect(run.state).toBe("verifying");
    const outcome = await resume(ctx, run);
    expect(outcome, outcome.message).toMatchObject({ exitCode: UPDATE_EXIT.refused, state: "halted" });
    expect(outcome.message).toContain(`update rollback --env prod --run ${deployed.runId}`);
    expect(s.h.target.release.runtime).toBe("6.0.0");
    expect((await s.h.target.status()).state).toBe("started");
    expect(JSON.stringify(rowsOf(s.h.target.app?.file ?? ""))).toContain("Written by the new release");
    expect((await listBackups(ctx)).filter((b) => b.kind === "pre-restore")).toEqual([]);
    expect(nextCommand(await runOf(s, deployed.runId), "update deploy")).toBe(`kestrel update rollback --env prod --run ${deployed.runId}`);
  });

  it("holds a verifying run whose new release wrote since its start when the resumed verification throws", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "start");
    await writeRow(s, "resumed");
    const throwing = async (): Promise<VerifyResult> => {
      throw new Error("the probe crashed");
    };
    const { ctx, run } = await continueRun(s, deployed.runId, "update resume", { steps: { verify: throwing } });
    const outcome = await resume(ctx, run);
    expect(outcome, outcome.message).toMatchObject({ exitCode: UPDATE_EXIT.refused, state: "halted" });
    expect(s.h.target.release.runtime).toBe("6.0.0");
    expect(JSON.stringify(rowsOf(s.h.target.app?.file ?? ""))).toContain("Written by the new release");
  });

  it("stops a verifying run whose release wrote nothing and takes a safety backup before it rolls back a failed resumed verification", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "start");
    const { ctx, run } = await continueRun(s, deployed.runId, "update resume", { steps: { verify: verdict("failed") } });
    const outcome = await resume(ctx, run);
    expect(outcome, outcome.message).toMatchObject({ exitCode: UPDATE_EXIT.rolledBack, state: "rolled-back" });
    expect(s.h.target.release.runtime).toBe("5.8.1");
    expect((await listBackups(ctx)).filter((b) => b.kind === "pre-restore" && b.verified)).toHaveLength(1);
  });

  it("asks before it rolls back a run whose failed verification was recorded and whose release wrote since, and keeps what it wrote without the answer", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "start");
    await deployed.ctx.journal.record("verify", "done", { phase: "deploy", verdict: "failed" });
    await writeRow(s, "after-failure");
    const first = await continueRun(s, deployed.runId, "update resume");
    expect(first.run.state).toBe("rolling-back");
    const refused = await resume(first.ctx, first.run);
    expect(refused.exitCode, refused.message).toBe(UPDATE_EXIT.refused);
    expect(refused.message).toContain("rollback-accepted");
    expect(s.h.target.release.runtime).toBe("6.0.0");
    expect((await s.h.target.status()).state).toBe("started");
    expect(JSON.stringify(rowsOf(s.h.target.app?.file ?? ""))).toContain("Written by the new release");
    expect((await listBackups(first.ctx)).filter((b) => b.kind === "pre-restore")).toEqual([]);

    const { ctx, run } = await continueRun(s, deployed.runId, "update resume", { answers: { "unsealed-stop": "accept", "rollback-accepted": "prod" } });
    expect(await resume(ctx, run)).toMatchObject({ exitCode: UPDATE_EXIT.rolledBack, state: "rolled-back" });
    expect(s.h.target.release.runtime).toBe("5.8.1");
    expect((await listBackups(ctx)).filter((b) => b.kind === "pre-restore" && b.verified)).toHaveLength(1);
  });

  it("keeps what the release wrote after a failed re-verification whose safety stop failed, when update status names the next command", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "start");
    await deployed.ctx.journal.record("verify", "done", { phase: "deploy", verdict: "unverifiable" });
    let failures = 1;
    const flaky: typeof waitForSeal = async (ctx, at) => {
      if (failures-- > 0) throw new Error("the store answered 500");
      return waitForSeal(ctx, at);
    };
    const first = await continueRun(s, deployed.runId, "update resume", { steps: { verify: verdict("failed"), waitForSeal: flaky } });
    const stopped = await resume(first.ctx, first.run);
    expect(stopped.exitCode, stopped.message).toBe(UPDATE_EXIT.refused);
    expect((await s.h.target.status()).state).toBe("started");
    await writeRow(s, "after-guard");
    const resumeCommand = `update resume --env prod --run ${deployed.runId}`;
    expect(stopped.message).toContain(resumeCommand);
    expect(nextCommand(await runOf(s, deployed.runId), "update deploy")).toBe(`kestrel ${resumeCommand}`);
    const { ctx, run } = await continueRun(s, deployed.runId, "update resume");
    const again = await resume(ctx, run);
    expect(again.exitCode, again.message).toBe(UPDATE_EXIT.refused);
    expect(s.h.target.release.runtime).toBe("6.0.0");
    expect(JSON.stringify(rowsOf(s.h.target.app?.file ?? ""))).toContain("Written by the new release");
    expect((await listBackups(ctx)).filter((b) => b.kind === "pre-restore")).toEqual([]);
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
