import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keys, parseJson, unstamp } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { allRows, copyFixtureDatabase, FiveEightApp, FIXTURE_LOCATION, fixtureProject, loadFixtureBlobs, snapshotOnlyGeneration } from "./upgradeFixture.fixture.ts";

const FIXTURE_GENERATION_AT = unstamp("20261114T145051Z");
const DAY_LATER = 60_000;

describe("a 5.8.1 replica whose newest generations hold only a snapshot", () => {
  let bucket: MemoryBucket;
  let app: FiveEightApp;
  let project: ReturnType<typeof fixtureProject>;
  let work: string;

  const database = (name: string, change?: string): string => {
    const file = join(work, `${name}.db`);
    copyFixtureDatabase(file);
    if (change !== undefined) {
      const db = new DatabaseSync(file);
      db.exec(change);
      db.close();
    }
    return file;
  };

  const quietDays = async (change?: string): Promise<string[]> => {
    const store = memoryStore(bucket);
    const names: string[] = [];
    for (let day = 1; day <= 3; day++) names.push(await snapshotOnlyGeneration(store, FIXTURE_GENERATION_AT + day * DAY_LATER, database(`day-${day}`, day === 3 ? change : undefined)));
    return names;
  };

  const manifestOf = (id: string): unknown => parseJson(bucket.objects.get(FIXTURE_LOCATION + keys.manifest(id))?.data ?? new Uint8Array());

  beforeEach(() => {
    bucket = new MemoryBucket("quiet-5.8.1");
    loadFixtureBlobs(bucket);
    app = new FiveEightApp(memoryStore(bucket));
    project = fixtureProject(bucket, () => app);
    work = mkdtempSync(join(tmpdir(), "kestrel-ops-quiet-"));
  });
  afterEach(() => {
    project.dispose();
    app.dispose();
    rmSync(work, { recursive: true, force: true });
  });

  it("are no unfinished placement in status", async () => {
    const names = await quietDays();
    const report = await project.run(["status", "--json"]);
    expect(report.json.replica).toMatchObject({ newest: names.at(-1) });
    expect(JSON.stringify(report.json.problems)).not.toContain("unfinished placement");
    expect(report.stderr).not.toContain("unfinished placement");
  });

  it("are the current state a restore reports, backs up before it and reverts", async () => {
    const backup = await project.run(["backup", "create", "--freeze", "--yes", "--answers", project.answers({ "unsealed-stop": "accept" }), "--json"]);
    expect(backup.code).toBe(0);
    const names = await quietDays(`UPDATE pages SET "title__en" = 'Renamed on a quiet day' WHERE rowid = (SELECT min(rowid) FROM pages)`);

    const restored = await project.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", project.answers({ "unsealed-stop": "accept", "access-changes": "accept" }), "--json"]);
    expect(restored.stderr).not.toContain("unfinished placement");
    expect(restored.stderr).not.toContain("cannot be read");
    expect(restored.code).toBe(0);
    expect(restored.json).toMatchObject({ noop: false, loss: { tables: { pages: { changed: 1 } } } });
    const safety = String(restored.json.safetyBackup);
    expect(manifestOf(safety)).toMatchObject({ source: { generation: names.at(-1), seal: "unsupported" }, db: { integrity: "ok" } });
    const safetyDb = join(work, "safety.db");
    writeFileSync(safetyDb, bucket.objects.get(FIXTURE_LOCATION + keys.db(safety))?.data ?? new Uint8Array());
    expect(JSON.stringify(allRows(safetyDb).pages)).toContain("Renamed on a quiet day");

    expect(app.restoredFrom).toBe(String(Reflect.get(Object(restored.json.promoted), "generation")));
    expect(JSON.stringify(allRows(app.file).pages)).not.toContain("Renamed on a quiet day");

    const again = await project.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", project.answers({ "unsealed-stop": "accept", "access-changes": "accept" }), "--json"]);
    expect(again.stderr).not.toContain("unfinished placement");
    expect(again.code).toBe(0);
    expect(again.json).toMatchObject({ noop: true, safetyBackup: null, promoted: null });
  });
});
