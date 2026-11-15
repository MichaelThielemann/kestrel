import { afterEach, describe, expect, it } from "vitest";
import { createBackup, listBackups, prune } from "../backup.ts";
import { cleanup } from "./cleanup.ts";
import { UPDATE_PIN_PREFIX } from "./layout.ts";
import { acceptRun, continueRun, createScenario, deployUntil, runOf, type Scenario } from "./scenario.fixture.ts";
import { UPDATE_EXIT, type UpdateContext } from "./types.ts";

const scenarios: Scenario[] = [];
afterEach(async () => {
  for (const s of scenarios.splice(0)) await s.h.dispose();
});

const DAY = 86_400_000;

function lateContext(ctx: UpdateContext): UpdateContext {
  ctx.clock = () => Date.now() + 20 * DAY;
  ctx.env.backups.retention.cutover = 1;
  ctx.env.backups.retention.manual = 1;
  return ctx;
}

describe("the update pin on a cutover backup", () => {
  it("keeps the cutover backup through prune, past its retention, its age and the end of the run, until cleanup releases the pin", async () => {
    const s = await createScenario({ from: { runtime: "6.0.0" }, to: { runtime: "6.1.0" } });
    scenarios.push(s);
    const deployed = await deployUntil(s, "verify");
    await deployed.ctx.journal.finish(true);
    const cutover = (await runOf(s, deployed.runId)).cutoverBackup ?? "";
    await acceptRun(s, deployed.runId);
    const later = await continueRun(s, deployed.runId, "backup create");
    later.ctx.clock = () => Date.now() + DAY;
    await createBackup(later.ctx, { kind: "cutover", mode: { kind: "live" } });
    await createBackup(later.ctx, { kind: "manual", mode: { kind: "live" } });
    await later.ctx.journal.finish(true);
    expect((await listBackups(later.ctx)).find((b) => b.id === cutover)?.pinnedBy).toEqual([UPDATE_PIN_PREFIX + deployed.runId]);

    const first = lateContext((await continueRun(s, deployed.runId, "backup prune")).ctx);
    await first.journal.finish(true);
    const kept = await prune(first, false);
    expect(kept.kept).toContain(cutover);
    expect(kept.backups).not.toContain(cutover);

    const { ctx, run } = await continueRun(s, deployed.runId, "update cleanup", { answers: { "cleanup-delete": "accept" } });
    ctx.clock = () => Date.now() + 20 * DAY;
    expect(await cleanup(ctx, run, { dryRun: false })).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "cleaned" });
    await ctx.journal.finish(true);

    const second = lateContext((await continueRun(s, deployed.runId, "backup prune")).ctx);
    await second.journal.finish(true);
    const removed = await prune(second, false);
    expect(removed.backups).toContain(cutover);
    expect((await listBackups(second)).some((b) => b.id === cutover)).toBe(false);
  });
});
