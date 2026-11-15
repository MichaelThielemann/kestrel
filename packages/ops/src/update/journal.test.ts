import { describe, expect, it } from "vitest";
import { Journal } from "../journal.ts";
import { MemoryBucket, memoryStore } from "../memoryStore.ts";
import { Redactor } from "../redact.ts";
import { continueJournal, latestDeployRun, listUpdateRuns, readUpdateRun, reportOf, RUN_STEP } from "./journal.ts";
import { OPEN_STATES } from "./types.ts";

const LOCATION = "kestrel-backups/";

function journalOn(bucket: MemoryBucket, runId: string, clock: () => number, startSeq = 0): Journal {
  return new Journal(runId, memoryStore(bucket), LOCATION, new Redactor(), clock, null, startSeq);
}

function ctxOf(bucket: MemoryBucket) {
  return { backups: memoryStore(bucket), location: LOCATION, poll: { delayMs: 1, attempts: 20 } };
}

describe("update run journal", () => {
  it("derives the state of a deploy run from each step it recorded", async () => {
    const bucket = new MemoryBucket("journal");
    let now = 1_000;
    const journal = journalOn(bucket, "run1", () => now);
    const states: string[] = [];
    const step = async (name: string, state: "started" | "done" | "failed", data: Record<string, unknown> = {}): Promise<void> => {
      now += 1000;
      await journal.record(name, state, data);
      states.push((await readUpdateRun(ctxOf(bucket), "run1")).state);
    };
    await step(RUN_STEP, "started", { command: "update deploy", env: "prod", phase: "deploy" });
    await step("gate", "done", { receipt: "abc/prep1", versions: { from: { "@michaelthielemann/kestrel": "5.8.1" }, to: { "@michaelthielemann/kestrel": "6.0.0" } } });
    await step("stage", "done", { droplet: "new-droplet" });
    await step("configuration", "done", { droplet: "old-droplet" });
    await step("stop", "done", { stoppedAt: now });
    await step("cutover-backup", "done", { backupId: "prod-20261115T010000Z-cutover-ab12" });
    await step("promote", "done", { generation: "20261115T010100Z", nonce: "n1" });
    await step("start", "started", {});
    await step("start", "done", { ready: true });
    await step("verify", "done", { verdict: "passed" });
    expect(states).toEqual(["deploying", "deploying", "deploying", "deploying", "down", "down", "down", "verifying", "verifying", "verified"]);
    const run = await readUpdateRun(ctxOf(bucket), "run1");
    expect(run).toMatchObject({ env: "prod", receipt: "abc/prep1", stagedDroplet: "new-droplet", previousDroplet: "old-droplet", cutoverBackup: "prod-20261115T010000Z-cutover-ab12", promoted: { generation: "20261115T010100Z", nonce: "n1" }, lastDone: { phase: "deploy", step: "verify" }, lastSeq: 10 });
    expect(run.versions?.to).toEqual({ "@michaelthielemann/kestrel": "6.0.0" });
    expect(OPEN_STATES.has(run.state)).toBe(false);
  });

  it("marks a deploy that ended before the stop as untouched and one halted by verification as open", async () => {
    const bucket = new MemoryBucket("journal");
    const staged = journalOn(bucket, "staged", () => 1);
    await staged.record(RUN_STEP, "started", { command: "update deploy", env: "prod" });
    await staged.record("stage", "failed", { message: "staging failed" });
    await staged.finish(false, {});
    expect((await readUpdateRun(ctxOf(bucket), "staged")).state).toBe("untouched");

    const halted = journalOn(bucket, "halted", () => 2);
    await halted.record(RUN_STEP, "started", { command: "update deploy", env: "prod" });
    await halted.record("stop", "done", {});
    await halted.record("start", "done", { ready: true });
    await halted.record("verify", "done", { verdict: "unverifiable" });
    const run = await readUpdateRun(ctxOf(bucket), "halted");
    expect(run.state).toBe("halted");
    expect(OPEN_STATES.has(run.state)).toBe(true);
  });

  it("marks a deploy whose step failed before the stop as untouched without an end record, and leaves an accepted run accepted while a rollback command only opened", async () => {
    const bucket = new MemoryBucket("journal");
    const refused = journalOn(bucket, "refused", () => 1);
    await refused.record(RUN_STEP, "started", { command: "update deploy", env: "prod", phase: "deploy" });
    await refused.record("gate", "started", { phase: "deploy" });
    await refused.record("gate", "failed", { phase: "deploy", error: "no receipt" });
    expect((await readUpdateRun(ctxOf(bucket), "refused")).state).toBe("untouched");

    const accepted = journalOn(bucket, "accepted", () => 2);
    await accepted.record(RUN_STEP, "started", { command: "update deploy", env: "prod", phase: "deploy" });
    await accepted.record("stop", "done", { phase: "deploy" });
    await accepted.record("seal", "failed", { phase: "deploy" });
    expect((await readUpdateRun(ctxOf(bucket), "accepted")).state).toBe("down");
    await accepted.record("start", "done", { phase: "deploy", ready: true });
    await accepted.record("verify", "done", { phase: "deploy", verdict: "passed" });
    await accepted.record("accept", "done", { phase: "accept" });
    await accepted.record(RUN_STEP, "started", { command: "update rollback", env: "prod", phase: "rollback" });
    expect((await readUpdateRun(ctxOf(bucket), "accepted")).state).toBe("accepted");
    await accepted.record("rollback", "started", { phase: "rollback", reason: "requested" });
    expect((await readUpdateRun(ctxOf(bucket), "accepted")).state).toBe("rolling-back");
  });

  it("lets a later command continue the run's numbering and counts its records in the run's phase", async () => {
    const bucket = new MemoryBucket("journal");
    const first = journalOn(bucket, "run2", () => 1);
    await first.record(RUN_STEP, "started", { command: "update deploy", env: "prod" });
    await first.record("stop", "done", {});
    await first.record("start", "done", { ready: true });
    await first.record("verify", "done", { verdict: "failed" });
    const before = await readUpdateRun(ctxOf(bucket), "run2");
    expect(before.state).toBe("rolling-back");
    const later = continueJournal({ ...ctxOf(bucket), redactor: new Redactor(), clock: () => 2, workspace: { dir: "", path: () => "/dev/null", dispose: () => undefined } }, before);
    await later.record(RUN_STEP, "started", { command: "update rollback", env: "prod", phase: "rollback" });
    await later.record("rollback", "started", { phase: "rollback" });
    await later.record("stop", "done", {});
    expect((await readUpdateRun(ctxOf(bucket), "run2")).state).toBe("rolling-back");
    await later.record("rollback", "done", {});
    const after = await readUpdateRun(ctxOf(bucket), "run2");
    expect(after.state).toBe("rolled-back");
    expect(after.records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(after.records.filter((r) => r.step === "stop").map((r) => r.phase)).toEqual(["deploy", "rollback"]);
  });

  it("waits for a listing that lags behind the newest records before it reads the run", async () => {
    const bucket = new MemoryBucket("journal", { listLag: 2 });
    const journal = journalOn(bucket, "lagging", () => 1);
    await journal.record(RUN_STEP, "started", { command: "update accept", env: "prod" });
    await journal.record("accept", "done", {});
    const run = await readUpdateRun(ctxOf(bucket), "lagging");
    expect(run.records.map((r) => r.step)).toEqual([RUN_STEP, "accept"]);
    expect(run.state).toBe("accepted");
  });

  it("refuses a run whose journal keeps a gap", async () => {
    const bucket = new MemoryBucket("journal");
    const journal = journalOn(bucket, "gap", () => 1, 1);
    await journal.record(RUN_STEP, "started", { command: "update deploy", env: "prod" });
    await expect(readUpdateRun(ctxOf(bucket), "gap")).rejects.toThrow("lacks entries below 2");
  });

  it("lists the update runs of one environment and finds the newest deploy", async () => {
    const bucket = new MemoryBucket("journal");
    let now = 10;
    const open = async (runId: string, command: string, env: string): Promise<void> => {
      now += 10;
      await journalOn(bucket, runId, () => now).record(RUN_STEP, "started", { command, env });
    };
    await open("a", "update prepare", "prod");
    await open("b", "update deploy", "prod");
    await open("c", "update deploy", "dev");
    await open("d", "backup create", "prod");
    await open("e", "update deploy", "prod");
    expect((await listUpdateRuns(ctxOf(bucket), "prod")).map((r) => `${r.runId} ${r.command}`)).toEqual(["a update prepare", "b update deploy", "e update deploy"]);
    expect((await latestDeployRun(ctxOf(bucket), "prod"))?.runId).toBe("e");
    expect(await latestDeployRun(ctxOf(bucket), "staging")).toBeNull();
  });

  it("reports each step's time and the app's downtime from the stop until a start that became ready", async () => {
    const bucket = new MemoryBucket("journal");
    let now = 0;
    const journal = journalOn(bucket, "timed", () => now);
    const at = async (ms: number, step: string, state: "started" | "done", data: Record<string, unknown> = {}): Promise<void> => {
      now = ms;
      await journal.record(step, state, data);
    };
    await at(0, RUN_STEP, "started", { command: "update deploy", env: "prod" });
    await at(100, "stage", "started");
    await at(5_000, "stage", "done");
    await at(6_000, "stop", "done");
    await at(6_000, "cutover-backup", "started");
    await at(9_000, "cutover-backup", "done");
    await at(9_000, "start", "started");
    await at(10_000, "start", "done", { ready: false });
    await at(12_000, "start", "done", { ready: true });
    const report = reportOf(await readUpdateRun(ctxOf(bucket), "timed"));
    expect(report.downtimeMs).toBe(6_000);
    expect(report.steps.find((s) => s.step === "stage")).toMatchObject({ ms: 4_900, appDown: false });
    expect(report.steps.find((s) => s.step === "cutover-backup")).toMatchObject({ ms: 3_000, appDown: true });

    const down = journalOn(bucket, "down", () => now);
    await down.record(RUN_STEP, "started", { command: "update deploy", env: "prod" });
    await down.record("stop", "done", {});
    expect(reportOf(await readUpdateRun(ctxOf(bucket), "down")).downtimeMs).toBeNull();
  });

  it("ends the downtime of a halted run once a later verification passed, and once a rollback verified the previous release", async () => {
    const bucket = new MemoryBucket("journal-verified");
    let now = 0;
    const record = async (journal: Journal, ms: number, step: string, state: "started" | "done", data: Record<string, unknown> = {}): Promise<void> => {
      now = ms;
      await journal.record(step, state, data);
    };
    const halted = journalOn(bucket, "halted", () => now);
    await record(halted, 0, RUN_STEP, "started", { command: "update deploy", env: "prod" });
    await record(halted, 1_000, "stop", "done", { phase: "deploy" });
    await record(halted, 2_000, "start", "started", { phase: "deploy" });
    await record(halted, 3_000, "start", "done", { phase: "deploy", ready: false });
    await record(halted, 4_000, "verify", "done", { phase: "deploy", verdict: "unverifiable" });
    expect(reportOf(await readUpdateRun(ctxOf(bucket), "halted")).downtimeMs).toBeNull();
    await record(halted, 9_000, "verify", "done", { phase: "verify", verdict: "passed" });
    expect(reportOf(await readUpdateRun(ctxOf(bucket), "halted")).downtimeMs).toBe(8_000);

    const rolled = journalOn(bucket, "rolled", () => now);
    await record(rolled, 0, RUN_STEP, "started", { command: "update deploy", env: "prod" });
    await record(rolled, 1_000, "stop", "done", { phase: "deploy" });
    await record(rolled, 2_000, "start", "done", { phase: "rollback", ready: false });
    await record(rolled, 5_000, "rollback-verify", "done", { phase: "rollback" });
    expect(reportOf(await readUpdateRun(ctxOf(bucket), "rolled")).downtimeMs).toBe(4_000);
  });
});
