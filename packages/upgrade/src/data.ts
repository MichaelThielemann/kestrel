import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord, isString } from "./guards.ts";
import type { Finding, UpgradeReport } from "./report.ts";
import { summarize } from "./report.ts";

export interface DataStepResult {
  exitCode: number;
  report?: UpgradeReport;
  error?: string;
}

async function copyWithSiblings(file: string, dir: string): Promise<string> {
  const dest = join(dir, "kestrel.db");
  await copyFile(file, dest);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${file}${suffix}`)) await copyFile(`${file}${suffix}`, `${dest}${suffix}`);
  }
  return dest;
}

function quickCheckOk(file: string): boolean {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return false;
  }
  try {
    const rows = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    return rows.length === 1 && Object.values(rows[0]!)[0] === "ok";
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function queueUnfanned(file: string): Finding[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events_queue'").all();
    if (tables.length === 0) return [];
    const raw = db.prepare(`SELECT "name" AS event, COUNT(*) AS n FROM "events_queue" WHERE "pipeline" IS NULL AND "state" IN ('pending', 'running') GROUP BY "name"`).all();
    const rows = raw.flatMap((row) => {
      if (!isRecord(row) || !isString(row.event) || typeof row.n !== "number") return [];
      return [{ event: row.event, n: row.n }];
    });
    return rows.map((row) => ({
      id: `data/queue-unfanned:${row.event}`,
      rule: "data/queue-unfanned",
      severity: "warning",
      tier: "data",
      where: { path: row.event },
      message: `${row.n} stored event(s) named "${row.event}" are not yet fanned out to a pipeline`,
      suggestion: "at the first 6.0 tick these fan out to every pipeline subscribed then; drain the queue at cutover",
      fix: { kind: "none" },
      docs: "docs/upgrading.md#cutover",
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Copies `dbFile` (and any `-wal`/`-shm` siblings), verifies the copy with `PRAGMA quick_check`, then reads it read-only; the given file is never opened after the copy. */
export async function runDataStep(dbFile: string): Promise<DataStepResult> {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-data-"));
  let copy: string;
  try {
    copy = await copyWithSiblings(dbFile, dir);
  } catch (err) {
    return { exitCode: 2, error: `cannot copy "${dbFile}": ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!quickCheckOk(copy)) {
    return { exitCode: 2, error: `the copy of "${dbFile}" did not pass PRAGMA quick_check; take a consistent snapshot (persistence.snapshot, a replication snapshot, or "sqlite3 <db> .backup <copy>") and try again` };
  }
  const findings = queueUnfanned(copy);
  const report: UpgradeReport = {
    schema: 1,
    tool: { name: "kestrel-upgrade", version: "0.0.0" },
    target: "6.0.0",
    project: { root: dbFile, kind: "data", installed: {} },
    tiers: { source: "not-run", load: "not-run", boot: "not-run", data: "done" },
    summary: summarize(findings),
    findings,
  };
  const exitCode = findings.some((f) => f.severity === "error") ? 1 : 0;
  return { exitCode, report };
}
