import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { isErr, type Result } from "@michaelthielemann/kestrel/result";
import type { Document, Page, Persistence, PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Finding, UpgradeReport } from "./report.ts";
import { summarize } from "./report.ts";

export interface DataStepResult {
  exitCode: number;
  report?: UpgradeReport;
  error?: string;
}

const QUEUE_SCHEMA = {
  name: "string",
  payload: "json",
  pipeline: "string",
  state: "string",
  attempts: "number",
  createdAt: "number",
  availableAt: "number",
  lockedAt: "number",
  lockedBy: "string",
  finishedAt: "number",
  error: "string",
  runId: "string",
} as const;

interface QueueRow extends Document {
  name: string;
  pipeline: string | null;
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

interface PersistenceSqliteModule {
  createPersistenceSqlite(config: { file: string }, deps?: { logger?: unknown }): Persistence & { close(): void };
}

async function loadProjectPersistenceSqlite(root: string): Promise<PersistenceSqliteModule | undefined> {
  try {
    const require = createRequire(pathToFileURL(resolve(root, "package.json")).href);
    const implFile = require.resolve("@michaelthielemann/kestrel-persistence-sqlite/impl");
    const mod: unknown = await import(pathToFileURL(implFile).href);
    return boundaryCast<PersistenceSqliteModule>(mod, "host");
  } catch {
    return undefined;
  }
}

function unwrap<T>(result: Result<T, PersistenceError>, fallback: T): T {
  return isErr(result) ? fallback : result.value;
}

async function queueFindings(root: string, copy: string): Promise<{ findings: Finding[]; error?: string }> {
  const mod = await loadProjectPersistenceSqlite(root);
  if (mod === undefined) return { findings: [], error: "the project's own @michaelthielemann/kestrel-persistence-sqlite could not be resolved; install the project's dependencies first" };
  const db = mod.createPersistenceSqlite({ file: copy }, { logger: silentLogger });
  try {
    const ensured = await db.ensureCollection("events_queue", QUEUE_SCHEMA);
    if (isErr(ensured)) return { findings: [] };

    const unfanned = await db.findMany<QueueRow>("events_queue", { pipeline: null, state: { in: ["pending", "running"] } }, { limit: 10_000 });
    const dead = await db.findMany<QueueRow>("events_queue", { pipeline: null, state: "dead" }, { limit: 10_000 });

    const byEvent = new Map<string, number>();
    for (const row of unwrap<Page<QueueRow>>(unfanned, { items: [], total: 0 }).items) byEvent.set(row.name, (byEvent.get(row.name) ?? 0) + 1);

    const findings: Finding[] = [...byEvent.entries()].map(([event, n]) => ({
      id: `data/queue-unfanned:${event}`,
      rule: "data/queue-unfanned",
      severity: "warning",
      tier: "data",
      where: { path: event },
      message: `${n} stored event(s) named "${event}" are not yet fanned out to a pipeline`,
      suggestion: "at the first 6.0 tick these fan out to every pipeline subscribed then; drain the queue at cutover",
      fix: { kind: "none" },
      docs: "docs/upgrading.md#cutover",
    }));

    const deadRows = unwrap<Page<QueueRow>>(dead, { items: [], total: 0 }).items;
    if (deadRows.length > 0) {
      findings.push({
        id: "data/queue-dead-unassigned",
        rule: "data/queue-dead-unassigned",
        severity: "info",
        tier: "data",
        where: {},
        message: `${deadRows.length} dead-letter row(s) have no pipeline assigned`,
        suggestion: "a retry re-fans them out to every pipeline currently subscribed",
        fix: { kind: "none" },
        docs: "docs/upgrading.md#cutover",
      });
    }
    return { findings };
  } finally {
    db.close();
  }
}

/** Copies `dbFile` (and any `-wal`/`-shm` siblings), verifies the copy with `PRAGMA quick_check`, then reads it through the project's own persistence-sqlite; the given file is never opened after the copy. */
export async function runDataStep(dbFile: string, root: string): Promise<DataStepResult> {
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
  const { findings, error } = await queueFindings(root, copy);
  if (error !== undefined) return { exitCode: 2, error };
  const report: UpgradeReport = {
    schema: 1,
    tool: { name: "kestrel-upgrade", version: "0.0.0" },
    target: "6.0.0",
    project: { root, kind: "data", installed: {} },
    tiers: { source: "not-run", load: "not-run", boot: "not-run", data: "done" },
    summary: summarize(findings),
    findings,
  };
  const exitCode = findings.some((f) => f.severity === "error") ? 1 : 0;
  return { exitCode, report };
}
