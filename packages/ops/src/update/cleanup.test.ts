import { afterEach, describe, expect, it } from "vitest";
import { listBackups } from "../backup.ts";
import { LOCATION, PREFIXES } from "../harness.fixture.ts";
import { cleanup } from "./cleanup.ts";
import { UPDATE_PIN_PREFIX, updateKeys } from "./layout.ts";
import { acceptRun, blobsOf, continueRun, CONVERTED_PREFIX, createScenario, deployUntil, runOf, type Scenario } from "./scenario.fixture.ts";
import { UPDATE_EXIT } from "./types.ts";

const scenarios: Scenario[] = [];
afterEach(async () => {
  for (const s of scenarios.splice(0)) await s.h.dispose();
});

const DAY = 86_400_000;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function accepted(): Promise<{ s: Scenario; runId: string; cutover: string }> {
  const s = await createScenario({ from: { renders: false } });
  scenarios.push(s);
  const deployed = await deployUntil(s, "verify");
  await acceptRun(s, deployed.runId);
  return { s, runId: deployed.runId, cutover: (await runOf(s, deployed.runId)).cutoverBackup ?? "" };
}

const later = (days: number): (() => number) => () => Date.now() + days * DAY;

describe("update cleanup", () => {
  it("refuses a run that is not accepted, and an accepted one before cleanupAfterDays passed", async () => {
    const s = await createScenario();
    scenarios.push(s);
    const deployed = await deployUntil(s, "verify");
    const open = await continueRun(s, deployed.runId, "update cleanup", { answers: { "cleanup-delete": "accept" } });
    open.ctx.clock = later(30);
    expect(await cleanup(open.ctx, open.run, { dryRun: false })).toMatchObject({ exitCode: UPDATE_EXIT.refused, state: "verified" });

    const { s: other, runId } = await accepted();
    const early = await continueRun(other, runId, "update cleanup", { answers: { "cleanup-delete": "accept" } });
    early.ctx.clock = later(13);
    const refused = await cleanup(early.ctx, early.run, { dryRun: false });
    expect(refused).toMatchObject({ exitCode: UPDATE_EXIT.refused, state: "accepted" });
    expect(refused.message).toContain("14 day(s)");
    expect([...(other.h.bucket?.objects.keys() ?? [])].filter((k) => k.startsWith(`${PREFIXES.media}m`)).length).toBe(3);
  });

  it("deletes only originals that no row references and that the cutover backup holds, after the cleanup-delete answer, and releases the pin", async () => {
    const { s, runId, cutover } = await accepted();
    const app = s.h.target.app;
    if (app === null) throw new Error("the new release does not run");
    const kept = await app.upload("m8", "after.png", encode("uploaded after the update"));
    const stray = `${PREFIXES.media}stray/unknown.bin`;
    await s.h.store.put(stray, encode("a key no backup knows"));
    await app.sync();
    const originals = (await blobsOf(s.h.store, cutover)).map((b) => b.key).sort();

    const unanswered = await continueRun(s, runId, "update cleanup", { yes: true });
    unanswered.ctx.clock = later(15);
    expect((await cleanup(unanswered.ctx, unanswered.run, { dryRun: false })).exitCode).toBe(UPDATE_EXIT.refused);
    for (const key of originals) expect(await s.h.store.head(key), key).not.toBeNull();

    const dry = await continueRun(s, runId, "update cleanup");
    dry.ctx.clock = later(15);
    const listed = await cleanup(dry.ctx, dry.run, { dryRun: true });
    expect(listed).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "accepted" });
    expect(s.h.output.info.join("\n")).toContain(`${originals.length} original(s)`);
    for (const key of originals) expect(await s.h.store.head(key), key).not.toBeNull();

    const { ctx, run } = await continueRun(s, runId, "update cleanup", { answers: { "cleanup-delete": "accept" } });
    ctx.clock = later(15);
    const done = await cleanup(ctx, run, { dryRun: false });
    expect(done).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "cleaned" });
    for (const key of originals) expect(await s.h.store.head(key), key).toBeNull();
    expect(await s.h.store.head(kept)).not.toBeNull();
    expect(await s.h.store.head(stray)).not.toBeNull();
    expect((await s.h.store.list(CONVERTED_PREFIX)).length).toBe(3);
    const backup = (await listBackups(ctx)).find((b) => b.id === cutover);
    expect(backup?.pinnedBy).not.toContain(UPDATE_PIN_PREFIX + runId);
    const records = (await runOf(s, runId)).records;
    const last = records.map((r) => r.step).lastIndexOf("run");
    expect(records.slice(last).map((r) => `${r.step} ${r.state} ${r.phase}`)).toEqual(["run started cleanup", "cleanup-check done cleanup", "cleanup-delete done cleanup", "unpin done cleanup"]);
  });

  it("removes the droplet bits the run saved when it releases the pin", async () => {
    const s = await createScenario({ from: { renders: false } });
    scenarios.push(s);
    const deployed = await deployUntil(s, "retire");
    const bits = LOCATION + updateKeys.droplet("prod", deployed.runId, s.previousDroplet);
    expect(await s.h.store.head(bits)).not.toBeNull();
    await acceptRun(s, deployed.runId);
    const { ctx, run } = await continueRun(s, deployed.runId, "update cleanup", { answers: { "cleanup-delete": "accept" } });
    ctx.clock = later(15);
    expect(await cleanup(ctx, run, { dryRun: false })).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "cleaned" });
    expect(await s.h.store.head(bits)).toBeNull();
    expect(await s.h.store.head(LOCATION + updateKeys.configuration("prod", deployed.runId))).not.toBeNull();
  });
});
