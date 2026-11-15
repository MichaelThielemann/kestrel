import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createBackup } from "../backup.ts";
import { OpsError } from "../errors.ts";
import { PREFIXES } from "../harness.fixture.ts";
import { stamp } from "../layout.ts";
import { allRows, copyFixtureDatabase, FIXTURE, fixture } from "../upgradeFixture.fixture.ts";
import { createUpdateHarness, type UpdateHarness, type UpdateHarnessOptions } from "./harness.fixture.ts";
import { readUpdateRun } from "./journal.ts";
import { changedTables, migrateCopy } from "./migrate.ts";
import { releaseStorages } from "./storages.ts";
import type { UpdateContext, UpdatePlan } from "./types.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const MODULES = { "kestrel-media-default": "media-default", "kestrel-images-default": "images-default", "kestrel-persistence-sqlite": "persistence-sqlite", "kestrel-sanitize-svg": "sanitize-svg" };

const harnesses: UpdateHarness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(options: UpdateHarnessOptions = {}): UpdateHarness {
  const h = createUpdateHarness(options);
  harnesses.push(h);
  return h;
}

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kestrel-ops-migrate-"));
  dirs.push(dir);
  return dir;
}

function installModules(h: UpdateHarness): Record<string, string> {
  const scope = join(h.releaseDir, "node_modules", "@michaelthielemann");
  mkdirSync(scope, { recursive: true });
  for (const [name, dir] of Object.entries(MODULES)) symlinkSync(join(REPO, "packages", dir), join(scope, name), "dir");
  return Object.fromEntries(Object.keys(MODULES).map((name) => [`@michaelthielemann/${name}`, "6.0.0"]));
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
}

function loadFixtureInto(h: UpdateHarness): void {
  const blobs = join(FIXTURE, "blobs");
  for (const file of files(blobs)) {
    const key = relative(blobs, file).split("\\").join("/");
    h.bucket?.write(key.startsWith("replica/") ? PREFIXES.replica + key.slice("replica/".length) : key, readFileSync(file), "put");
  }
}

async function cutoverOf(h: UpdateHarness, database: string | null): Promise<{ ctx: UpdateContext; backupId: string }> {
  if (database !== null) await h.store.put(`${PREFIXES.replica}gen/${stamp(Date.now() - 60_000)}/snapshot.db`, new Uint8Array(readFileSync(database)));
  const ctx = await h.context({ command: "update deploy", answers: { "unsealed-stop": "accept" } });
  const backup = await createBackup(ctx, { kind: "cutover", mode: { kind: "freeze" } });
  return { ctx, backupId: backup.id };
}

const plan = (storage: UpdatePlan["storage"], content: string[] = []): UpdatePlan => ({ versions: { from: null, to: {} }, storage, content, questions: [] });

const STAND_IN = `import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
const db = new DatabaseSync(process.env.DB);
if (!db.prepare("SELECT 1 AS hit FROM content_migrations WHERE id = 'count-hits'").get()) {
  db.exec("UPDATE counters SET n = n + 1 WHERE id = 'hits'");
  if (!existsSync(process.env.CRASH_MARK)) {
    writeFileSync(process.env.CRASH_MARK, "crashed");
    process.kill(process.pid, "SIGKILL");
  }
  db.exec("INSERT INTO content_migrations VALUES ('count-hits', 0, 1, 0)");
}
db.close();
createServer((req, res) => {
  res.statusCode = req.url === "/ready" ? 200 : 404;
  res.end();
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

function counterHarness(crashMark: string): UpdateHarness {
  const h = harness({ update: { localBoot: { command: ["node", "stand-in.mjs"], dir: ".", env: { DB: "{database}", PORT: "{port}", CRASH_MARK: crashMark }, readyPath: "/ready", timeoutSeconds: 30 } } });
  writeFileSync(join(h.releaseDir, "stand-in.mjs"), STAND_IN);
  return h;
}

function counterDatabase(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE counters ("id" TEXT PRIMARY KEY, "n" INTEGER);
    INSERT INTO counters VALUES ('hits', 0);
    CREATE TABLE pages ("id" TEXT PRIMARY KEY, "title" TEXT);
    INSERT INTO pages VALUES ('home', 'Home');
    CREATE TABLE authn_sessions ("id" TEXT PRIMARY KEY, "expiresAt" INTEGER);
    INSERT INTO authn_sessions VALUES ('s1', 1);
    CREATE TABLE content_migrations ("id" TEXT PRIMARY KEY, "appliedAt" INTEGER, "documents" INTEGER, "durationMs" INTEGER);`);
  db.close();
}

