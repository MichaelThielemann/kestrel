import { describe, it, expect, beforeEach } from "vitest";
import type { Insights } from "./insights.ts";

export interface InsightsFixture {
  insights: Insights;
  /** Runs one pipeline once so the stats have something to count; the fixture names it. */
  run(): Promise<void>;
  pipeline: string;
}

export function insightsContractTests(make: () => Promise<InsightsFixture>) {
  describe("insights@1", () => {
    let f: InsightsFixture;
    beforeEach(async () => {
      f = await make();
    });

    it("answers a manifest with core version, contracts, modules, steps, pipelines and triggers", () => {
      const manifest = f.insights.manifest();
      expect(typeof manifest.core.version).toBe("string");
      expect(Array.isArray(manifest.contracts)).toBe(true);
      expect(Array.isArray(manifest.modules)).toBe(true);
      expect(Array.isArray(manifest.steps)).toBe(true);
      expect(manifest.pipelines.map((p) => p.name)).toContain(f.pipeline);
      expect(Array.isArray(manifest.triggers.http) && Array.isArray(manifest.triggers.events) && Array.isArray(manifest.triggers.crons)).toBe(true);
    });

    it("answers the same manifest object on every call", () => {
      expect(f.insights.manifest()).toBe(f.insights.manifest());
    });

    it("answers zeroed stats before any run", () => {
      const stats = f.insights.stats();
      expect(stats.runs).toEqual({ active: 0, total: 0, failed: 0, errors: 0 });
      expect(stats.pipelines).toEqual([]);
      expect(stats.steps).toEqual([]);
      expect(stats.events).toEqual([]);
      expect(stats.ratelimit).toEqual([]);
      expect(stats.recentFailures).toEqual([]);
      expect(stats.process.pid).toBe(process.pid);
      expect(stats.process.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(stats.generatedAt).toBeLessThanOrEqual(Date.now());
    });

    it("counts a run per pipeline and per step", async () => {
      await f.run();
      const stats = f.insights.stats();
      expect(stats.runs.total).toBe(1);
      const pipeline = stats.pipelines.find((p) => p.name === f.pipeline);
      expect(pipeline).toMatchObject({ count: 1 });
      expect(pipeline?.lastAt).toBeLessThanOrEqual(Date.now());
      expect(stats.steps.filter((s) => s.pipeline === f.pipeline).length).toBeGreaterThan(0);
      for (const s of stats.steps) expect(s.p95Ms).toBeGreaterThanOrEqual(s.p50Ms);
    });
  });
}
