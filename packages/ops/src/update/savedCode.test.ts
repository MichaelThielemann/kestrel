import { describe, expect, it } from "vitest";
import { MemoryBucket, memoryStore } from "../memoryStore.ts";
import type { ObjectStore } from "../store.ts";
import { CloudFoundryRun, RUN_LOCATION } from "./cloudFoundryRun.fixture.ts";
import { UPDATE_EXIT } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const savedKeys = (bucket: MemoryBucket, runId: string): string[] => [...bucket.objects.keys()].filter((key) => key.startsWith(`${RUN_LOCATION}updates/prod/runs/${runId}/droplet-`));

const deployKey = (store: ObjectStore): ObjectStore => ({
  ...store,
  delete: (key) => (key.startsWith(`${RUN_LOCATION}updates/`) ? Promise.reject(new Error(`AccessDenied: this key may not delete ${key}`)) : store.delete(key)),
});

describe("the saved code of earlier releases when the deploy key may not delete in the backup location", { timeout: 120_000 }, () => {
  it("ends a verified deploy with exit 0 and one warning naming the code left behind, which update status shows and backup prune removes", async () => {
    const bucket = new MemoryBucket("deploy-key");
    const s = await CloudFoundryRun.create(memoryStore(bucket), { version: "6.0.0" });
    try {
      const deployed: string[] = [];
      for (const version of ["6.0.1", "6.0.2"]) {
        s.addRelease({ version });
        expect((await s.update(["prepare"])).code).toBe(UPDATE_EXIT.done);
        const run = await s.update(["deploy"], { store: deployKey });
        expect(run.code, run.stdout).toBe(UPDATE_EXIT.done);
        deployed.push(String(run.json.runId));
      }
      const [, previous] = deployed;
      const left = savedKeys(bucket, previous ?? "");
      expect(left).toHaveLength(1);

      s.addRelease({ version: "6.0.3" });
      expect((await s.update(["prepare"])).code).toBe(UPDATE_EXIT.done);
      const text = await s.update(["deploy"], { store: deployKey, json: false });
      expect(text.code, text.stdout + text.stderr).toBe(UPDATE_EXIT.done);
      const warnings = text.stderr.split("\n").filter((line) => line.startsWith("warning: ") && line.includes(left[0] ?? ""));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("AccessDenied");
      expect(warnings[0]).toContain(`kestrel backup prune --env prod removes it with credentials that may delete under ${RUN_LOCATION}updates/`);
      expect(text.stdout).toContain("verified; accept it with update accept --env prod");
      expect(s.droplets.droplets.size).toBe(1);

      const status = await s.update(["status"]);
      const newest = String(Reflect.get(Object(status.json.run), "runId"));
      expect(status.json.run).toMatchObject({ state: "verified", next: `kestrel update accept --env prod --run ${newest}` });
      expect(status.json.savedCode).toEqual(left);
      expect((await s.run(newest)).records.filter((r) => r.step === "retire").map((r) => [r.state, r.data.leftovers])).toEqual([["started", undefined], ["done", left]]);
      const lines = await s.update(["status"], { json: false });
      expect(lines.stdout).toContain(`saved code of earlier releases that no rollback needs any more: ${left[0] ?? ""}; kestrel backup prune --env prod removes it`);

      const kept = savedKeys(bucket, newest);
      expect(kept).toHaveLength(1);
      const listed = await s.ops(["backup", "prune", "--dry-run", "--json"], { clock: () => Date.now() + 2 * DAY_MS });
      expect(listed.code, listed.stderr).toBe(0);
      expect(listed.json.savedCode).toEqual(left);
      const pruned = await s.ops(["backup", "prune", "--yes", "--json"], { clock: () => Date.now() + 2 * DAY_MS });
      expect(pruned.code, pruned.stderr).toBe(0);
      expect(savedKeys(bucket, previous ?? "")).toEqual([]);
      expect(savedKeys(bucket, newest)).toEqual(kept);
      expect((await s.update(["status"])).json.savedCode).toEqual([]);
    } finally {
      await s.dispose();
    }
  });
});
