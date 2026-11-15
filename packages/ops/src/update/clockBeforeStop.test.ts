import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleStorage } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { listBackups } from "../backup.ts";
import { LOCATION } from "../harness.fixture.ts";
import { jsonBytes, keys } from "../layout.ts";
import { sha256File } from "../sqlite.ts";
import { abort } from "./abort.ts";
import { deploy } from "./deploy.ts";
import { createUpdateHarness, type UpdateHarness } from "./harness.fixture.ts";
import { readUpdateRun } from "./journal.ts";
import { updateKeys } from "./layout.ts";
import { planHash, versionSet } from "./plan.ts";
import { rollbackCommand } from "./rollback.ts";
import { continueRun, createScenario, deployUntil, runOf, type Scenario } from "./scenario.fixture.ts";
import { UPDATE_EXIT, type MigrateInput, type MigrateResult, type UpdateContext, type UpdatePlan, type UpdateReceipt } from "./types.ts";
import type * as Storages from "./storages.ts";

const storages = vi.hoisted(() => ({ list: [] as ModuleStorage[] }));
vi.mock("./storages.ts", async (importOriginal) => ({ ...(await importOriginal<typeof Storages>()), releaseStorages: async () => storages.list }));

const harnesses: UpdateHarness[] = [];
const scenarios: Scenario[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
  for (const s of scenarios.splice(0)) await s.h.dispose();
});

async function receiptFor(ctx: UpdateContext): Promise<void> {
  const plan: UpdatePlan = { versions: { from: null, to: versionSet(ctx.release.versions) }, storage: [], content: [], questions: [] };
  const hash = planHash(plan);
  const receipt: UpdateReceipt = { schema: "kestrel-ops/update-receipt@1", env: "prod", runId: "prep01", createdAt: 1, tool: ctx.tool, versions: plan.versions, planHash: hash, plan, rehearsal: { ok: true, checks: [], timings: {}, peakRssBytes: null, fullMedia: false } };
  await ctx.backups.put(LOCATION + updateKeys.receipt("prod", hash, "prep01"), jsonBytes(receipt));
}

function copyingMigration(): (ctx: UpdateContext, input: MigrateInput) => Promise<MigrateResult> {
  return async (ctx, input) => {
    const data = await ctx.backups.get(LOCATION + keys.db(input.cutoverBackup));
    if (data === null) throw new Error("no cutover database");
    writeFileSync(input.outFile, data);
    return { sha256: sha256File(input.outFile), storage: [], content: [], changedTables: [] };
  };
}

async function running(): Promise<UpdateHarness> {
  const h = createUpdateHarness();
  harnesses.push(h);
  await h.target.start();
  await h.target.app?.seed();
  return h;
}

const skewed = (ctx: UpdateContext, ms: number): UpdateContext => ({ ...ctx, clock: () => Date.now() + ms });

describe("the store's clock, checked before an update stops the app", { timeout: 60_000 }, () => {
  it("refuses a deploy from a machine whose clock is more than 30 s off the store's at the gate, with the old release serving", async () => {
    const h = await running();
    const base = await h.context({ answers: { "unsealed-stop": "accept" }, steps: { migrateCopy: copyingMigration() } });
    await receiptFor(base);
    const outcome = await deploy(skewed(base, 60_000));
    expect(outcome, outcome.message).toMatchObject({ exitCode: UPDATE_EXIT.refused, state: "untouched" });
    expect(outcome.message).toContain("production is unchanged");
    expect(outcome.message).toContain("60 s off the store's");
    expect(h.target.actions).not.toContain("stop");
    expect(h.target.actions).not.toContain("stage");
    expect((await h.target.status()).state).toBe("started");
    expect(h.target.release.runtime).toBe("5.8.1");
  });

  it("names a machine with a correct clock and update abort when the clock goes off after the stop, and abort brings the previous release back", async () => {
    const h = await running();
    let skew = 0;
    const stop = h.target.stop.bind(h.target);
    h.target.stop = async () => {
      const stopped = await stop();
      skew = 60_000;
      return stopped;
    };
    const base = await h.context({ answers: { "unsealed-stop": "accept" }, steps: { migrateCopy: copyingMigration() } });
    await receiptFor(base);
    const outcome = await deploy({ ...base, clock: () => Date.now() + skew });
    expect(outcome.exitCode, outcome.message).toBe(UPDATE_EXIT.refused);
    expect(outcome.message).toContain("whose clock is within 30 s of the store's");
    expect(outcome.message).toContain(`update abort --env prod --run ${base.run.id}`);
    expect((await h.target.status()).state).toBe("stopped");
    const run = await readUpdateRun(base, base.run.id);
    expect(run.promoted).toBeNull();
    const next = await h.context({ run, answers: {} });
    await next.journal.record("run", "started", { command: "update abort", env: "prod", phase: "abort" });
    const aborted = await abort(skewed(next, 60_000), run);
    expect(aborted, aborted.message).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "aborted" });
    expect(h.target.release.runtime).toBe("5.8.1");
    expect((await h.target.status()).state).toBe("started");
  });

  it("refuses update rollback from a machine whose clock is off before it stops the new release", async () => {
    const s = await createScenario({ from: { renders: false } });
    scenarios.push(s);
    const deployed = await deployUntil(s, "retire");
    const { ctx, run } = await continueRun(s, deployed.runId, "update rollback", { answers: { "unsealed-stop": "accept", "rollback-accepted": "prod" } });
    const refused = await rollbackCommand(skewed(ctx, -45_000), run);
    expect(refused, refused.message).toMatchObject({ exitCode: UPDATE_EXIT.refused, state: "verified" });
    expect(refused.message).toContain("45 s off the store's");
    expect((await s.h.target.status()).state).toBe("started");
    expect(s.h.target.release.runtime).toBe("6.0.0");
    expect((await listBackups(ctx)).filter((b) => b.kind === "pre-restore")).toEqual([]);
    expect((await runOf(s, deployed.runId)).records.some((r) => r.phase === "rollback" && r.step === "stop")).toBe(false);
  });

  it("refuses update abort of a started release from a machine whose clock is off before it stops it", async () => {
    const s = await createScenario({ from: { renders: false } });
    scenarios.push(s);
    const deployed = await deployUntil(s, "start");
    const { ctx, run } = await continueRun(s, deployed.runId, "update abort");
    const refused = await abort(skewed(ctx, 60_000), run);
    expect(refused, refused.message).toMatchObject({ exitCode: UPDATE_EXIT.refused, state: "verifying" });
    expect((await s.h.target.status()).state).toBe("started");
    expect(s.h.target.release.runtime).toBe("6.0.0");
  });
});
