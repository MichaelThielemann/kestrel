import { afterEach, describe, expect, it } from "vitest";
import { listBackups } from "../backup.ts";
import { PREFIXES } from "../harness.fixture.ts";
import { listGenerations, promote } from "../replica.ts";
import { appClock } from "../serverTime.ts";
import { abort } from "./abort.ts";
import { continueRun, createScenario, deployUntil, guardStarts, newestOrigin, runOf, type Scenario } from "./scenario.fixture.ts";
import { UPDATE_EXIT, type DeployStep } from "./types.ts";

const scenarios: Scenario[] = [];
afterEach(async () => {
  for (const s of scenarios.splice(0)) await s.h.dispose();
});

async function scenario(): Promise<Scenario> {
  const s = await createScenario({ from: { renders: false } });
  scenarios.push(s);
  return s;
}

const promotedGenerations = async (s: Scenario): Promise<string[]> => {
  const out: string[] = [];
  for (const g of await listGenerations(s.h.store, PREFIXES.replica)) if (g.files["origin.json"] !== undefined) out.push(g.name);
  return out;
};

describe("update abort", () => {
  for (const step of ["stage", "precopy", "stop", "seal", "cutover-backup", "migrate"] as const satisfies readonly DeployStep[]) {
    it(`after ${step}, before the promotion, starts the previous release on the unchanged replica`, async () => {
      const s = await scenario();
      const violations = guardStarts(s);
      const deployed = await deployUntil(s, step);
      expect(deployed.end.failure).toBeNull();
      const before = s.h.target.actions.length;
      const { ctx, run } = await continueRun(s, deployed.runId, "update abort");
      const outcome = await abort(ctx, run);
      expect(outcome).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "aborted" });
      expect((await s.h.target.status()).state).toBe("started");
      expect(s.h.target.current).toBe(s.previousDroplet);
      expect(s.h.target.actions.slice(before)).toEqual(["stop", "seal", "cutover-backup", "migrate"].includes(step) ? ["start"] : []);
      expect(await promotedGenerations(s)).toEqual([]);
      expect(violations).toEqual([]);
      const last = (await runOf(s, deployed.runId)).records.at(-1);
      expect(last).toMatchObject({ step: "abort", state: "done", data: { promoted: false } });
      const cutover = run.cutoverBackup;
      if (cutover !== null) expect((await listBackups(ctx)).find((b) => b.id === cutover)?.pinnedBy).toEqual([]);
    });
  }

  for (const step of ["promote", "swap", "start"] as const satisfies readonly DeployStep[]) {
    it(`after ${step} rolls back first, so the previous release starts only on the cutover state promoted again`, async () => {
      const s = await scenario();
      const violations = guardStarts(s);
      const deployed = await deployUntil(s, step);
      expect(deployed.end.failure).toBeNull();
      const before = s.h.target.actions.length;
      const { ctx, run } = await continueRun(s, deployed.runId, "update abort");
      const outcome = await abort(ctx, run);
      expect(outcome).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "rolled-back" });
      const actions = s.h.target.actions.slice(before);
      expect(actions.at(-1)).toBe("start");
      expect(actions.indexOf("restore-configuration")).toBeLessThan(actions.indexOf("start"));
      expect(s.h.target.release.runtime).toBe("5.8.1");
      expect(violations).toEqual([]);
      expect((await newestOrigin(s.h.store))?.kind ?? "restore").toBe("restore");
      const steps = (await runOf(s, deployed.runId)).records.map((r) => `${r.step} ${r.state}`);
      expect(steps.indexOf("re-promote done")).toBeLessThan(steps.lastIndexOf("start started"));
      expect(steps.at(-1)).toBe("abort done");
    });
  }

  it("rolls back when a promotion was placed but the journal did not record it", async () => {
    const s = await scenario();
    const violations = guardStarts(s);
    const deployed = await deployUntil(s, "migrate");
    const clock = await appClock(deployed.ctx);
    await promote({ store: s.h.store, prefix: PREFIXES.replica, target: s.h.target, database: deployed.ctx.workspace.path("migrated.db"), origin: { kind: "upgrade", source: "unrecorded" }, serverNow: clock.now, skewMs: clock.skewMs, clock: Date.now, poll: { delayMs: 5 } });
    const { ctx, run } = await continueRun(s, deployed.runId, "update abort");
    expect(run.promoted).toBeNull();
    const outcome = await abort(ctx, run);
    expect(outcome.state).toBe("rolled-back");
    expect(violations).toEqual([]);
    expect(s.h.target.release.runtime).toBe("5.8.1");
  });

  it("refuses a run that is not open", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "verify");
    const { ctx, run } = await continueRun(s, deployed.runId, "update abort");
    expect(run.state).toBe("verified");
    expect(await abort(ctx, run)).toMatchObject({ exitCode: UPDATE_EXIT.refused, state: "verified" });
    expect(s.h.target.release.runtime).toBe("6.0.0");
  });
});
