import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keys } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { PUBLISHED_RUNTIME_ENV, PublishedRuntimeApp, loadPublishedReplication } from "./publishedRuntime.fixture.ts";
import { listGenerations } from "./replica.ts";
import { allRows, copyFixtureDatabase, fixture, FIXTURE_LOCATION, FIXTURE_REPLICA, fixtureProject, loadFixtureBlobs } from "./upgradeFixture.fixture.ts";
import { CloudFoundryRun, killAfterPut, type KilledStore } from "./update/cloudFoundryRun.fixture.ts";
import { UPDATE_EXIT } from "./update/types.ts";

const runtimeDir = process.env[PUBLISHED_RUNTIME_ENV];

const withoutSessions = (rows: Record<string, unknown[]>): Record<string, unknown[]> => Object.fromEntries(Object.entries(rows).filter(([table]) => table !== "authn_sessions"));

describe.skipIf(runtimeDir === undefined)("the fixture on the published replication package of its release", () => {
  let bucket: MemoryBucket;
  let app: PublishedRuntimeApp;
  let project: ReturnType<typeof fixtureProject>;
  let work: string;
  let fixtureGeneration: string;

  beforeEach(async () => {
    bucket = new MemoryBucket("published-runtime");
    loadFixtureBlobs(bucket);
    fixtureGeneration = (await listGenerations(memoryStore(bucket), FIXTURE_REPLICA)).at(-1)?.name ?? "";
    app = new PublishedRuntimeApp(memoryStore(bucket), await loadPublishedReplication(runtimeDir ?? ""));
    project = fixtureProject(bucket, () => app);
    work = mkdtempSync(join(tmpdir(), "kestrel-ops-published-"));
    await app.start();
  });
  afterEach(() => {
    project.dispose();
    app.dispose();
    rmSync(work, { recursive: true, force: true });
  });

  it("boots the fixture row for row, and a backup reports its seal as unsupported and refuses --yes without the unsealed-stop answer", async () => {
    expect(app.restoredFrom).toBe(fixtureGeneration);
    const original = join(work, "fixture.db");
    copyFixtureDatabase(original);
    expect(allRows(app.file)).toEqual(allRows(original));

    const refused = await project.run(["backup", "create", "--freeze", "--yes"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`seal unsupported (runtime ${fixture.version})`);
    expect(refused.stderr).toContain("unsealed-stop");
    expect((await app.status()).state).toBe("started");
    expect([...bucket.objects.keys()].filter((key) => key.startsWith(FIXTURE_LOCATION) && key.endsWith("/manifest.json"))).toEqual([]);
  });

  it("starts from a promoted generation on its next boot and names its own generation after it", async () => {
    const accept = { "unsealed-stop": "accept", "access-changes": "accept" };
    const backup = await project.run(["backup", "create", "--freeze", "--yes", "--answers", project.answers(accept), "--json"]);
    expect(backup.code).toBe(0);
    expect(backup.json.manifest).toMatchObject({ source: { seal: "unsupported" } });
    app.run(`UPDATE pages SET "title__en" = 'Renamed after the backup' WHERE rowid = (SELECT min(rowid) FROM pages)`);
    await app.sync();

    const restored = await project.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", project.answers(accept), "--json"]);
    expect(restored.code).toBe(0);
    expect(restored.json).toMatchObject({ noop: false, acknowledgement: "unconfirmed" });
    const promoted = String(Reflect.get(Object(restored.json.promoted), "generation"));
    expect(app.restoredFrom).toBe(promoted);
    const backedUp = join(work, "backup.db");
    writeFileSync(backedUp, bucket.objects.get(FIXTURE_LOCATION + keys.db(String(backup.json.id)))?.data ?? new Uint8Array());
    expect(withoutSessions(allRows(app.file))).toEqual(withoutSessions(allRows(backedUp)));

    const own = (await listGenerations(memoryStore(bucket), FIXTURE_REPLICA)).at(-1)?.name ?? "";
    expect(own > promoted).toBe(true);
    await app.stop();
    await app.start();
    expect(app.restoredFrom).toBe(own);
    expect(withoutSessions(allRows(app.file))).toEqual(withoutSessions(allRows(backedUp)));
  }, 30_000);
});

describe.skipIf(runtimeDir === undefined)("an update hop from the fixture with the old release on the published replication package", () => {
  let instances: PublishedRuntimeApp[];
  let run: CloudFoundryRun;

  beforeEach(async () => {
    instances = [];
    const published = await loadPublishedReplication(runtimeDir ?? "");
    const store = memoryStore(new MemoryBucket("published-update"));
    run = await CloudFoundryRun.create(store, { version: fixture.version, runtime: fixture.version, renders: false }, {
      fixture: true,
      instance: (release) => {
        if (release.version !== fixture.version) return null;
        const instance = new PublishedRuntimeApp(store, published);
        instances.push(instance);
        return instance;
      },
    });
  });
  afterEach(async () => {
    await run.dispose();
    for (const instance of instances) instance.dispose();
  });

  const expectCutoverStateOnThePublishedRelease = async (runId: string): Promise<void> => {
    const ended = await run.run(runId);
    expect(ended.state).toBe("rolled-back");
    expect(run.current().version).toBe(fixture.version);
    expect(run.instance).not.toBeNull();
    expect(run.liveRows()).toEqual(await run.backupRows(ended.cutoverBackup ?? ""));
    expect(run.starts.filter((start) => start.version === fixture.version).map((start) => start.origin)).toEqual([null, "restore"]);
    expect(run.violations).toEqual([]);
    expect(ended.records.find((r) => r.step === "rollback-verify" && r.state === "done")?.data).toMatchObject({ provenance: "marker" });
  };

  it("rolls a failed verification back: the published release starts only on the cutover state promoted again, which its first snapshot proves", async () => {
    run.addRelease({ version: "6.0.0", modules: true, ready: "not-ready" });
    expect((await run.update(["prepare"])).code).toBe(UPDATE_EXIT.done);
    const deployed = await run.update(["deploy"]);
    expect(deployed.code, deployed.stderr).toBe(UPDATE_EXIT.rolledBack);
    await expectCutoverStateOnThePublishedRelease(String(deployed.json.runId));
  }, 300_000);

  it("aborts a deploy killed after the promotion by rolling back before the published release starts again", async () => {
    run.addRelease({ version: "6.0.0", modules: true });
    expect((await run.update(["prepare"])).code).toBe(UPDATE_EXIT.done);
    const seen: { killed?: KilledStore } = {};
    const deployed = await run.update(["deploy"], { store: (store) => (seen.killed = killAfterPut(store, (key) => key.endsWith("-promote-done.json"))).store });
    expect(seen.killed?.killed).toBe(true);
    expect(run.instance).toBeNull();
    const aborted = await run.update(["abort", "--break-lock"], { answers: { "break-lock": "accept" } });
    expect(aborted.code, aborted.stderr).toBe(UPDATE_EXIT.done);
    await expectCutoverStateOnThePublishedRelease(String(deployed.json.runId));
  }, 300_000);
});
