import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok } from "@michaelthielemann/kestrel-contracts/errors";
import type { ModuleStorage } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { LOCATION, PREFIXES } from "../harness.fixture.ts";
import { Interrupted } from "../interrupt.ts";
import { jsonBytes, keys, stamp } from "../layout.ts";
import { listGenerations } from "../replica.ts";
import { sha256File } from "../sqlite.ts";
import { continueDeploy, deploy } from "./deploy.ts";
import { createUpdateHarness, type UpdateHarness, type UpdateHarnessOptions } from "./harness.fixture.ts";
import { readUpdateRun } from "./journal.ts";
import { updateKeys } from "./layout.ts";
import { planHash, versionSet } from "./plan.ts";
import type { MigrateInput, MigrateResult, RollbackReason, RollbackResult, UpdateContext, UpdatePlan, UpdateReceipt, UpdateRun, UpdateSteps } from "./types.ts";
import type * as Storages from "./storages.ts";

const storages = vi.hoisted(() => ({ list: [] as ModuleStorage[] }));
vi.mock("./storages.ts", async (importOriginal) => ({ ...(await importOriginal<typeof Storages>()), releaseStorages: async () => storages.list }));

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  storages.list = [];
  for (const h of harnesses.splice(0)) await h.dispose();
});

const ANSWERS = { "unsealed-stop": "accept" };

interface Fakes {
  rollback: ReturnType<typeof vi.fn<UpdateSteps["rollback"]>>;
  retire: ReturnType<typeof vi.fn<UpdateSteps["retire"]>>;
  migrateCopy: ReturnType<typeof vi.fn<UpdateSteps["migrateCopy"]>>;
  retiredStates: string[];
}

function fakes(): Fakes {
  const retiredStates: string[] = [];
  return {
    retiredStates,
    rollback: vi.fn(async (ctx: UpdateContext, _run: UpdateRun, reason: RollbackReason): Promise<RollbackResult> => {
      await ctx.journal.record("rollback", "started", { phase: "rollback", reason: reason.kind });
      await ctx.journal.record("rollback", "done", { phase: "rollback" });
      return { ended: "stopped", generation: "", seal: "sealed", delivery: { written: [], removed: [], relisted: 0 }, originalsRestored: [], configuration: { set: [], removed: [], unrestorable: [] }, derivedChanged: [] };
    }),
    retire: vi.fn(async (_ctx: UpdateContext, run: UpdateRun) => {
      retiredStates.push(run.state);
      return { droplets: [], revisions: [], savedDroplet: null };
    }),
    migrateCopy: vi.fn(async (ctx: UpdateContext, input: MigrateInput): Promise<MigrateResult> => {
      const data = await ctx.backups.get(LOCATION + keys.db(input.cutoverBackup));
      if (data === null) throw new Error("no cutover database");
      writeFileSync(input.outFile, data);
      return { sha256: sha256File(input.outFile), storage: [], content: [], changedTables: [] };
    }),
  };
}

interface Scenario {
  h: UpdateHarness;
  ctx: UpdateContext;
  steps: Fakes;
}

async function receiptFor(ctx: UpdateContext, storage: UpdatePlan["storage"] = []): Promise<void> {
  const plan: UpdatePlan = { versions: { from: null, to: versionSet(ctx.release.versions) }, storage, content: [], questions: [] };
  const hash = planHash(plan);
  const receipt: UpdateReceipt = { schema: "kestrel-ops/update-receipt@1", env: "prod", runId: "prep01", createdAt: 1, tool: ctx.tool, versions: plan.versions, planHash: hash, plan, rehearsal: { ok: true, checks: [], timings: {}, peakRssBytes: null, fullMedia: false } };
  await ctx.backups.put(LOCATION + updateKeys.receipt("prod", hash, "prep01"), jsonBytes(receipt));
}

async function scenario(options: UpdateHarnessOptions = {}, receipt = true): Promise<Scenario> {
  const h = createUpdateHarness(options);
  harnesses.push(h);
  await h.target.start();
  await h.target.app?.seed();
  const steps = fakes();
  const ctx = await h.context({ answers: ANSWERS, steps: { rollback: steps.rollback, retire: steps.retire, migrateCopy: steps.migrateCopy } });
  if (receipt) await receiptFor(ctx);
  return { h, ctx, steps };
}

const deployRecords = (run: UpdateRun): string[] => run.records.filter((r) => r.phase === "deploy").map((r) => `${r.step}:${r.state}`);
const afterStop = (s: Scenario): string[] => s.h.target.actions.slice(s.h.target.actions.indexOf("stop") + 1);

