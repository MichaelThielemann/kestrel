import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { LOCATION } from "../harness.fixture.ts";
import { updateKeys } from "./layout.ts";
import { retire } from "./retire.ts";
import { releaseUpdatePin } from "./cleanup.ts";
import { acceptRun, continueRun, createScenario, deployUntil, runOf, type Scenario } from "./scenario.fixture.ts";
import { fakeRelease } from "./fakeUpdateTarget.fixture.ts";

const scenarios: Scenario[] = [];
afterEach(async () => {
  for (const s of scenarios.splice(0)) await s.h.dispose();
});

async function scenario(): Promise<Scenario> {
  const s = await createScenario();
  scenarios.push(s);
  return s;
}

describe("retiring the previous releases after an update", () => {
  it("refuses before verification passed, also when it could not tell", async () => {
    const s = await scenario();
    const started = await deployUntil(s, "start");
    const { ctx } = await continueRun(s, started.runId, "update resume");
    await expect(retire(ctx, await runOf(s, started.runId))).rejects.toThrow("its verification has not passed");

    const halted = await scenario();
    const deployed = await deployUntil(halted, "start");
    halted.h.target.release.ready = "forbidden";
    await deployed.ctx.journal.record("verify", "done", { phase: "deploy", verdict: "unverifiable" });
    await expect(retire(deployed.ctx, await runOf(halted, deployed.runId))).rejects.toMatchObject({ exitCode: 1 });
    expect(halted.h.target.actions.some((a) => a.startsWith("delete-droplet"))).toBe(false);
  });

  it("saves the replaced droplet's bits before it deletes every droplet but the current one, and names the revisions that lost theirs", async () => {
    const s = await scenario();
    const older = randomUUID();
    s.h.target.droplets.set(older, { release: fakeRelease({ runtime: "5.7.0" }), createdAt: Date.now() - 86_400_000 });
    s.h.target.revisions.unshift({ guid: randomUUID(), version: 0, droplet: older, createdAt: Date.now() - 86_400_000 });
    const deployed = await deployUntil(s, "verify");
    expect(deployed.end.verdict).toBe("passed");
    const key = LOCATION + updateKeys.droplet("prod", deployed.runId, s.previousDroplet);
    const savedFirst: boolean[] = [];
    const target = s.h.target;
    const remove = target.deleteDroplet.bind(target);
    target.deleteDroplet = async (guid) => {
      savedFirst.push((await s.h.store.head(key)) !== null);
      return remove(guid);
    };

    const result = await retire(deployed.ctx, await runOf(s, deployed.runId));
    expect(result.droplets.sort()).toEqual([older, s.previousDroplet].sort());
    expect(result.savedDroplet).toBe(updateKeys.droplet("prod", deployed.runId, s.previousDroplet));
    expect(savedFirst).toEqual([true, true]);
    expect((await target.listDroplets()).map((d) => d.guid)).toEqual([target.current]);
    expect(result.revisions.sort()).toEqual(target.revisions.filter((r) => r.droplet === older || r.droplet === s.previousDroplet).map((r) => r.guid).sort());
    expect(result.revisions).toHaveLength(2);
    expect(JSON.parse(new TextDecoder().decode((await s.h.store.get(key)) ?? new Uint8Array()))).toMatchObject({ runtime: "5.8.1" });
  });

  it("still deletes the old droplets when the target hands out no bits, and says that a later rollback cannot start them", async () => {
    const s = await scenario();
    s.h.target.dropletBits = false;
    const deployed = await deployUntil(s, "verify");
    const result = await retire(deployed.ctx, await runOf(s, deployed.runId));
    expect(result).toMatchObject({ droplets: [s.previousDroplet], savedDroplet: null, kept: [] });
    expect(s.h.output.warn.join("\n")).toContain("no bits");
  });

  it("deletes the replaced droplet also when saving its bits fails, so no old release can start on the converted data, and says what a later rollback does", async () => {
    const s = await scenario();
    s.h.target.saveDroplet = async () => {
      throw new Error("downloading the bits failed 3 times");
    };
    const deployed = await deployUntil(s, "verify");
    const result = await retire(deployed.ctx, await runOf(s, deployed.runId));
    expect(result).toMatchObject({ droplets: [s.previousDroplet], savedDroplet: null, kept: [] });
    expect(s.h.target.droplets.has(s.previousDroplet)).toBe(false);
    const warned = s.h.output.warn.join("\n");
    expect(warned).toContain("downloading the bits failed 3 times");
    expect(warned).toContain("leaves the app stopped");
  });

  it("keeps a droplet another open run needs to roll back to", async () => {
    const s = await scenario();
    const needed = randomUUID();
    s.h.target.droplets.set(needed, { release: fakeRelease({ runtime: "5.7.0" }), createdAt: Date.now() - 86_400_000 });
    const deployed = await deployUntil(s, "verify");
    const other = await s.h.context({ command: "update deploy" });
    await other.journal.record("configuration", "done", { phase: "deploy", droplet: needed });
    await other.journal.record("stop", "done", { phase: "deploy", stoppedAt: Date.now() });
    expect((await runOf(s, other.run.id)).state).toBe("down");
    const result = await retire(deployed.ctx, await runOf(s, deployed.runId));
    expect(result.droplets).toEqual([s.previousDroplet]);
    expect(result.kept).toEqual([needed]);
    expect(s.h.target.droplets.has(needed)).toBe(true);
    expect(s.h.output.warn.join("\n")).toContain(`droplet ${needed} stays: update run ${other.run.id} is down`);
  });

  it("refuses while the app runs another droplet than the one the run deployed", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "verify");
    await s.h.target.stop();
    await s.h.target.setDroplet(s.previousDroplet);
    await expect(retire(deployed.ctx, await runOf(s, deployed.runId))).rejects.toThrow("not the droplet run");
    expect(s.h.target.droplets.size).toBe(2);
  });

  it("keeps the droplet bits of an earlier deploy run while it holds the pin on its cutover backup, also once it is accepted and a later deploy passed verification", async () => {
    const s = await scenario();
    const first = await deployUntil(s, "retire");
    const bits = LOCATION + updateKeys.droplet("prod", first.runId, s.previousDroplet);
    expect(await s.h.store.head(bits)).not.toBeNull();
    await acceptRun(s, first.runId);
    const second = await deployUntil(s, "verify");
    expect(second.end.verdict).toBe("passed");
    await retire(second.ctx, await runOf(s, second.runId));
    expect(await s.h.store.head(bits)).not.toBeNull();
  });

  it("removes the droplet bits of earlier deploy runs that are no longer open and hold no pin once a later deploy passed verification", async () => {
    const s = await scenario();
    const first = await deployUntil(s, "retire");
    const bits = LOCATION + updateKeys.droplet("prod", first.runId, s.previousDroplet);
    expect(await s.h.store.head(bits)).not.toBeNull();
    await releaseUpdatePin(first.ctx, (await runOf(s, first.runId)).cutoverBackup ?? "", first.runId);
    const second = await deployUntil(s, "verify");
    expect(second.end.verdict).toBe("passed");
    await retire(second.ctx, await runOf(s, second.runId));
    expect(await s.h.store.head(bits)).toBeNull();
    const replaced = (await runOf(s, first.runId)).stagedDroplet ?? "";
    expect(await s.h.store.head(LOCATION + updateKeys.droplet("prod", second.runId, replaced))).not.toBeNull();
  });
});
