import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryBucket, memoryStore } from "../memoryStore.ts";
import { CloudFoundryRun, RUN_LOCATION } from "./cloudFoundryRun.fixture.ts";
import { UPDATE_EXIT } from "./types.ts";

const runs: CloudFoundryRun[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.dispose();
});

async function platform(): Promise<CloudFoundryRun> {
  const run = await CloudFoundryRun.create(memoryStore(new MemoryBucket("kestrel-test")), { version: "6.0.0" });
  runs.push(run);
  run.addRelease({ version: "6.0.1" });
  writeFileSync(join(run.root, "manifest.yml"), "applications:\n- name: site-api\n  env:\n    KESTREL_DEVICE_KEY: ((device-key))\n");
  return run;
}

const runIdOf = (json: Record<string, unknown>): string => {
  const id = json.runId;
  if (typeof id !== "string") throw new Error("the command named no run");
  return id;
};

describe("a release configuration the target cannot apply", { timeout: 60_000 }, () => {
  it("is refused with exit 2 by prepare and by the gate of the deploy when a manifest placeholder has no source, before the app is stopped", async () => {
    const s = await platform();
    const target = { manifest: "manifest.yml" };
    const prepared = await s.update(["prepare"], { target });
    expect(prepared.code, prepared.stderr).toBe(UPDATE_EXIT.usage);
    expect(prepared.stdout + prepared.stderr).toContain("((device-key))");
    expect(await s.store.list(`${RUN_LOCATION}updates/prod/receipts/`)).toEqual([]);
    const deployed = await s.update(["deploy"], { target });
    expect(deployed.code, deployed.stderr).toBe(UPDATE_EXIT.usage);
    expect(deployed.stdout + deployed.stderr).toContain("((device-key))");
    expect(s.cf.actions).toEqual([]);
    expect((await s.run(runIdOf(deployed.json))).state).toBe("untouched");
    expect(s.current().version).toBe("6.0.0");
  });

  it("is refused with exit 2 by the gate of the deploy when a source does not resolve in the deploy job, before the app is stopped", async () => {
    const s = await platform();
    const target = { manifest: "manifest.yml", vars: { "device-key": { env: "MISSING_DEVICE_KEY" } } };
    const prepared = await s.update(["prepare"], { target });
    expect(prepared.code, prepared.stderr).toBe(UPDATE_EXIT.done);
    const deployed = await s.update(["deploy"], { target });
    expect(deployed.code, deployed.stderr).toBe(UPDATE_EXIT.usage);
    expect(deployed.stdout + deployed.stderr).toContain("MISSING_DEVICE_KEY");
    expect(s.cf.actions).toEqual([]);
    expect((await s.run(runIdOf(deployed.json))).state).toBe("untouched");
  });
});
