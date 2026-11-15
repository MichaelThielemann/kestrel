import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readManifest } from "../backup.ts";
import { deploy } from "./deploy.ts";
import { fakeRelease } from "./fakeUpdateTarget.fixture.ts";
import { createUpdateHarness, type UpdateHarness, type UpdateHarnessOptions } from "./harness.fixture.ts";
import { readUpdateRun } from "./journal.ts";
import { prepare } from "./prepare.ts";
import { UPDATE_EXIT, type UpdateRun } from "./types.ts";

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function running(options: UpdateHarnessOptions = {}): Promise<UpdateHarness> {
  const h = createUpdateHarness(options);
  harnesses.push(h);
  await h.target.start();
  await h.target.app?.seed();
  return h;
}

const stepMs = (run: UpdateRun, step: string): number => {
  const started = run.records.find((r) => r.phase === "deploy" && r.step === step && r.state === "started");
  const done = run.records.find((r) => r.phase === "deploy" && r.step === step && r.state === "done");
  if (started === undefined || done === undefined) throw new Error(`step ${step} did not run to its end`);
  return done.at - started.at;
};

const gateVersions = (run: UpdateRun): unknown => run.records.find((r) => r.phase === "deploy" && r.step === "gate" && r.state === "done")?.data.versions;

describe("the running versions of an update", { timeout: 60_000 }, () => {
  it("never come from the installed packages of the release's own project, which prepare then reports as unknown", async () => {
    const h = await running();
    h.target.reported = fakeRelease({ runtime: "6.0.0" }).versions;
    h.target.packagesFrom = h.root;
    const { receipt, outcome } = await prepare(await h.context({ command: "update prepare" }), { fullMedia: false });
    expect(outcome.exitCode, outcome.message).toBe(UPDATE_EXIT.done);
    expect(receipt.versions.from).toBeNull();
  });

  it("come from a target that reads them outside the release's project", async () => {
    const h = await running();
    h.target.packagesFrom = join(h.root, "deployed");
    const { receipt } = await prepare(await h.context({ command: "update prepare" }), { fullMedia: false });
    expect(receipt.versions.from?.["@michaelthielemann/kestrel"]).toBe("5.8.1");
  });

  it("come from the receipt when the deploy's target reports none, so the first deploy from a release before 6 asks about the stop without waiting for a seal", async () => {
    const h = await running({ update: { sealTimeoutSeconds: 20 } });
    const { receipt } = await prepare(await h.context({ command: "update prepare" }), { fullMedia: false });
    expect(receipt.versions.from?.["@michaelthielemann/kestrel-replication-sqlite"]).toBe("5.8.1");
    h.target.reported = {};
    const ctx = await h.context({ answers: { "unsealed-stop": "accept" } });
    const outcome = await deploy(ctx);
    expect(outcome.exitCode, outcome.message).toBe(UPDATE_EXIT.done);
    const run = await readUpdateRun(ctx, ctx.run.id);
    expect(gateVersions(run)).toMatchObject({ from: { "@michaelthielemann/kestrel": "5.8.1" } });
    expect(stepMs(run, "seal")).toBeLessThan(5_000);
    expect(h.output.warn.join("\n")).toContain("seal unsupported (runtime 5.8.1)");
    expect((await readManifest(ctx, run.cutoverBackup ?? ""))?.versions).toMatchObject({ "@michaelthielemann/kestrel": "5.8.1" });
  });

  it("keep the wait for the seal when neither the target, an earlier deploy nor the receipt names them", async () => {
    const h = await running({ update: { sealTimeoutSeconds: 2 } });
    h.target.reported = {};
    await prepare(await h.context({ command: "update prepare" }), { fullMedia: false });
    const ctx = await h.context({ answers: { "unsealed-stop": "accept" } });
    const outcome = await deploy(ctx);
    expect(outcome.exitCode, outcome.message).toBe(UPDATE_EXIT.done);
    const run = await readUpdateRun(ctx, ctx.run.id);
    expect(gateVersions(run)).toMatchObject({ from: null });
    expect(stepMs(run, "seal")).toBeGreaterThanOrEqual(1_500);
    expect(h.output.warn.join("\n")).toContain("seal unknown");
  });
});
