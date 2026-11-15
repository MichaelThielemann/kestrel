import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok } from "@michaelthielemann/kestrel-contracts/errors";
import type { ModuleStorage } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { LOCATION, PREFIXES } from "../harness.fixture.ts";
import { Interrupted } from "../interrupt.ts";
import { jsonBytes, keys, parseJsonOrNull, stamp } from "../layout.ts";
import { MemoryBucket, memoryStore } from "../memoryStore.ts";
import { listGenerations } from "../replica.ts";
import { sha256File } from "../sqlite.ts";
import type { ObjectStore } from "../store.ts";
import { abort } from "./abort.ts";
import { accept } from "./accept.ts";
import { continueDeploy, deploy } from "./deploy.ts";
import { createUpdateHarness, type UpdateHarness, type UpdateHarnessOptions } from "./harness.fixture.ts";
import { readUpdateRun } from "./journal.ts";
import { resume } from "./resume.ts";
import { rollback } from "./rollback.ts";
import { updateKeys } from "./layout.ts";
import { planHash, versionSet } from "./plan.ts";
import { updateStatus } from "./status.ts";
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
      await ctx.journal.record("rollback", "done", { phase: "rollback", ended: "previous-release" });
      return { ended: "previous-release", generation: "", seal: "sealed", delivery: { written: [], removed: [], relisted: 0 }, originalsRestored: [], configuration: { set: [], removed: [], unrestorable: [] }, derived: { added: [], changed: [], missing: [] } };
    }),
    retire: vi.fn(async (_ctx: UpdateContext, run: UpdateRun) => {
      retiredStates.push(run.state);
      return { droplets: [], revisions: [], savedDroplet: null, kept: [] };
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
    expect(await s.h.store.head(LOCATION + updateKeys.pin(run.cutoverBackup ?? "", s.ctx.run.id))).not.toBeNull();
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

  it("rolls back and retires nothing when the new release crashes while verification waits for its sync and render", async () => {
    const s = await scenario();
    const probe = s.h.target.probeReady.bind(s.h.target);
    let crashed = false;
    s.h.target.probeReady = async () => {
      if (!crashed && s.h.target.release.runtime === "6.0.0") {
        crashed = true;
        s.h.target.crashes.push({ at: Date.now(), type: "audit.app.process.crash", reason: "APP/PROC/WEB: Exited with status 137 (out of memory)" });
      }
      return probe();
    };
    const outcome = await deploy(s.ctx);
    expect(crashed).toBe(true);
    expect(s.steps.rollback).toHaveBeenCalledTimes(1);
    expect(s.steps.retire).not.toHaveBeenCalled();
    expect(s.h.target.droplets.size).toBe(2);
    const verify = (await readUpdateRun(s.ctx, s.ctx.run.id)).records.find((r) => r.step === "verify" && r.state === "done");
    expect(verify?.data.verdict).toBe("failed");
    expect(outcome.message).toContain("crashes: ");
  });

  it("ends with exit 1, says the app stays stopped and names a deploy of the previous release when the automatic rollback could start no previous droplet", async () => {
    const s = await scenario({ to: { ready: "not-ready" } });
    s.steps.rollback.mockImplementation(async (ctx: UpdateContext): Promise<RollbackResult> => {
      await ctx.journal.record("rollback", "started", { phase: "rollback", reason: "automatic" });
      await ctx.journal.record("rollback", "done", { phase: "rollback", ended: "stopped" });
      return { ended: "stopped", generation: "", seal: "sealed", delivery: { written: [], removed: [], relisted: 0 }, originalsRestored: [], configuration: { set: [], removed: [], unrestorable: [] }, derived: { added: [], changed: [], missing: [] } };
    });
    const outcome = await deploy(s.ctx);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.state).toBe("rolled-back");
    expect(outcome.message).toContain("stays stopped");
    expect(outcome.message).not.toContain("rolled back to the cutover state");
    expect((await updateStatus(s.ctx, s.ctx.run.id)).run?.next).toBe("node .kestrel-ops/run.mjs deploy --env prod");
  });

  it("ends with exit 1 and says the app stays stopped when the rollback after a failed step could start no previous droplet", async () => {
    const s = await scenario();
    s.steps.rollback.mockImplementation(async (ctx: UpdateContext): Promise<RollbackResult> => {
      await ctx.journal.record("rollback", "started", { phase: "rollback", reason: "automatic" });
      await ctx.journal.record("rollback", "done", { phase: "rollback", ended: "stopped" });
      return { ended: "stopped", generation: "", seal: "sealed", delivery: { written: [], removed: [], relisted: 0 }, originalsRestored: [], configuration: { set: [], removed: [], unrestorable: [] }, derived: { added: [], changed: [], missing: [] } };
    });
    const setDroplet = s.h.target.setDroplet.bind(s.h.target);
    s.h.target.setDroplet = async () => {
      s.h.target.setDroplet = setDroplet;
      throw new Error("platform error");
    };
    const outcome = await deploy(s.ctx);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.message).toContain("stays stopped");
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

  function stopThenFail(s: Scenario): void {
    const stop = s.h.target.stop.bind(s.h.target);
    s.h.target.stop = async () => {
      s.h.target.stop = stop;
      await stop();
      throw new Error("the app was stopped, and 120 s later its state could not be read; it stays stopped");
    };
  }

  it("starts the previous release again when the stop fails after it stopped the app", async () => {
    const s = await scenario();
    stopThenFail(s);
    const outcome = await deploy(s.ctx);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.state).toBe("untouched");
    expect(outcome.message).toContain("the previous release runs");
    expect(outcome.message).not.toContain("production is unchanged");
    expect(s.h.target.actions).toEqual(["start", "stage", "stop", "start"]);
    expect((await s.h.target.status()).state).toBe("started");
  });

  it("leaves a run that abort ends when the stop fails after it stopped the app and the app does not start again", async () => {
    const s = await scenario();
    stopThenFail(s);
    const start = s.h.target.start.bind(s.h.target);
    s.h.target.start = async () => {
      throw new Error("start refused");
    };
    const outcome = await deploy(s.ctx);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.state).toBe("down");
    expect(outcome.message).toContain(`update abort --env prod --run ${s.ctx.run.id}`);
    expect(outcome.message).not.toContain("production is unchanged");
    expect((await s.h.target.status()).state).toBe("stopped");
    const run = await readUpdateRun(s.ctx, s.ctx.run.id);
    expect((await updateStatus(s.ctx, s.ctx.run.id)).run?.next).toBe(`kestrel update abort --env prod --run ${s.ctx.run.id}`);
    const resumed = await continueDeploy(await s.h.context({ run, answers: ANSWERS }), run);
    expect(resumed.exitCode).toBe(1);
    expect(resumed.message).toContain("update abort");
    s.h.target.start = start;
    const latest = await readUpdateRun(s.ctx, s.ctx.run.id);
    const aborted = await abort(await s.h.context({ run: latest, answers: ANSWERS }), latest);
    expect(aborted.exitCode).toBe(0);
    expect(aborted.state).toBe("aborted");
    expect((await s.h.target.status()).state).toBe("started");
  });

  it("halts with exit 1 and keeps the new release running when the store cannot be read during verification", async () => {
    const s = await scenario();
    const store = s.ctx.app;
    let armed = false;
    s.ctx.app = {
      ...store,
      list: async (prefix) => {
        if (armed && prefix.startsWith(PREFIXES.replica)) {
          armed = false;
          throw new Error("connect ETIMEDOUT");
        }
        return store.list(prefix);
      },
    };
    const steps = s.ctx.steps;
    s.ctx.steps = {
      ...steps,
      verify: async (ctx, input) => {
        armed = true;
        return steps.verify(ctx, input);
      },
    };
    const outcome = await deploy(s.ctx);
    expect(outcome.exitCode, outcome.message).toBe(1);
    expect(outcome.state).toBe("halted");
    expect(outcome.message).toContain("connect ETIMEDOUT");
    expect(s.steps.rollback).not.toHaveBeenCalled();
    expect(s.steps.retire).not.toHaveBeenCalled();
    expect((await s.h.target.status()).state).toBe("started");
    expect(s.h.target.release.runtime).toBe("6.0.0");
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

describe("the versions the cutover backup records", { timeout: 30_000 }, () => {
  const media: ModuleStorage = { module: "media/default", version: "6.0.0", convertsFrom: "5.0.0", migrations: [{ id: "media-default:key-layout", introducedIn: "6.0.0", kind: "auto", blobWrites: true, summary: "moves originals", detect: async () => ok({ pending: 2, sample: [] }), plan: async () => ok({ counts: {}, notes: [] }), apply: async () => ok({ counts: {}, notes: [] }) }] };

  async function cutoverManifest(s: Scenario): Promise<Record<string, unknown>> {
    const run = await readUpdateRun(s.ctx, s.ctx.run.id);
    const data = await s.h.store.get(LOCATION + keys.manifest(run.cutoverBackup ?? ""));
    const value: unknown = data === null ? null : parseJsonOrNull(data);
    if (typeof value !== "object" || value === null) throw new Error("no cutover manifest");
    return Object.fromEntries(Object.entries(value));
  }

  it("records the running versions, whatever the target reports once the cutover backup is taken", async () => {
    const s = await scenario();
    const describe = s.h.target.describe.bind(s.h.target);
    let calls = 0;
    s.h.target.describe = async () => {
      calls += 1;
      const facts = await describe();
      return calls === 1 ? facts : { ...facts, packages: { "@michaelthielemann/kestrel": "6.0.0", "@michaelthielemann/kestrel-replication-sqlite": "6.0.0" } };
    };
    const outcome = await deploy(s.ctx);
    expect(outcome.exitCode, outcome.message).toBe(0);
    expect((await cutoverManifest(s)).versions).toMatchObject({ "@michaelthielemann/kestrel": "5.8.1" });
  });

  it("records the major the pending storage migrations convert from when the running versions are unknown", async () => {
    storages.list = [media];
    const s = await scenario({}, false);
    await receiptFor(s.ctx, [{ module: "media/default", id: "media-default:key-layout", kind: "auto", blobWrites: true, pending: 2 }]);
    const describe = s.h.target.describe.bind(s.h.target);
    s.h.target.describe = async () => ({ ...(await describe()), packages: {} });
    const scope = join(s.h.releaseDir, "node_modules", "@michaelthielemann");
    mkdirSync(scope, { recursive: true });
    symlinkSync(resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "..", "persistence-sqlite"), join(scope, "kestrel-persistence-sqlite"));
    const outcome = await deploy(s.ctx);
    expect(outcome.exitCode, outcome.message).toBe(0);
    const manifest = await cutoverManifest(s);
    expect(manifest.versions).toEqual({});
    expect(manifest.major).toBe(5);
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

  it("keeps the recorded start time of a run killed while it waited for readiness, so the render of that start counts and the release is verified", async () => {
    const s = await scenario();
    const waitReady = s.h.target.waitReady.bind(s.h.target);
    s.h.target.waitReady = async () => {
      s.h.target.waitReady = waitReady;
      throw new Interrupted("SIGTERM");
    };
    await expect(deploy(s.ctx)).rejects.toBeInstanceOf(Interrupted);
    const run = await readUpdateRun(s.ctx, s.ctx.run.id);
    expect(run.state).toBe("verifying");
    expect((await s.h.target.status()).state).toBe("started");
    await new Promise((done) => setTimeout(done, 1500));
    const ctx = await s.h.context({ run, answers: ANSWERS, steps: { rollback: s.steps.rollback, retire: s.steps.retire } });
    const outcome = await continueDeploy(ctx, run);
    expect(outcome.exitCode, outcome.message).toBe(0);
    expect(outcome.state).toBe("verified");
    expect(s.steps.rollback).not.toHaveBeenCalled();
    const starts = (await readUpdateRun(ctx, run.runId)).records.filter((r) => r.phase === "deploy" && r.step === "start").map((r) => r.data.startedAt);
    expect(new Set(starts).size).toBe(1);
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

describe("continuing a deploy from another process than the one that started it", { timeout: 30_000 }, () => {
  async function killedInMigration(options: UpdateHarnessOptions): Promise<{ h: UpdateHarness; steps: Fakes; run: UpdateRun }> {
    const h = createUpdateHarness(options);
    harnesses.push(h);
    await h.target.start();
    await h.target.app?.seed();
    const steps = fakes();
    const real = steps.migrateCopy.getMockImplementation();
    steps.migrateCopy.mockImplementationOnce(async () => {
      throw new Interrupted("SIGTERM");
    });
    const ctx = await h.context({ answers: ANSWERS, steps: { rollback: steps.rollback, retire: steps.retire, migrateCopy: steps.migrateCopy } });
    ctx.host = { contentMigrations: ["count-hits"] };
    await expect(deploy(ctx)).rejects.toBeInstanceOf(Interrupted);
    if (real !== undefined) steps.migrateCopy.mockImplementation(real);
    const run = await readUpdateRun(ctx, ctx.run.id);
    expect(run.lastDone).toEqual({ phase: "deploy", step: "cutover-backup" });
    return { h, steps, run };
  }

  it("refuses with exit 2 to continue an ordinary run without the content migrations the gate planned, so the unmigrated copy is never promoted, and continues it with them", async () => {
    const { h, steps, run } = await killedInMigration({ from: { runtime: "6.0.0" }, to: { runtime: "6.0.0" } });
    expect(run.receipt).toBeNull();
    const bare = await h.context({ run, answers: ANSWERS, steps: { rollback: steps.rollback, retire: steps.retire, migrateCopy: steps.migrateCopy } });
    const refused = await continueDeploy(bare, run);
    expect(refused.exitCode, refused.message).toBe(2);
    expect(refused.state).toBe("down");
    expect(refused.message).toContain("count-hits");
    expect(refused.message).toContain("node .kestrel-ops/run.mjs update resume");
    expect(steps.migrateCopy).toHaveBeenCalledTimes(1);
    expect(steps.retire).not.toHaveBeenCalled();
    const withFacts = await h.context({ run, answers: ANSWERS, steps: { rollback: steps.rollback, retire: steps.retire, migrateCopy: steps.migrateCopy } });
    withFacts.host = { contentMigrations: ["count-hits"] };
    const outcome = await continueDeploy(withFacts, run);
    expect(outcome.exitCode, outcome.message).toBe(0);
    expect(steps.migrateCopy).toHaveBeenCalledTimes(2);
    expect(steps.migrateCopy.mock.calls[1]?.[1].plan.content).toEqual(["count-hits"]);
  });

  it("refuses with exit 2 to continue a promoted run from a process whose release has other versions, before it swaps", async () => {
    const s = await scenario();
    const setDroplet = s.h.target.setDroplet.bind(s.h.target);
    s.h.target.setDroplet = async () => {
      s.h.target.setDroplet = setDroplet;
      throw new Interrupted("SIGTERM");
    };
    await expect(deploy(s.ctx)).rejects.toBeInstanceOf(Interrupted);
    const run = await readUpdateRun(s.ctx, s.ctx.run.id);
    expect(run.lastDone).toEqual({ phase: "deploy", step: "promote" });
    const other = await s.h.context({ run, answers: ANSWERS, steps: { rollback: s.steps.rollback, retire: s.steps.retire } });
    other.release = { ...other.release, versions: { "@michaelthielemann/kestrel": "5.8.1", "@michaelthielemann/kestrel-replication-sqlite": "5.8.1" } };
    const refused = await continueDeploy(other, run);
    expect(refused.exitCode, refused.message).toBe(2);
    expect(refused.message).toContain("5.8.1");
    expect(afterStop(s)).toEqual([]);
    expect(s.steps.retire).not.toHaveBeenCalled();
  });
});

describe("the next command a failed deploy names", { timeout: 30_000 }, () => {
  it("names update resume when the automatic rollback before the cutover backup does not finish, and resume finishes it", async () => {
    const s = await scenario();
    const ctx = s.ctx;
    ctx.steps = {
      ...ctx.steps,
      rollback,
      waitForSeal: async () => {
        throw new Error("seal timeout");
      },
    };
    const start = s.h.target.start.bind(s.h.target);
    s.h.target.start = async () => {
      s.h.target.start = start;
      throw new Error("start refused");
    };
    const outcome = await deploy(ctx);
    expect(outcome.exitCode, outcome.message).toBe(1);
    expect(outcome.state, outcome.message).toBe("rolling-back");
    expect(outcome.message).toContain(`run update resume --env prod --run ${ctx.run.id}`);
    expect(outcome.message).not.toContain("update rollback");
    expect((await updateStatus(ctx, ctx.run.id)).run?.next).toBe(`kestrel update resume --env prod --run ${ctx.run.id}`);
    const run = await readUpdateRun(ctx, ctx.run.id);
    const resumed = await resume(await s.h.context({ run, answers: ANSWERS }), run);
    expect(resumed).toMatchObject({ exitCode: 3, state: "rolled-back" });
    expect((await s.h.target.status()).state).toBe("started");
  });

  it("names update abort, without claiming nothing changed, for a run that began its stop and was cut off", async () => {
    const s = await scenario();
    await s.ctx.journal.record("gate", "done", { phase: "deploy" });
    await s.ctx.journal.record("stage", "done", { phase: "deploy", droplet: "staged-droplet" });
    await s.ctx.journal.record("stop", "started", { phase: "deploy" });
    const run = await readUpdateRun(s.ctx, s.ctx.run.id);
    expect(run.state).toBe("deploying");
    expect((await updateStatus(s.ctx, run.runId)).run?.next).toBe(`kestrel update abort --env prod --run ${run.runId}`);
    const outcome = await continueDeploy(await s.h.context({ run, answers: ANSWERS }), run);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.message).toContain(`update abort --env prod --run ${run.runId}`);
    expect(outcome.message).not.toContain("nothing changed yet");
  });
});

describe("the automatic rollback of a deploy whose journal listing lags", { timeout: 30_000 }, () => {
  function laggingJournal(store: ObjectStore): ObjectStore {
    const hidden = new Set<string>();
    let lagging = false;
    return {
      ...store,
      id: store.id,
      locate: (key) => store.locate(key),
      head: (key) => store.head(key),
      get: (key) => store.get(key),
      read: (key, options) => store.read(key, options),
      copy: (source, key, options) => store.copy(source, key, options),
      delete: (key) => store.delete(key),
      put: async (key, data, options) => {
        if (key.startsWith(`${LOCATION}runs/`) && key.endsWith("-cutover-backup-done.json")) lagging = true;
        if (lagging && key.startsWith(`${LOCATION}runs/`)) hidden.add(key);
        await store.put(key, data, options);
      },
      list: async (prefix) => (await store.list(prefix)).filter((info) => !hidden.has(info.key)),
    };
  }

  it("rolls a failed swap back to the cutover state it knows, so the previous release never starts on the promoted generation", async () => {
    const h = createUpdateHarness({ store: laggingJournal(memoryStore(new MemoryBucket("kestrel-test"))) });
    harnesses.push(h);
    await h.target.start();
    await h.target.app?.seed();
    const steps = fakes();
    steps.migrateCopy.mockImplementation(async (ctx, input) => {
      const data = await ctx.backups.get(LOCATION + keys.db(input.cutoverBackup));
      if (data === null) throw new Error("no cutover database");
      writeFileSync(input.outFile, data);
      const db = new DatabaseSync(input.outFile);
      db.exec(`CREATE TABLE "converted_shape" ("version" INTEGER)`);
      db.close();
      return { sha256: sha256File(input.outFile), storage: [], content: [], changedTables: ["converted_shape"] };
    });
    const ctx = await h.context({ answers: ANSWERS, steps: { retire: steps.retire, migrateCopy: steps.migrateCopy } });
    await receiptFor(ctx);
    const setDroplet = h.target.setDroplet.bind(h.target);
    h.target.setDroplet = async () => {
      h.target.setDroplet = setDroplet;
      throw new Error("platform error");
    };
    const violations: string[] = [];
    const start = h.target.start.bind(h.target);
    h.target.start = async () => {
      const newest = (await listGenerations(h.store, PREFIXES.replica)).at(-1);
      const origin = newest === undefined ? null : await h.store.get(`${PREFIXES.replica}gen/${newest.name}/origin.json`);
      const value: unknown = origin === null ? null : parseJsonOrNull(origin);
      if (h.target.release.runtime.startsWith("5.") && typeof value === "object" && value !== null && Reflect.get(value, "kind") === "upgrade") violations.push(`runtime ${h.target.release.runtime} started on ${newest?.name ?? ""}`);
      return start();
    };
    const outcome = await deploy(ctx);
    expect(outcome.exitCode, outcome.message).toBe(3);
    expect(outcome.message).toContain("rolled back to the cutover state");
    expect(violations).toEqual([]);
    expect(() => h.target.app?.rows("converted_shape")).toThrow("no such table");
  });
});

describe("a deploy whose journal write fails once after the promotion", { timeout: 30_000 }, () => {
  it("rolls back automatically, starts the previous release on the cutover state and leaves the run readable for status and the next deploy", async () => {
    const plain = memoryStore(new MemoryBucket("kestrel-test"));
    let refused = 0;
    const store: ObjectStore = {
      ...plain,
      put: async (key, data, options) => {
        if (refused === 0 && key.startsWith(`${LOCATION}runs/`) && key.endsWith("-promote-done.json")) {
          refused += 1;
          throw new Error("socket hang up");
        }
        await plain.put(key, data, options);
      },
    };
    const h = createUpdateHarness({ store });
    harnesses.push(h);
    await h.target.start();
    await h.target.app?.seed();
    const steps = fakes();
    const ctx = await h.context({ answers: ANSWERS, steps: { retire: steps.retire, migrateCopy: steps.migrateCopy } });
    await receiptFor(ctx);
    const outcome = await deploy(ctx);
    expect(refused).toBe(1);
    expect(outcome.exitCode, outcome.message).toBe(3);
    expect(outcome.state).toBe("rolled-back");
    expect((await h.target.status()).state).toBe("started");
    expect(h.target.release.runtime).toBe("5.8.1");
    const run = await readUpdateRun(ctx, ctx.run.id);
    expect(run.records.map((r) => r.seq)).toEqual(run.records.map((_, i) => i + 1));
    expect(run.records.find((r) => r.step === "promote" && r.state === "failed")?.data.error).toBe("socket hang up");
    const report = await updateStatus(ctx, ctx.run.id);
    expect(report.run?.state).toBe("rolled-back");
    expect(report.open).toEqual([]);
    const next = await h.context({ answers: ANSWERS, steps: { retire: steps.retire, migrateCopy: steps.migrateCopy } });
    const again = await deploy(next);
    expect(again.exitCode, again.message).toBe(0);
  });
});

describe("the configuration a deploy records", { timeout: 30_000 }, () => {
  const SHARED = "shared-bucket-secret-7f2a";

  it("keeps a plain variable whose value holds a secret of the tool only as a fingerprint, so the rollback leaves its value as it is", async () => {
    const h = createUpdateHarness({ to: { ready: "not-ready" } });
    harnesses.push(h);
    Object.assign(h.target.configuration.env, { STORAGE_SECRET: SHARED, STORAGE_URL: `https://user:${SHARED}@store.example.net`, SITE_NAME: "Studio" });
    await h.target.start();
    await h.target.app?.seed();
    const steps = fakes();
    const ctx = await h.context({ answers: ANSWERS, steps: { retire: steps.retire, migrateCopy: steps.migrateCopy } });
    ctx.redactor.add(SHARED);
    await receiptFor(ctx);
    const outcome = await deploy(ctx);
    expect(outcome.exitCode, outcome.message).toBe(3);
    const text = new TextDecoder().decode((await h.store.get(LOCATION + updateKeys.configuration("prod", ctx.run.id))) ?? new Uint8Array());
    expect(text).not.toContain("[redacted]");
    expect(text).not.toContain(SHARED);
    const recorded: unknown = JSON.parse(text);
    const env: unknown = typeof recorded === "object" && recorded !== null ? Reflect.get(recorded, "env") : null;
    for (const name of ["STORAGE_SECRET", "STORAGE_URL"]) expect(JSON.stringify(env)).toMatch(new RegExp(`"${name}":\\{"fingerprint":"[0-9a-f]{64}"\\}`));
    expect(env).toMatchObject({ SITE_NAME: { value: "Studio" } });
    expect(h.target.configuration.env).toMatchObject({ STORAGE_SECRET: SHARED, STORAGE_URL: `https://user:${SHARED}@store.example.net`, SITE_NAME: "Studio" });
  });
});

describe("a verified deploy whose retire of the previous releases does not finish", { timeout: 30_000 }, () => {
  it("ends with exit 1, says the old releases can still start, names update resume, and resume retires them", async () => {
    const s = await scenario();
    s.steps.retire.mockImplementationOnce(async () => {
      throw new Error("cf curl -X DELETE /v3/droplets/old exited with 1");
    });
    const outcome = await deploy(s.ctx);
    expect(outcome.exitCode, outcome.message).toBe(1);
    expect(outcome.state).toBe("verified");
    expect(outcome.message).toContain("can still be started");
    expect(outcome.message).toContain(`update resume --env prod --run ${s.ctx.run.id}`);
    expect((await updateStatus(s.ctx, s.ctx.run.id)).run?.next).toBe(`kestrel update resume --env prod --run ${s.ctx.run.id}`);
    const run = await readUpdateRun(s.ctx, s.ctx.run.id);
    const resumed = await resume(await s.h.context({ run, answers: ANSWERS, steps: { retire: s.steps.retire } }), run);
    expect(resumed.exitCode, resumed.message).toBe(0);
    expect(resumed.state).toBe("verified");
    expect(s.steps.retire).toHaveBeenCalledTimes(2);
    const after = await readUpdateRun(s.ctx, s.ctx.run.id);
    expect(after.records.filter((r) => r.step === "retire").map((r) => r.state)).toEqual(["started", "failed", "started", "done"]);
    expect((await updateStatus(s.ctx, s.ctx.run.id)).run?.next).toBe(`kestrel update accept --env prod --run ${s.ctx.run.id}`);
  });

  it("records the retire as failed and keeps it pending when a signal cuts it off", async () => {
    const s = await scenario();
    s.steps.retire.mockImplementationOnce(async () => {
      throw new Interrupted("SIGTERM");
    });
    await expect(deploy(s.ctx)).rejects.toThrow("update resume");
    const run = await readUpdateRun(s.ctx, s.ctx.run.id);
    expect(run.state).toBe("verified");
    expect(run.records.filter((r) => r.step === "retire").map((r) => r.state)).toEqual(["started", "failed"]);
    expect((await updateStatus(s.ctx, run.runId)).run?.next).toBe(`kestrel update resume --env prod --run ${run.runId}`);
  });

  it("retires them before update accept records the accept, and refuses the accept while they cannot be retired", async () => {
    const s = await scenario();
    s.steps.retire.mockImplementationOnce(async () => {
      throw new Error("cf api 502");
    });
    expect((await deploy(s.ctx)).exitCode).toBe(1);
    s.steps.retire.mockImplementationOnce(async () => {
      throw new Error("cf api 502 again");
    });
    const run = await readUpdateRun(s.ctx, s.ctx.run.id);
    const refused = await accept(await s.h.context({ run, answers: ANSWERS, steps: { retire: s.steps.retire } }), run);
    expect(refused.exitCode).toBe(1);
    expect(refused.state).toBe("verified");
    expect(refused.message).toContain("cf api 502 again");
    const again = await readUpdateRun(s.ctx, s.ctx.run.id);
    const accepted = await accept(await s.h.context({ run: again, answers: ANSWERS, steps: { retire: s.steps.retire } }), again);
    expect(accepted.exitCode, accepted.message).toBe(0);
    expect(accepted.state).toBe("accepted");
    expect(s.steps.retire).toHaveBeenCalledTimes(3);
  });
});
