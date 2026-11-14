import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { listGenerations } from "./replica.ts";
import { copyFixtureDatabase, FiveEightApp, FIXTURE_REPLICA, fixtureProject, loadFixtureBlobs, snapshotOnlyGeneration } from "./upgradeFixture.fixture.ts";

const STORE_AHEAD_MS = 3000;

describe("a restore onto a 5.8.1 app whose clock runs behind the store's", () => {
  let bucket: MemoryBucket;
  let app: FiveEightApp;
  let project: ReturnType<typeof fixtureProject>;
  let work: string;

  beforeEach(() => {
    bucket = new MemoryBucket("behind-5.8.1", { clock: () => Date.now() + STORE_AHEAD_MS });
    loadFixtureBlobs(bucket);
    app = new FiveEightApp(memoryStore(bucket));
    project = fixtureProject(bucket, () => app);
    work = mkdtempSync(join(tmpdir(), "kestrel-ops-behind-"));
  });
  afterEach(() => {
    project.dispose();
    app.dispose();
    rmSync(work, { recursive: true, force: true });
  });

  it("starts the app only once its own clock passed the promoted generation, so the generation it names by that clock sorts last", async () => {
    const accept = { "unsealed-stop": "accept", "access-changes": "accept" };
    const backup = await project.run(["backup", "create", "--freeze", "--yes", "--answers", project.answers(accept), "--json"]);
    expect(backup.code).toBe(0);
    const changed = join(work, "changed.db");
    copyFixtureDatabase(changed);
    const db = new DatabaseSync(changed);
    db.exec(`UPDATE pages SET "title__en" = 'Renamed after the backup' WHERE rowid = (SELECT min(rowid) FROM pages)`);
    db.close();
    await snapshotOnlyGeneration(memoryStore(bucket), Date.now() - 60_000, changed);

    const restored = await project.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", project.answers(accept), "--json"]);
    expect(restored.code).toBe(0);
    expect(restored.stderr).not.toContain("has not started its own generation yet");
    const promoted = String(Reflect.get(Object(restored.json.promoted), "generation"));
    expect(app.restoredFrom).toBe(promoted);
    const newest = (await listGenerations(memoryStore(bucket), FIXTURE_REPLICA)).at(-1)?.name ?? "";
    expect(newest > promoted).toBe(true);
  }, 30_000);
});
