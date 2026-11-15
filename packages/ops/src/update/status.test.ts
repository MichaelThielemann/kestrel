import { afterEach, describe, expect, it } from "vitest";
import { LOCATION } from "../harness.fixture.ts";
import { jsonBytes, keys } from "../layout.ts";
import type { ObjectStore } from "../store.ts";
import { createUpdateHarness, type UpdateHarness } from "./harness.fixture.ts";
import { RUN_STEP } from "./journal.ts";
import { renderStatus, updateStatus } from "./status.ts";

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

const T0 = Date.UTC(2026, 10, 15, 4, 0, 0);
const BACKUP = "prod-20261115T040300Z-cutover-ab12";

interface Entry {
  step: string;
  state: "started" | "done" | "failed";
  at: number;
  data?: Record<string, unknown>;
}

async function writeRun(store: ObjectStore, runId: string, entries: readonly Entry[]): Promise<void> {
  let seq = 0;
  for (const entry of entries) {
    seq += 1;
    const record = { runId, seq, step: entry.step, state: entry.state, at: entry.at, data: entry.data ?? {} };
    await store.put(LOCATION + keys.journal(runId, seq, entry.step, entry.state), jsonBytes(record), { contentType: "application/json" });
  }
}

async function writeLock(store: ObjectStore, runId: string, host: string, at: number): Promise<void> {
  await store.put(LOCATION + keys.lock(runId, at, "start"), jsonBytes({ runId, command: "update deploy", host, pid: 4242, at }), { contentType: "application/json" });
  await store.put(LOCATION + keys.lock(runId, at + 600_000, "released"), jsonBytes({ runId, at: at + 600_000 }), { contentType: "application/json" });
}

const minutes = (n: number): number => T0 + n * 60_000;

const deployRun: Entry[] = [
  { step: RUN_STEP, state: "started", at: minutes(0), data: { command: "update deploy", env: "prod", phase: "deploy", process: "ci0001" } },
  { step: "gate", state: "done", at: minutes(0), data: { receipt: "a91c/prep01", versions: { from: { "@michaelthielemann/kestrel": "5.8.1" }, to: { "@michaelthielemann/kestrel": "6.0.0" } } } },
  { step: "stage", state: "started", at: minutes(0) },
  { step: "stage", state: "done", at: minutes(2), data: { droplet: "new-droplet" } },
  { step: "stop", state: "done", at: minutes(3), data: { stoppedAt: minutes(3) } },
  { step: "cutover-backup", state: "started", at: minutes(3) },
  { step: "cutover-backup", state: "done", at: minutes(5), data: { backupId: BACKUP } },
  { step: "migrate", state: "started", at: minutes(5) },
  { step: "migrate", state: "done", at: minutes(6) },
  { step: "promote", state: "done", at: minutes(7), data: { generation: "20261115T040700Z", nonce: "n1" } },
  { step: "start", state: "started", at: minutes(7) },
  { step: "start", state: "done", at: minutes(9), data: { ready: true } },
  { step: "verify", state: "done", at: minutes(10), data: { verdict: "passed" } },
];

describe("update status", () => {
  it("shows a deploy run another host wrote, with its state, the next command and the downtime of each step", async () => {
    const h = createUpdateHarness();
    harnesses.push(h);
    await writeRun(h.store, "ci0001", deployRun);
    await writeLock(h.store, "ci0001", "ci-agent", minutes(0));
    const ctx = await h.context({ run: { runId: "laptop", lastSeq: 0 } });
    const report = await updateStatus(ctx, null);
    expect(report.open).toEqual([]);
    expect(report.run).toMatchObject({ runId: "ci0001", command: "update deploy", state: "verified", hosts: ["ci-agent"], cutoverBackup: BACKUP, next: "kestrel update accept --env prod --run ci0001", versions: { to: { "@michaelthielemann/kestrel": "6.0.0" } } });
    const steps = report.run?.report.steps.map((s) => [s.step, s.ms, s.appDown]);
    expect(steps).toEqual([
      ["gate", 0, false],
      ["stage", 120_000, false],
      ["stop", 60_000, true],
      ["cutover-backup", 120_000, true],
      ["migrate", 60_000, true],
      ["promote", 60_000, true],
      ["start", 120_000, true],
      ["verify", 60_000, false],
    ]);
    expect(report.run?.report.downtimeMs).toBe(6 * 60_000);
    const lines = renderStatus(report).join("\n");
    expect(lines).toContain("run ci0001  update deploy  verified");
    expect(lines).toContain("ran on ci-agent");
    expect(lines).toContain("5.8.1 -> 6.0.0");
    expect(lines).toMatch(/deploy cutover-backup +2 min 0 s {2}app down/);
    expect(lines).toContain("downtime 6 min 0 s");
    expect(lines).toContain("next: kestrel update accept --env prod --run ci0001");
  });

  it("lists a run killed after the stop as open with resume next, and names every host its processes ran on", async () => {
    const h = createUpdateHarness();
    harnesses.push(h);
    await writeRun(h.store, "ci0002", [
      ...deployRun.slice(0, 7),
      { step: RUN_STEP, state: "started", at: minutes(30), data: { command: "update resume", env: "prod", phase: "resume", process: "lap001" } },
    ]);
    await writeLock(h.store, "ci0002", "ci-agent", minutes(0));
    await writeLock(h.store, "lap001", "laptop", minutes(30));
    const ctx = await h.context({ run: { runId: "other", lastSeq: 0 } });
    const report = await updateStatus(ctx, "ci0002");
    expect(report.run).toMatchObject({ state: "down", hosts: ["ci-agent", "laptop"], next: "kestrel update resume --env prod --run ci0002" });
    expect(report.run?.report.downtimeMs).toBeNull();
    expect(report.open.map((r) => r.runId)).toEqual(["ci0002"]);
    expect(renderStatus(report).join("\n")).toContain("downtime the app is still down");
  });

  it("reports no run for an environment without a deploy", async () => {
    const h = createUpdateHarness();
    harnesses.push(h);
    const ctx = await h.context({ run: { runId: "other", lastSeq: 0 } });
    const report = await updateStatus(ctx, null);
    expect(report).toEqual({ env: "prod", run: null, open: [] });
    expect(renderStatus(report)).toEqual(["prod: no deploy run"]);
  });
});
