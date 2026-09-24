import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "@michaelthielemann/kestrel/load";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { isErr } from "@michaelthielemann/kestrel/result";
import type { Document, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { trackTempDir, untrackTempDir } from "./cleanup.ts";
import { isRecord } from "./guards.ts";
import type { Finding, UpgradeReport } from "./report.ts";
import { summarize } from "./report.ts";
import { useToken } from "./useToken.ts";

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

async function queueFindings(db: Persistence): Promise<{ findings: Finding[]; error?: string }> {
  const ensured = await db.ensureCollection("events_queue", QUEUE_SCHEMA);
  if (isErr(ensured)) return { findings: [], error: `could not read the events_queue collection: ${ensured.error.message}` };

  const unfanned = await db.findMany<QueueRow>("events_queue", { pipeline: null, state: { in: ["pending", "running"] } }, { limit: 10_000 });
  if (isErr(unfanned)) return { findings: [], error: `could not read pending/running rows from events_queue: ${unfanned.error.message}` };
  const dead = await db.findMany<QueueRow>("events_queue", { pipeline: null, state: "dead" }, { limit: 10_000 });
  if (isErr(dead)) return { findings: [], error: `could not read dead rows from events_queue: ${dead.error.message}` };

  const byEvent = new Map<string, number>();
  for (const row of unfanned.value.items) byEvent.set(row.name, (byEvent.get(row.name) ?? 0) + 1);

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

  const deadRows = dead.value.items;
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
}

async function contentDefaultConfig(root: string): Promise<unknown> {
  try {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    return config.modules.find((m) => useToken(m.use) === "content-default")?.config;
  } catch {
    return undefined;
  }
}

function contentFieldsOf(config: unknown): Array<{ typeName: string; field: string; localized: boolean }> {
  const out: Array<{ typeName: string; field: string; localized: boolean }> = [];
  if (!isRecord(config) || !isRecord(config.types)) return out;
  for (const [typeName, type] of Object.entries(config.types)) {
    if (!isRecord(type) || !isRecord(type.fields)) continue;
    for (const [field, def] of Object.entries(type.fields)) out.push({ typeName, field, localized: isRecord(def) && def.localized === true });
  }
  return out;
}

function declaredFieldsByType(config: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!isRecord(config) || !isRecord(config.types)) return out;
  for (const [typeName, type] of Object.entries(config.types)) {
    if (!isRecord(type) || !isRecord(type.fields)) continue;
    out.set(typeName, new Set(Object.keys(type.fields)));
  }
  return out;
}

function localesOf(config: unknown): string[] {
  const locales = isRecord(config) ? config.locales : undefined;
  return Array.isArray(locales) ? locales.filter((l): l is string => typeof l === "string") : [];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function existingColumns(file: string, table: string): Set<string> | undefined {
  if (!IDENTIFIER.test(table)) return undefined;
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const exists = raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (exists === undefined) return undefined;
    const rows = boundaryCast<Array<{ name: string }>>(raw.prepare(`PRAGMA table_info("${table}")`).all(), "host");
    return new Set(rows.map((r) => r.name));
  } finally {
    raw.close();
  }
}

async function countColumn(db: Persistence, typeName: string, column: string): Promise<number | null> {
  try {
    const ensured = await db.ensureCollection(typeName, { [column]: "string" });
    if (isErr(ensured)) return null;
    const counted = await db.count(typeName, { [column]: { ne: null } });
    return isErr(counted) ? null : counted.value;
  } catch {
    return null;
  }
}

