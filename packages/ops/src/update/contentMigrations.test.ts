import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { LocalBootConfig } from "../environments.ts";
import { OpsError } from "../errors.ts";
import { ledgerIds, runContentMigrations } from "./contentMigrations.ts";
import { createUpdateHarness, type UpdateHarness } from "./harness.fixture.ts";

const harnesses: UpdateHarness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const STAND_IN = `import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
writeFileSync(process.env.OUT, JSON.stringify(process.env));
const db = new DatabaseSync(process.env.DB);
if (!db.prepare("SELECT 1 AS hit FROM content_migrations WHERE id = 'count-hits'").get()) {
  db.exec("UPDATE counters SET n = n + 1 WHERE id = 'hits'");
  if (process.env.CRASH_MARK && !existsSync(process.env.CRASH_MARK)) {
    writeFileSync(process.env.CRASH_MARK, "crashed");
    process.kill(process.pid, "SIGKILL");
  }
  db.exec("INSERT INTO content_migrations VALUES ('count-hits', 0, 1, 0)");
  if (process.env.EXTRA === "yes") db.exec("INSERT INTO content_migrations VALUES ('unplanned', 0, 0, 0)");
}
db.close();
createServer((req, res) => {
  res.statusCode = req.url === "/ready" ? 200 : 404;
  res.end();
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

function counterDatabase(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE counters ("id" TEXT PRIMARY KEY, "n" INTEGER);
    INSERT INTO counters VALUES ('hits', 0);
    CREATE TABLE pages ("id" TEXT PRIMARY KEY, "title" TEXT);
    INSERT INTO pages VALUES ('home', 'Home');
    CREATE TABLE content_migrations ("id" TEXT PRIMARY KEY, "appliedAt" INTEGER, "documents" INTEGER, "durationMs" INTEGER);`);
  db.close();
}

function standInBoot(out: string, extra: Record<string, string> = {}): LocalBootConfig {
  return { command: ["node", "stand-in.mjs"], dir: ".", env: { DB: "{database}", PORT: "{port}", BLOBS: "{blobs}", BUILD: "{build}", OUT: out, ...extra }, readyPath: "/ready", timeoutSeconds: 30 };
}

function counter(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number(boundaryCast<{ n: number }>(db.prepare("SELECT n FROM counters WHERE id = 'hits'").get(), "host").n);
  } finally {
    db.close();
  }
}

function workDir(): string {
  const work = mkdtempSync(join(tmpdir(), "kestrel-ops-content-"));
  dirs.push(work);
  return work;
}

function setup(extra: Record<string, string> = {}) {
  const work = workDir();
  const out = join(work, "env.json");
  const h = createUpdateHarness({ update: { localBoot: standInBoot(out, extra) } });
  harnesses.push(h);
  writeFileSync(join(h.releaseDir, "stand-in.mjs"), STAND_IN);
  const database = join(work, "copy.sqlite");
  counterDatabase(database);
  return { h, out, database, blobsDir: join(work, "blobs") };
}

describe("content migrations through a local start of the release", () => {
  it("starts the release with exactly the configured environment, none of this process's credentials, and stops it", async () => {
    const { h, out, database, blobsDir } = setup({ MODE: "local" });
    const saved = { ...process.env };
    Object.assign(process.env, { AWS_ACCESS_KEY_ID: "AKIA-parent-process-key", AWS_SECRET_ACCESS_KEY: "parent-process-secret-value", OPS_SECRET_KEY: "another-parent-secret" });
    try {
      const ctx = await h.context();
      const withHost = { ...ctx, host: { localBootEnv: { SITE_MODE: "static", MODE: "from-host" } } };
      const result = await runContentMigrations(withHost, { database, blobsDir, expected: ["count-hits"] });
      expect(result).toMatchObject({ ran: true, applied: ["count-hits"] });
      expect(result.bootMs).toBeGreaterThan(0);
      const seen = boundaryCast<Record<string, string>>(JSON.parse(readFileSync(out, "utf8")), "json");
      expect(Object.keys(seen).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort()).toEqual(["BLOBS", "BUILD", "DB", "MODE", "OUT", "PORT", "SITE_MODE"]);
      expect(seen).toMatchObject({ DB: database, BLOBS: blobsDir, MODE: "local", SITE_MODE: "static", BUILD: `kestrel-ops-local-${ctx.runId}` });
      expect(Number(seen.PORT)).toBeGreaterThan(0);
      expect(JSON.stringify(seen)).not.toMatch(/parent-process|another-parent-secret/);
      expect(counter(database)).toBe(1);
      expect(ledgerIds(database)).toEqual(["count-hits"]);
      const port = Number(seen.PORT);
      await expect(fetch(`http://127.0.0.1:${port}/ready`)).rejects.toThrow();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) Reflect.deleteProperty(process.env, key);
      Object.assign(process.env, saved);
    }
  });

  it("starts nothing when no content migration is pending", async () => {
    const { h, out, database, blobsDir } = setup();
    const ctx = await h.context();
    expect(await runContentMigrations(ctx, { database, blobsDir, expected: [] })).toEqual({ ran: false, applied: [], bootMs: null });
    expect(existsSync(out)).toBe(false);
    await runContentMigrations(ctx, { database, blobsDir, expected: ["count-hits"] });
    rmSync(out);
    expect(await runContentMigrations(ctx, { database, blobsDir, expected: ["count-hits"] })).toEqual({ ran: false, applied: [], bootMs: null });
    expect(existsSync(out)).toBe(false);
  });

  it("refuses with exit 2 a pending content migration when the environment names no local start", async () => {
    const h = createUpdateHarness();
    harnesses.push(h);
    const work = workDir();
    const database = join(work, "copy.sqlite");
    counterDatabase(database);
    const error = await runContentMigrations(await h.context(), { database, blobsDir: join(work, "blobs"), expected: ["count-hits"] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpsError);
    expect(error instanceof OpsError ? [error.exitCode, error.element] : []).toEqual([2, "update.localBoot"]);
    expect(error instanceof Error ? error.message : "").toContain("count-hits");
  });

  it("refuses with exit 1 a start that applied a migration the plan does not name, or ended before it was ready", async () => {
    const extra = setup({ EXTRA: "yes" });
    const unplanned = await runContentMigrations(await extra.h.context(), { database: extra.database, blobsDir: extra.blobsDir, expected: ["count-hits"] }).catch((caught: unknown) => caught);
    expect(unplanned instanceof OpsError ? [unplanned.exitCode, unplanned.message] : []).toEqual([1, expect.stringContaining("unplanned")]);
    const crashing = setup({ CRASH_MARK: join(workDir(), "crashed") });
    const crashed = await runContentMigrations(await crashing.h.context(), { database: crashing.database, blobsDir: crashing.blobsDir, expected: ["count-hits"] }).catch((caught: unknown) => caught);
    expect(crashed instanceof OpsError ? [crashed.exitCode, crashed.message] : []).toEqual([1, expect.stringContaining("signal SIGKILL")]);
  });
});
