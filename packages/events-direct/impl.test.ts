import { describe, expect, it } from "vitest";
import { createRelayReports } from "./impl.ts";

describe("events/direct relay reports: the map does not leak", () => {
  it("take() clears an existing entry, leaving nothing for the sweep", () => {
    const reports = createRelayReports();
    reports.record("run-1", { event: "x", pipeline: "p1", status: "done", attempts: 1, dead: false, error: null });
    expect(reports.take("run-1")).toEqual([{ event: "x", pipeline: "p1", status: "done", attempts: 1, dead: false, error: null }]);
    expect(reports.take("run-1")).toBeUndefined();
  });

  it("sweeps an entry whose relay never came once it is older than maxAgeMs, warning once with the count", () => {
    const clock = { t: 0 };
    const reports = createRelayReports(() => clock.t);
    reports.record("run-1", { event: "x", pipeline: "p1", status: "done", attempts: 1, dead: false, error: null });
    reports.record("run-2", { event: "y", pipeline: "p2", status: "done", attempts: 1, dead: false, error: null });

    clock.t = 59_999;
    const warnedEarly: number[] = [];
    reports.sweep(60_000, (count) => warnedEarly.push(count));
    expect(warnedEarly).toEqual([]);
    expect(reports.take("run-1")).toBeDefined();
    expect(reports.take("run-2")).toBeDefined();

    reports.record("run-1", { event: "x", pipeline: "p1", status: "done", attempts: 1, dead: false, error: null });
    reports.record("run-2", { event: "y", pipeline: "p2", status: "done", attempts: 1, dead: false, error: null });
    clock.t = 59_999 + 60_001;
    const warned: number[] = [];
    reports.sweep(60_000, (count) => warned.push(count));
    expect(warned).toEqual([2]);
    expect(reports.take("run-1")).toBeUndefined();
    expect(reports.take("run-2")).toBeUndefined();
  });
});

describe("events/direct relay reports: response shape", () => {
  it("every recorded entry has exactly {event, pipeline, status, attempts, dead, error}", () => {
    const reports = createRelayReports();
    reports.record("run-1", { event: "x", pipeline: "p1", status: "error", attempts: 1, dead: true, error: "boom" });
    const [entry] = reports.take("run-1")!;
    expect(Object.keys(entry!).sort()).toEqual(["attempts", "dead", "error", "event", "pipeline", "status"]);
  });
});