async function underscoreFieldCounts(file: string, db: Persistence, contentConfig: unknown): Promise<Record<string, Record<string, number | null>>> {
  const locales = localesOf(contentConfig);
  const declaredFields = declaredFieldsByType(contentConfig);
  const columnsByType = new Map<string, Set<string> | undefined>();
  const counts: Record<string, Record<string, number | null>> = {};
  for (const { typeName, field, localized } of contentFieldsOf(contentConfig)) {
    const shadowField = field.startsWith("_") ? field : `_${field}`;
    const isOrphanProbe = shadowField !== field;
    if (isOrphanProbe && declaredFields.get(typeName)?.has(shadowField)) continue;
    if (!columnsByType.has(typeName)) columnsByType.set(typeName, existingColumns(file, typeName));
    const columns = columnsByType.get(typeName);
    const columnsOf = localized ? locales.map((locale) => ({ locale, column: `${shadowField}__${locale}` })) : [{ locale: "unlocalized", column: shadowField }];
    if (isOrphanProbe && (columns === undefined || !columnsOf.some((c) => columns.has(c.column)))) continue;

    const perLocale: Record<string, number | null> = {};
    for (const { locale, column } of columnsOf) {
      if (columns === undefined || !columns.has(column)) {
        perLocale[locale] = null;
        continue;
      }
      perLocale[locale] = await countColumn(db, typeName, column);
    }
    counts[`${typeName}.${shadowField}`] = perLocale;
  }
  return counts;
}

function describeCounts(counts: Record<string, number | null>): string {
  return Object.entries(counts)
    .map(([locale, n]) => {
      if (n === null) return locale === "unlocalized" ? "not counted" : `not counted in "${locale}"`;
      return locale === "unlocalized" ? `${n} stored value(s)` : `${n} in "${locale}"`;
    })
    .join(", ");
}

function underscoreFieldFindings(counts: Record<string, Record<string, number | null>>): Finding[] {
  const findings: Finding[] = [];
  for (const [key, perLocale] of Object.entries(counts)) {
    if (Object.values(perLocale).every((n) => n === 0)) continue;
    findings.push({
      id: `data/underscore-field-stored:${key}`,
      rule: "data/underscore-field-stored",
      severity: "warning",
      tier: "data",
      where: { path: key },
      message: `"${key}": ${describeCounts(perLocale)}`,
      suggestion: "add a migration on the running 5.8.x instance (defineMigration) copying it to the new key before upgrading",
      fix: { kind: "none" },
      docs: "docs/upgrading.md#model-underscore-field",
    });
  }
  return findings;
}

/** Copies `dbFile` (and any `-wal`/`-shm` siblings), verifies the copy with `PRAGMA quick_check`, then reads it through the project's own persistence-sqlite; the given file is never opened after the copy. The copy directory is always removed before returning, whether the step succeeds or refuses. */
export async function runDataStep(dbFile: string, root: string): Promise<DataStepResult> {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-data-"));
  trackTempDir(dir);
  try {
    let copy: string;
    try {
      copy = await copyWithSiblings(dbFile, dir);
    } catch (err) {
      return { exitCode: 2, error: `cannot copy "${dbFile}": ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!quickCheckOk(copy)) {
      return { exitCode: 2, error: `the copy of "${dbFile}" did not pass PRAGMA quick_check; take a consistent snapshot (persistence.snapshot, a replication snapshot, or "sqlite3 <db> .backup <copy>") and try again` };
    }
    const mod = await loadProjectPersistenceSqlite(root);
    if (mod === undefined) return { exitCode: 2, error: "the project's own @michaelthielemann/kestrel-persistence-sqlite could not be resolved; install the project's dependencies first" };
    const db = mod.createPersistenceSqlite({ file: copy }, { logger: silentLogger });
    let queued: { findings: Finding[]; error?: string };
    let counts: Record<string, Record<string, number | null>>;
    try {
      queued = await queueFindings(db);
      if (queued.error !== undefined) return { exitCode: 2, error: queued.error };
      const contentConfig = await contentDefaultConfig(root);
      counts = contentConfig === undefined ? {} : await underscoreFieldCounts(copy, db, contentConfig);
    } finally {
      db.close();
    }
    const findings = [...queued.findings, ...underscoreFieldFindings(counts)];
    const report: UpgradeReport = {
      schema: 1,
      tool: { name: "kestrel-upgrade", version: "0.0.0" },
      target: "6.0.0",
      project: { root, kind: "data", installed: {} },
      tiers: { source: "not-run", load: "not-run", boot: "not-run", data: "done" },
      summary: summarize(findings),
      findings,
      underscoreFields: counts,
    };
    const exitCode = findings.some((f) => f.severity === "error") ? 1 : 0;
    return { exitCode, report };
  } finally {
    untrackTempDir(dir);
    await rm(dir, { recursive: true, force: true });
  }
}