describe("deploying 5.8.1 to 6.0 on the stand-in target", { timeout: 30_000 }, () => {
  it("stages before the stop, swaps and starts right after the promotion, verifies, retires and reports the downtime per step", async () => {
    const s = await scenario();
    const before = s.h.target.current;
    const outcome = await deploy(s.ctx);
    expect(outcome.message).toContain("verified");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.state).toBe("verified");
    const staged = s.h.target.current;
    expect(staged).not.toBe(before);
    expect(s.h.target.actions).toEqual(["start", "stage", "stop", `set-droplet ${staged}`, "apply-release-configuration", "start"]);
    const run = await readUpdateRun(s.ctx, s.ctx.run.id);
    const records = deployRecords(run);
    const promoted = records.indexOf("promote:done");
    expect(records.slice(promoted + 1, promoted + 4)).toEqual(["swap:started", "swap:done", "start:started"]);
    const done = run.records.filter((r) => r.phase === "deploy" && r.state === "done" && r.step !== "backup" && r.step !== "run-done").map((r) => r.step);
    expect(done).toEqual(["gate", "stage", "configuration", "precopy", "stop", "seal", "cutover-backup", "migrate", "promote", "swap", "start", "verify", "retire"]);
    expect(run.records.find((r) => r.step === "gate" && r.state === "done")?.data.receipt).toMatch(/^[0-9a-f]{64}\/prep01$/);
    expect(s.steps.retire).toHaveBeenCalledTimes(1);
    expect(s.steps.retiredStates).toEqual(["verified"]);
    expect(s.steps.rollback).not.toHaveBeenCalled();
    expect(await s.h.store.head(LOCATION + updateKeys.configuration("prod", s.ctx.run.id))).not.toBeNull();
    const byStep = new Map(outcome.report.steps.map((t) => [t.step, t]));
    expect(byStep.get("stage")?.appDown).toBe(false);
    expect(byStep.get("cutover-backup")?.appDown).toBe(true);
    expect(byStep.get("promote")?.ms).toEqual(expect.any(Number));
    expect(outcome.report.downtimeMs).toEqual(expect.any(Number));
  });

  it("ends with exit 1 before anything changed when staging fails, and never stops the app", async () => {
    const s = await scenario();
    const before = s.h.target.current;
    s.h.target.failStaging = "buildpack error";
    const outcome = await deploy(s.ctx);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.state).toBe("untouched");
    expect(s.h.target.actions).toEqual(["start", "stage"]);
    expect(s.h.target.actions).not.toContain("stop");
    expect((await s.h.target.status()).state).toBe("started");
    expect(s.h.target.current).toBe(before);
  });

  it("refuses a version change without a receipt before staging", async () => {
    const s = await scenario({}, false);
    const outcome = await deploy(s.ctx);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.state).toBe("untouched");
    expect(s.h.target.actions).toEqual(["start"]);
  });

  it.each([
    ["crashes at boot", { crashes: true }],
    ["answers 503", { ready: "not-ready" as const }],
  ])("rolls back automatically with exit 3 when the new release %s", async (_name, to) => {
    const s = await scenario({ to });
    const outcome = await deploy(s.ctx);
    expect(outcome.exitCode).toBe(3);
    expect(s.steps.rollback).toHaveBeenCalledTimes(1);
    expect(s.steps.rollback.mock.calls[0]?.[2]).toMatchObject({ kind: "automatic" });
    expect(s.steps.retire).not.toHaveBeenCalled();
    const run = await readUpdateRun(s.ctx, s.ctx.run.id);
    expect(run.records.find((r) => r.step === "verify" && r.state === "done")?.data.verdict).toBe("failed");
  });

  it.each(["forbidden", "unreachable"] as const)("halts with exit 1 and leaves the new release running when readiness is %s", async (ready) => {
    const s = await scenario({ to: { ready } });
    const outcome = await deploy(s.ctx);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.state).toBe("halted");
    expect(s.steps.rollback).not.toHaveBeenCalled();
    expect(s.steps.retire).not.toHaveBeenCalled();
    expect((await s.h.target.status()).state).toBe("started");
    expect(s.h.target.release.ready).toBe(ready);
  });

  it("refuses every later deploy while a halted run is open, also after the gate refused one", async () => {
    const s = await scenario({ to: { ready: "forbidden" } });
    const halted = await deploy(s.ctx);
    expect(halted.state).toBe("halted");
    s.h.target.release.ready = "ready";
    for (const attempt of [1, 2]) {
      const ctx = await s.h.context({ answers: ANSWERS, steps: { rollback: s.steps.rollback, retire: s.steps.retire, migrateCopy: s.steps.migrateCopy } });
      const outcome = await deploy(ctx);
      expect(outcome.exitCode, `attempt ${attempt}`).toBe(1);
      expect(outcome.message).toContain(`update run ${s.ctx.run.id} is halted`);
    }
    expect(s.steps.retire).not.toHaveBeenCalled();
    expect((await readUpdateRun(s.ctx, s.ctx.run.id)).state).toBe("halted");
    expect(s.h.target.actions.filter((a) => a === "stop")).toHaveLength(1);
  });
});

