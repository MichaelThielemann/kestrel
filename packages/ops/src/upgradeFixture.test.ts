import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { keys } from "./layout.ts";
import { MemoryBucket } from "./memoryStore.ts";
import type { Target } from "./target.ts";
import { allRows, copyFixtureDatabase, fixture, FIXTURE_LOCATION, fixtureProject, loadFixtureBlobs } from "./upgradeFixture.fixture.ts";

function stoppedTarget(): Target {
  return {
    transport: "promote",
    describe: async () => ({ kind: "fixture", packages: fixture.packages }),
    status: async () => ({ state: "stopped", instances: 0 }),
    stop: async () => ({ stoppedAt: Date.now() }),
    start: async () => {
      throw new Error("the fixture target never starts");
    },
    waitReady: async () => false,
  };
}

describe("a replica and blobs written by the published 5.8.1 packages", () => {
  let bucket: MemoryBucket;
  let project: ReturnType<typeof fixtureProject>;
  let work: string;

  beforeEach(() => {
    bucket = new MemoryBucket("fixture-5.8.1");
    loadFixtureBlobs(bucket);
    project = fixtureProject(bucket, stoppedTarget);
    work = mkdtempSync(join(tmpdir(), "kestrel-ops-fixture-rows-"));
  });
  afterEach(() => {
    project.dispose();
    rmSync(work, { recursive: true, force: true });
  });

  it("reports the seal as unsupported and refuses --yes without the unsealed-stop answer, writing no backup", async () => {
    expect(fixture.version).toBe("5.8.1");
    const refused = await project.run(["backup", "create", "--freeze", "--yes"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("seal unsupported (runtime 5.8.1)");
    expect(refused.stderr).toContain("unsealed-stop");
    expect([...bucket.objects.keys()].filter((key) => key.startsWith(FIXTURE_LOCATION) && key.endsWith("/manifest.json"))).toEqual([]);
  });

  it("backs up the database rebuilt from the replica row for row, every original that exists and the export, and the backup verifies", async () => {
    const backup = await project.run(["backup", "create", "--freeze", "--yes", "--answers", project.answers({ "unsealed-stop": "accept" }), "--json"]);
    expect(backup.code).toBe(0);
    const missing = Object.values(fixture.media).find((item) => item.id === fixture.missingOriginal)?.key;
    expect(missing).toBeDefined();
    expect(backup.stderr).toContain("seal unsupported (runtime 5.8.1)");
    expect(backup.stderr).toContain(`original ${missing} is referenced by a media row but missing in the store`);
    const manifest = boundaryCast<{ source: { seal: string }; db: { integrity: string; rows: Record<string, number> }; blobs: { count: number; missingAtBackup: string[] } }>(backup.json.manifest, "json");
    expect(manifest.source.seal).toBe("unsupported");
    expect(manifest.db.integrity).toBe("ok");
    expect(manifest.db.rows).toEqual(fixture.collections);
    expect(manifest.blobs).toMatchObject({ count: Object.keys(fixture.media).length - 1, missingAtBackup: [missing] });

    const backedUp = join(work, "backup.db");
    writeFileSync(backedUp, bucket.objects.get(FIXTURE_LOCATION + keys.db(String(backup.json.id)))?.data ?? new Uint8Array());
    const original = join(work, "fixture.db");
    copyFixtureDatabase(original);
    expect(allRows(backedUp)).toEqual(allRows(original));

    const verified = await project.run(["backup", "verify", String(backup.json.id), "--json"]);
    expect(verified.stderr).toBe("");
    expect(verified.code).toBe(0);
    expect(verified.json).toMatchObject({ ok: true });
  });
});
