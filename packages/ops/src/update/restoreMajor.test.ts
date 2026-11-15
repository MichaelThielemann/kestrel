import { afterEach, describe, expect, it } from "vitest";
import { createBackup, listBackups, readManifest } from "../backup.ts";
import { OpsError } from "../errors.ts";
import { restoreBackup } from "../restore.ts";
import { rollbackCommand } from "./rollback.ts";
import { continueRun, createScenario, deployUntil, runOf, type Scenario } from "./scenario.fixture.ts";
import { UPDATE_EXIT } from "./types.ts";

const scenarios: Scenario[] = [];
afterEach(async () => {
  for (const s of scenarios.splice(0)) await s.h.dispose();
});

async function upgraded(): Promise<{ s: Scenario; runId: string; cutover: string }> {
  const s = await createScenario({ from: { renders: false } });
  scenarios.push(s);
  const deployed = await deployUntil(s, "retire");
  expect(deployed.end.failure).toBeNull();
  const run = await runOf(s, deployed.runId);
  expect(run.state).toBe("verified");
  if (run.cutoverBackup === null) throw new Error("the deploy took no cutover backup");
  return { s, runId: deployed.runId, cutover: run.cutoverBackup };
}

async function refusal(promise: Promise<unknown>): Promise<OpsError> {
  const error: unknown = await promise.then(() => null, (cause: unknown) => cause);
  if (!(error instanceof OpsError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error;
}

describe("restore of a backup of another Kestrel major", () => {
  it("refuses a backup the release before the upgrade wrote while the new major runs, before it stops the app, and names update rollback", async () => {
    const { s, cutover } = await upgraded();
    expect((await readManifest(await s.h.context({ command: "restore" }), cutover))?.versions["@michaelthielemann/kestrel"]).toBe("5.8.1");
    const ctx = await s.h.context({ command: "restore" });
    const error = await refusal(restoreBackup(ctx, { backupId: cutover }));
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("Kestrel 5");
    expect(error.message).toContain("Kestrel 6");
    expect(error.message).toContain("kestrel update rollback --env prod");
    expect(error.message).toContain(`kestrel restore --to local <dir> --backup ${cutover}`);
    expect(error.message).toContain("other-major");
    expect((await s.h.target.status()).state).toBe("started");
    expect(s.h.target.release.runtime).toBe("6.0.0");
    expect((await listBackups(ctx)).filter((b) => b.kind === "pre-restore")).toEqual([]);
  });

  it("refuses a backup the new major wrote once update rollback brought back the release before it", async () => {
    const { s, runId } = await upgraded();
    const { ctx: rollbackCtx, run } = await continueRun(s, runId, "update rollback");
    expect(await rollbackCommand(rollbackCtx, run)).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "rolled-back" });
    expect(s.h.target.release.runtime).toBe("5.8.1");
    const ctx = await s.h.context({ command: "restore" });
    const newer = (await listBackups(ctx)).filter((b) => b.kind === "pre-restore").at(-1);
    if (newer === undefined) throw new Error("the rollback took no pre-restore backup");
    expect((await readManifest(ctx, newer.id))?.versions["@michaelthielemann/kestrel"]).toBe("6.0.0");
    const error = await refusal(restoreBackup(ctx, { backupId: newer.id }));
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("kestrel update deploy");
    expect((await s.h.target.status()).state).toBe("started");
    expect(s.h.target.release.runtime).toBe("5.8.1");
  });

  it("goes on with a backup of another major only with the answer other-major, which --yes does not give", async () => {
    const { s, cutover } = await upgraded();
    const ctx = await s.h.context({ command: "restore", answers: { "unsealed-stop": "accept", "access-changes": "accept", "other-major": "accept" } });
    const result = await restoreBackup(ctx, { backupId: cutover });
    expect(result.backupId).toBe(cutover);
    expect(result.safetyBackup).not.toBeNull();
  });

  it("refuses when the target reports no versions but the newest deploy run left the new major running", async () => {
    const { s, cutover } = await upgraded();
    s.h.target.reported = {};
    const error = await refusal(restoreBackup(await s.h.context({ command: "restore" }), { backupId: cutover }));
    expect(error.message).toContain("Kestrel 6");
  });

  it("takes the major the update journal left running over a stale report of the target", async () => {
    const { s, runId } = await upgraded();
    const { ctx: rollbackCtx, run } = await continueRun(s, runId, "update rollback");
    expect(await rollbackCommand(rollbackCtx, run)).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "rolled-back" });
    s.h.target.reported = { "@michaelthielemann/kestrel": "6.0.0", "@michaelthielemann/kestrel-replication-sqlite": "6.0.0" };
    const ctx = await s.h.context({ command: "restore" });
    const newer = (await listBackups(ctx)).filter((b) => b.kind === "pre-restore").at(-1);
    if (newer === undefined) throw new Error("the rollback took no pre-restore backup");
    const error = await refusal(restoreBackup(ctx, { backupId: newer.id }));
    expect(error.message).toContain(`runs Kestrel 5 (as update run ${runId} left it)`);
  });

  it("warns and goes on when the running major cannot be told", async () => {
    const s = await createScenario({ from: { renders: false } });
    scenarios.push(s);
    const backupCtx = await s.h.context({ command: "backup" });
    const backup = await createBackup(backupCtx, { kind: "manual", mode: { kind: "live" } });
    s.h.target.reported = {};
    const ctx = await s.h.context({ command: "restore", answers: { "unsealed-stop": "accept", "access-changes": "accept" } });
    const result = await restoreBackup(ctx, { backupId: backup.id });
    expect(result.backupId).toBe(backup.id);
    expect(s.h.output.warn.join("\n")).toContain("cannot tell which Kestrel major the environment runs");
  });
});