describe("continuing an interrupted deploy", { timeout: 30_000 }, () => {
  async function killedAfterPromote(): Promise<{ s: Scenario; run: UpdateRun }> {
    const s = await scenario();
    const setDroplet = s.h.target.setDroplet.bind(s.h.target);
    s.h.target.setDroplet = async () => {
      s.h.target.setDroplet = setDroplet;
      throw new Interrupted("SIGTERM");
    };
    await expect(deploy(s.ctx)).rejects.toBeInstanceOf(Interrupted);
    const run = await readUpdateRun(s.ctx, s.ctx.run.id);
    expect(run.lastDone).toEqual({ phase: "deploy", step: "promote" });
    expect(run.state).toBe("down");
    return { s, run };
  }

  it("swaps, starts and verifies a run killed after the promotion", async () => {
    const { s, run } = await killedAfterPromote();
    const ctx = await s.h.context({ run, answers: ANSWERS, steps: { rollback: s.steps.rollback, retire: s.steps.retire } });
    const outcome = await continueDeploy(ctx, run);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.state).toBe("verified");
    expect(afterStop(s)).toEqual([`set-droplet ${run.stagedDroplet ?? ""}`, "apply-release-configuration", "start"]);
    expect(s.steps.retire).toHaveBeenCalledTimes(1);
  });

  it("refuses when the promoted generation is not the newest any more", async () => {
    const { s, run } = await killedAfterPromote();
    const promoted = run.promoted?.generation ?? "";
    const snapshot = await s.h.store.get(`${PREFIXES.replica}gen/${promoted}/snapshot.db`);
    if (snapshot === null) throw new Error("no promoted snapshot");
    await s.h.store.put(`${PREFIXES.replica}gen/${stamp(Date.now() + 5000)}/snapshot.db`, snapshot);
    expect((await listGenerations(s.h.store, PREFIXES.replica)).at(-1)?.name).not.toBe(promoted);
    const ctx = await s.h.context({ run, answers: ANSWERS, steps: { rollback: s.steps.rollback, retire: s.steps.retire } });
    const outcome = await continueDeploy(ctx, run);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.message).toContain("not the newest");
    expect(afterStop(s)).toEqual([]);
  });

  it("starts a migration killed in the middle again from the cutover backup", async () => {
    const pending: UpdatePlan["storage"] = [{ module: "media/default", id: "media-default:key-layout", kind: "auto", blobWrites: true, pending: 2 }];
    storages.list = [{ module: "media/default", version: "6.0.0", convertsFrom: "5.0.0", migrations: [{ id: "media-default:key-layout", introducedIn: "6.0.0", kind: "auto", blobWrites: true, summary: "moves originals", detect: async () => ok({ pending: 2, sample: [] }), plan: async () => ok({ counts: {}, notes: [] }), apply: async () => ok({ counts: {}, notes: [] }) }] }];
    const h = createUpdateHarness();
    harnesses.push(h);
    const scope = join(h.releaseDir, "node_modules", "@michaelthielemann");
    mkdirSync(scope, { recursive: true });
    symlinkSync(resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "..", "persistence-sqlite"), join(scope, "kestrel-persistence-sqlite"));
    await h.target.start();
    await h.target.app?.seed();
    const steps = fakes();
    const real = steps.migrateCopy.getMockImplementation();
    steps.migrateCopy.mockImplementationOnce(async () => {
      throw new Interrupted("SIGTERM");
    });
    const ctx = await h.context({ answers: ANSWERS, steps: { rollback: steps.rollback, retire: steps.retire, migrateCopy: steps.migrateCopy } });
    await receiptFor(ctx, pending);
    await expect(deploy(ctx)).rejects.toBeInstanceOf(Interrupted);
    const run = await readUpdateRun(ctx, ctx.run.id);
    expect(run.lastDone).toEqual({ phase: "deploy", step: "cutover-backup" });
    if (real !== undefined) steps.migrateCopy.mockImplementation(real);
    const resumed = await h.context({ run, answers: ANSWERS, steps: { rollback: steps.rollback, retire: steps.retire, migrateCopy: steps.migrateCopy } });
    const outcome = await continueDeploy(resumed, run);
    expect(outcome.exitCode).toBe(0);
    expect(steps.migrateCopy).toHaveBeenCalledTimes(2);
    expect(steps.migrateCopy.mock.calls.map((call) => call[1].cutoverBackup)).toEqual([run.cutoverBackup, run.cutoverBackup]);
  });
});
