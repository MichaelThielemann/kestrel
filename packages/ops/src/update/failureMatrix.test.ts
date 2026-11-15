import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LOCATION } from "../harness.fixture.ts";
import { keys } from "../layout.ts";
import type { ObjectStore } from "../store.ts";
import { abort } from "./abort.ts";
import type { FakeRelease } from "./fakeUpdateTarget.fixture.ts";
import { resume } from "./resume.ts";
import { continueRun, CONVERTED_PREFIX, createScenario, deployUntil, guardStarts, rowsOf, runOf, scenarioContinue, type Scenario } from "./scenario.fixture.ts";
import { UPDATE_EXIT, type UpdateOutcome } from "./types.ts";

const scenarios: Scenario[] = [];
afterEach(async () => {
  for (const s of scenarios.splice(0)) await s.h.dispose();
});

async function scenario(to: Partial<FakeRelease> = {}): Promise<{ s: Scenario; violations: string[] }> {
  const s = await createScenario({ from: { renders: false }, to });
  scenarios.push(s);
  return { s, violations: guardStarts(s) };
}

async function resumeRun(s: Scenario, runId: string): Promise<UpdateOutcome> {
  const { ctx, run } = await continueRun(s, runId, "update resume", { steps: { continueDeploy: scenarioContinue(s) } });
  return resume(ctx, run);
}

async function expectVerified(s: Scenario, runId: string, outcome: UpdateOutcome): Promise<void> {
  expect(outcome, outcome.message).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "verified" });
  expect(s.h.target.release.runtime).toBe("6.0.0");
  expect((await runOf(s, runId)).records.filter((r) => r.step === "promote" && r.state === "done")).toHaveLength(1);
}

async function expectRolledBack(s: Scenario, runId: string): Promise<void> {
  const run = await runOf(s, runId);
  expect(run.state).toBe("rolled-back");
  expect(s.h.target.release.runtime).toBe("5.8.1");
  expect(s.h.target.current).toBe(s.previousDroplet);
  const app = s.h.target.app;
  if (app === null) throw new Error("the previous release does not run");
  const file = `${s.h.target.options.dir}-cutover.db`;
  writeFileSync(file, (await s.h.store.get(LOCATION + keys.db(run.cutoverBackup ?? ""))) ?? new Uint8Array());
  const cutover = rowsOf(file);
  for (const table of ["pages", "media_items", "authn_users", "mfa_factors", "audit_entries"]) expect(app.rows(table), table).toEqual(cutover[table]);
}

const failingOnce = (store: ObjectStore, matches: (key: string) => boolean): ObjectStore => {
  let left = 1;
  return {
    ...store,
    put: async (key, data, options) => {
      if (matches(key) && left-- > 0) throw new Error("socket hang up");
      return store.put(key, data, options);
    },
  };
};

describe("an update with a failure injected at each point ends verified through resume or rolled back", () => {
  it("staging fails: the app was never stopped, and resume deploys once staging works", async () => {
    const { s, violations } = await scenario();
    s.h.target.failStaging = "buildpack error";
    const deployed = await deployUntil(s, "verify");
    expect(deployed.end).toMatchObject({ last: "gate" });
    expect(deployed.end.failure?.message).toContain("buildpack error");
    expect(s.h.target.actions).not.toContain("stop");
    expect((await s.h.target.status()).state).toBe("started");
    expect((await runOf(s, deployed.runId)).state).toBe("deploying");
    s.h.target.failStaging = null;
    await expectVerified(s, deployed.runId, await resumeRun(s, deployed.runId));
    expect(violations).toEqual([]);
  });

  it("the new release does not boot: the automatic rollback brings back the cutover state on the previous release", async () => {
    const { s, violations } = await scenario({ crashes: true });
    const deployed = await deployUntil(s, "verify");
    expect(deployed.end).toMatchObject({ last: "swap" });
    await deployed.ctx.steps.rollback(deployed.ctx, await runOf(s, deployed.runId), { kind: "automatic", failure: deployed.end.failure?.message ?? "" });
    await expectRolledBack(s, deployed.runId);
    expect(violations).toEqual([]);
  });

  it("verification fails: the deploy rolls back and exits 3", async () => {
    const { s, violations } = await scenario();
    const deployed = await deployUntil(s, "start");
    s.h.target.release.ready = "not-ready";
    const outcome = await scenarioContinue(s)(deployed.ctx, await runOf(s, deployed.runId));
    expect(outcome.exitCode).toBe(UPDATE_EXIT.rolledBack);
    s.h.target.release.ready = "ready";
    await expectRolledBack(s, deployed.runId);
    expect(violations).toEqual([]);
  });

  it("the network fails while the cutover backup is written: resume takes it again and deploys, abort starts the previous release", async () => {
    for (const end of ["resume", "abort"] as const) {
      const { s, violations } = await scenario();
      const deployed = await deployUntil(s, "verify", {}, (step, ctx) => {
        if (step === "cutover-backup") ctx.backups = failingOnce(ctx.backups, (key) => key.endsWith("/db.sqlite"));
      });
      expect(deployed.end).toMatchObject({ last: "seal" });
      expect(deployed.end.failure?.message).toContain("socket hang up");
      expect((await s.h.target.status()).state).toBe("stopped");
      if (end === "resume") await expectVerified(s, deployed.runId, await resumeRun(s, deployed.runId));
      else {
        const { ctx, run } = await continueRun(s, deployed.runId, "update abort");
        expect(await abort(ctx, run)).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "aborted" });
        expect(s.h.target.release.runtime).toBe("5.8.1");
      }
      expect(violations, end).toEqual([]);
    }
  });

  it("the process is killed during the migration: resume migrates again from the cutover backup", async () => {
    const { s, violations } = await scenario();
    const deployed = await deployUntil(s, "cutover-backup");
    await s.h.store.put(`${CONVERTED_PREFIX}m1/harbour.jpg`, new TextEncoder().encode("half"));
    await expectVerified(s, deployed.runId, await resumeRun(s, deployed.runId));
    expect(new TextDecoder().decode((await s.h.store.get(`${CONVERTED_PREFIX}m1/harbour.jpg`)) ?? new Uint8Array())).toBe("harbour image bytes");
    expect(violations).toEqual([]);
  });

  it("the process is killed after the promotion: resume swaps and starts the new release, abort rolls back first", async () => {
    for (const end of ["resume", "abort"] as const) {
      const { s, violations } = await scenario();
      const deployed = await deployUntil(s, "promote");
      expect((await s.h.target.status()).state).toBe("stopped");
      if (end === "resume") await expectVerified(s, deployed.runId, await resumeRun(s, deployed.runId));
      else {
        const { ctx, run } = await continueRun(s, deployed.runId, "update abort");
        expect(await abort(ctx, run)).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "rolled-back" });
        await expectRolledBack(s, deployed.runId);
      }
      expect(violations, end).toEqual([]);
    }
  });

  it("the guard on starts sees a release before 6 started on a promoted generation", async () => {
    const { s, violations } = await scenario();
    await deployUntil(s, "promote");
    await s.h.target.start();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("runtime 5.8.1 started on promoted generation");
  });
});
