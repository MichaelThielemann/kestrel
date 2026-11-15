import { afterEach, describe, expect, it } from "vitest";
import { OpsError } from "../errors.ts";
import { jsonBytes } from "../layout.ts";
import { LOCATION } from "../harness.fixture.ts";
import { checkGate, findReceipt } from "./gate.ts";
import { createUpdateHarness, type UpdateHarness } from "./harness.fixture.ts";
import { updateKeys } from "./layout.ts";
import { planHash } from "./plan.ts";
import type { UpdateContext, UpdatePlan, UpdateReceipt, UpdateRun, UpdateRunState } from "./types.ts";

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

const harness = (...args: Parameters<typeof createUpdateHarness>): UpdateHarness => {
  const h = createUpdateHarness(...args);
  harnesses.push(h);
  return h;
};

const OLD = { "@michaelthielemann/kestrel": "5.8.1" };
const NEW = { "@michaelthielemann/kestrel": "6.0.0" };

const plan = (overrides: Partial<UpdatePlan> = {}): UpdatePlan => ({ versions: { from: OLD, to: NEW }, storage: [], content: [], questions: [], ...overrides });
const pending: UpdatePlan["storage"] = [{ module: "media/default", id: "media-default:key-layout", kind: "auto", blobWrites: true, pending: 4 }];

async function writeReceipt(ctx: UpdateContext, of: UpdatePlan, runId = "prep01", createdAt = 1): Promise<UpdateReceipt> {
  const hash = planHash(of);
  const receipt: UpdateReceipt = { schema: "kestrel-ops/update-receipt@1", env: "prod", runId, createdAt, tool: ctx.tool, versions: of.versions, planHash: hash, plan: of, rehearsal: { ok: true, checks: [], timings: {}, peakRssBytes: null, fullMedia: false } };
  await ctx.backups.put(LOCATION + updateKeys.receipt("prod", hash, runId), jsonBytes(receipt));
  return receipt;
}

const run = (state: UpdateRunState): UpdateRun => ({ runId: "earlier1", env: "prod", records: [], state, lastDone: null, lastSeq: 0, receipt: null, stagedDroplet: null, previousDroplet: null, cutoverBackup: null, promoted: null, versions: null, startedAt: 0, lastAt: 0 });

async function refusal(promise: Promise<unknown>): Promise<OpsError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof OpsError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error;
}

describe("the deploy gate", () => {
  it("refuses a version change without a matching receipt with exit 1", async () => {
    const ctx = await harness().context();
    const error = await refusal(checkGate(ctx, plan(), null));
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("update prepare");
  });

  it("refuses a pending storage migration without a matching receipt, also when the versions stay", async () => {
    const ctx = await harness().context();
    expect((await refusal(checkGate(ctx, plan({ versions: { from: NEW, to: NEW }, storage: pending }), null))).exitCode).toBe(1);
  });

  it("lets a change through with the receipt of its plan and versions, and refuses one for other versions", async () => {
    const ctx = await harness().context();
    const changing = plan({ storage: pending });
    await writeReceipt(ctx, { ...changing, versions: { from: OLD, to: { "@michaelthielemann/kestrel": "6.0.1" } } }, "prep00");
    expect((await refusal(checkGate(ctx, changing, null))).exitCode).toBe(1);
    await writeReceipt(ctx, changing, "prep01", 1);
    await writeReceipt(ctx, { ...changing, storage: [{ ...pending[0]!, pending: 99 }] }, "prep02", 2);
    const passed = await checkGate(ctx, changing, null);
    expect(passed.ordinary).toBe(false);
    expect(passed.receipt?.runId).toBe("prep02");
    expect(passed.planHash).toBe(planHash(changing));
    expect((await findReceipt(ctx, passed.planHash, { "@michaelthielemann/kestrel": "7.0.0" }))).toBeNull();
  });

  it("lets an ordinary deploy through without a receipt", async () => {
    const ctx = await harness().context();
    const passed = await checkGate(ctx, plan({ versions: { from: NEW, to: NEW } }), null);
    expect(passed).toMatchObject({ ordinary: true, receipt: null, accepts: null });
  });

  it("refuses more than one desired or running instance and an active rolling deployment", async () => {
    const h = harness();
    const ordinary = plan({ versions: { from: NEW, to: NEW } });
    const ctx = await h.context();
    h.target.instances = 2;
    expect((await refusal(checkGate(ctx, ordinary, null))).message).toContain("2 instances");
    h.target.instances = 1;
    h.target.preflight = async () => ({ instances: 1, running: 2, activeDeployment: null, healthCheck: "http" });
    expect((await refusal(checkGate(ctx, ordinary, null))).exitCode).toBe(1);
    h.target.preflight = async () => ({ instances: 1, running: 1, activeDeployment: "rolling", healthCheck: "http" });
    expect((await refusal(checkGate(ctx, ordinary, null))).message).toContain("rolling");
  });

  it("refuses while an earlier run is open and accepts a verified one implicitly", async () => {
    const ctx = await harness().context();
    const ordinary = plan({ versions: { from: NEW, to: NEW } });
    for (const state of ["deploying", "down", "verifying", "halted", "rolling-back"] as const) expect((await refusal(checkGate(ctx, ordinary, run(state)))).exitCode, state).toBe(1);
    expect((await checkGate(ctx, ordinary, run("verified"))).accepts).toBe("earlier1");
    expect((await checkGate(ctx, ordinary, run("accepted"))).accepts).toBeNull();
    expect((await checkGate(ctx, ordinary, run("rolled-back"))).accepts).toBeNull();
  });
});