describe("the migration of the cutover copy", () => {
  it("starts again from a fresh cutover copy after a kill inside a migration that is not idempotent, with the result of an undisturbed run", async () => {
    const work = workDir();
    const crashMark = join(work, "crashed");
    const h = counterHarness(crashMark);
    const database = join(work, "cutover.sqlite");
    counterDatabase(database);
    const { ctx, backupId } = await cutoverOf(h, database);
    const outFile = join(work, "migrated.sqlite");
    const killed = await migrateCopy(ctx, { cutoverBackup: backupId, plan: plan([], ["count-hits"]), outFile }).catch((caught: unknown) => caught);
    expect(killed instanceof OpsError ? killed.message : killed).toContain("signal SIGKILL");
    const halfway = allRows(outFile);
    expect(halfway.counters).toEqual([{ id: "hits", n: 1 }]);
    expect(halfway.content_migrations).toEqual([]);

    const resumed = await migrateCopy(ctx, { cutoverBackup: backupId, plan: plan([], ["count-hits"]), outFile });
    expect(resumed.content).toEqual(["count-hits"]);
    const undisturbedFile = join(work, "undisturbed.sqlite");
    const undisturbed = await migrateCopy(ctx, { cutoverBackup: backupId, plan: plan([], ["count-hits"]), outFile: undisturbedFile });
    expect(allRows(outFile)).toEqual(allRows(undisturbedFile));
    expect(allRows(outFile).counters).toEqual([{ id: "hits", n: 1 }]);
    expect(resumed.sha256).toBe(undisturbed.sha256);
    expect(resumed.changedTables).toEqual(["content_migrations", "counters"]);
    const journal = await readUpdateRun(ctx, ctx.run.id);
    const migrating = journal.records.filter((r) => r.phase === "contentMigrations" && r.state === "done").map((r) => r.step);
    expect(migrating).toEqual(["copy", "storage-migrations", "copy", "storage-migrations", "content-migrations", "migrate-check", "copy", "storage-migrations", "content-migrations", "migrate-check"]);
  }, 60_000);

  it("converts the 5.8.1 fixture with server-side copies into new keys and leaves every old key as it was", async () => {
    const h = harness();
    loadFixtureInto(h);
    const versions = installModules(h);
    const { ctx: base, backupId } = await cutoverOf(h, null);
    const ctx: UpdateContext = { ...base, release: { ...base.release, versions } };
    expect((await releaseStorages(ctx)).map((s) => s.module)).toEqual(["media/default", "images/default"]);
    const objects = h.bucket?.objects ?? new Map<string, { etag: string }>();
    const before = new Map<string, string>([...objects].filter(([key]) => key.startsWith("media/")).map(([key, object]) => [key, object.etag]));
    const writes = h.bucket?.writes.length ?? 0;
    const work = workDir();
    const outFile = join(work, "migrated.sqlite");
    const result = await migrateCopy(ctx, {
      cutoverBackup: backupId,
      plan: plan([
        { module: "media/default", id: "media-default:id-key-layout", kind: "auto", blobWrites: true, pending: 0 },
        { module: "images/default", id: "images-default:variant-slots", kind: "auto", blobWrites: false, pending: 0 },
      ]),
      outFile,
    });
    expect(result.storage.map((m) => [m.module, m.state])).toEqual([
      ["media/default", "migrated"],
      ["images/default", "migrated"],
    ]);
    const during = h.bucket?.writes.slice(writes).filter((w) => !w.key.startsWith("kestrel-backups/")) ?? [];
    expect(during.length).toBeGreaterThan(0);
    expect(during.filter((w) => w.op === "delete" || w.existed)).toEqual([]);
    expect(during.filter((w) => w.op === "copy").length).toBeGreaterThan(0);
    expect(during.every((w) => w.key.startsWith("media/"))).toBe(true);
    for (const [key, etag] of before) expect(h.bucket?.objects.get(key)?.etag, key).toBe(etag);
    const rows = boundaryCast<Array<{ id: string; key: string }>>(allRows(outFile).media_items, "host");
    const logo = rows.find((row) => row.id === fixture.media.logo?.id);
    expect(logo?.key).toBe(`media/${fixture.media.logo?.id}/logo.png`);
    expect(h.bucket?.objects.get(logo?.key ?? "")?.etag).toBe(before.get("media/logo.png"));
    expect(result.changedTables).toContain("media_items");
    expect(result.changedTables).toContain("kestrel_storage_versions");
    expect(result.changedTables.filter((table) => ["pages", "authn_users", "authn_sessions", "redirects", "settings", "content_migrations", "audit_entries"].includes(table))).toEqual([]);
    const original = join(work, "fixture.db");
    copyFixtureDatabase(original);
    expect(changedTables(original, outFile)).toEqual(result.changedTables);
  }, 120_000);

  it("refuses a storage migration the plan does not name before it writes a blob", async () => {
    const h = harness();
    loadFixtureInto(h);
    const versions = installModules(h);
    const { ctx: base, backupId } = await cutoverOf(h, null);
    const ctx: UpdateContext = { ...base, release: { ...base.release, versions } };
    const writes = h.bucket?.writes.length ?? 0;
    const error = await migrateCopy(ctx, { cutoverBackup: backupId, plan: plan([{ module: "images/default", id: "images-default:variant-slots", kind: "auto", blobWrites: false, pending: 0 }]), outFile: join(workDir(), "migrated.sqlite") }).catch((caught: unknown) => caught);
    expect(error instanceof OpsError ? [error.exitCode, error.message] : error).toEqual([1, expect.stringContaining("media-default:id-key-layout")]);
    expect(h.bucket?.writes.slice(writes).filter((w) => !w.key.startsWith("kestrel-backups/"))).toEqual([]);
  }, 120_000);

  it("refuses a cutover backup whose database differs from its manifest", async () => {
    const work = workDir();
    const h = counterHarness(join(work, "crashed"));
    const database = join(work, "cutover.sqlite");
    counterDatabase(database);
    const { ctx, backupId } = await cutoverOf(h, database);
    h.bucket?.tamper(`kestrel-backups/backups/${backupId}/db.sqlite`, new Uint8Array([1, 2, 3]));
    const error = await migrateCopy(ctx, { cutoverBackup: backupId, plan: plan([]), outFile: join(work, "migrated.sqlite") }).catch((caught: unknown) => caught);
    expect(error instanceof OpsError ? error.message : error).toContain("differs from its manifest");
  });
});
