import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";

/** The persistence collection that holds login sessions; a restore empties it. */
export const SESSIONS_TABLE = "authn_sessions";
const USERS_TABLE = "authn_users";
const FACTORS_TABLE = "mfa_factors";
const AUDIT_TABLE = "audit_entries";

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

function withDb<T>(file: string, readOnly: boolean, use: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly });
  try {
    return use(db);
  } finally {
    db.close();
  }
}

/** Writes a compact, self-contained copy of `source` to `target` (no `-wal`); `target` must not exist. */
export function vacuumInto(source: string, target: string): void {
  withDb(source, false, (db) => db.prepare("VACUUM INTO ?").run(target));
  for (const suffix of ["-wal", "-shm"]) rmSync(target + suffix, { force: true });
}

/** The full `PRAGMA integrity_check` verdict: `"ok"` or the problems it found. */
export function integrityCheck(file: string): string {
  try {
    return withDb(file, true, (db) =>
      boundaryCast<Array<{ integrity_check: string }>>(db.prepare("PRAGMA integrity_check").all(), "host")
        .map((r) => r.integrity_check)
        .join("; "),
    );
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** Names of the tables a database holds, without SQLite's own. */
export function tables(db: DatabaseSync, schema = "main"): string[] {
  return boundaryCast<Array<{ name: string }>>(db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all(), "host").map((r) => r.name);
}

function columns(db: DatabaseSync, table: string, schema = "main"): string[] {
  return boundaryCast<Array<{ name: string }>>(db.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all(), "host").map((r) => r.name);
}

const count = (db: DatabaseSync, sql: string): number => boundaryCast<{ n: number }>(db.prepare(sql).get(), "host").n;

/** Rows per table. */
export function tableCounts(file: string): Record<string, number> {
  return withDb(file, true, (db) => Object.fromEntries(tables(db).map((t) => [t, count(db, `SELECT count(*) AS n FROM ${quote(t)}`)])));
}

/** Hex sha256 of a file's bytes. */
export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Hex sha256 of bytes. */
export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deletes every login session; returns how many there were. */
export function deleteSessions(file: string): number {
  return withDb(file, false, (db) => {
    if (!tables(db).includes(SESSIONS_TABLE)) return 0;
    const n = count(db, `SELECT count(*) AS n FROM ${quote(SESSIONS_TABLE)}`);
    db.exec(`DELETE FROM ${quote(SESSIONS_TABLE)}`);
    return n;
  });
}

/** Where the rows of the media collection keep an original's blob key and checksum. */
export interface MediaRows {
  collection: string;
  keyField: string;
  checksumField: string;
}

/** One original a media row references. */
export interface ReferencedBlob {
  key: string;
  sha256: string | null;
}

/** The originals the media rows reference, without duplicates; a database without the collection references none. */
export function referencedBlobs(file: string, media: MediaRows): ReferencedBlob[] {
  return withDb(file, true, (db) => {
    if (!tables(db).includes(media.collection)) return [];
    const cols = columns(db, media.collection);
    if (!cols.includes(media.keyField)) return [];
    const checksum = cols.includes(media.checksumField) ? quote(media.checksumField) : "NULL";
    const rows = boundaryCast<Array<{ key: unknown; sha: unknown }>>(db.prepare(`SELECT ${quote(media.keyField)} AS key, ${checksum} AS sha FROM ${quote(media.collection)} ORDER BY 1`).all(), "host");
    const out = new Map<string, ReferencedBlob>();
    for (const row of rows) {
      if (typeof row.key !== "string" || row.key === "") continue;
      out.set(row.key, { key: row.key, sha256: typeof row.sha === "string" && /^[0-9a-f]{64}$/.test(row.sha) ? row.sha : null });
    }
    return [...out.values()];
  });
}

/** Differences of one table between the current database and a backup, counted from the backup's point of view. */
export interface TableDiff {
  /** Rows only the current database has: written after the backup, gone after a restore. */
  added: number;
  /** Rows both hold with different values; a restore sets the backup's values. */
  changed: number;
  /** Rows only the backup has: deleted after the backup, back after a restore. */
  removed: number;
}

/** Access that a restore would change back, by username. */
export interface AccessChanges {
  /** Users created after the backup; a restore removes them. */
  created: string[];
  /** Users deleted after the backup; a restore brings them back. */
  deleted: string[];
  /** Users deactivated after the backup; a restore makes them active again. */
  deactivated: string[];
  /** Users whose roles differ from the backup's; a restore sets the backup's roles. */
  rolesChanged: string[];
  /** Users whose second factor differs from the backup's or is gone; a restore brings the backup's factor back. */
  mfaReset: string[];
}

/** What a restore of a backup would discard or bring back, compared with the current database. */
export interface LossReport {
  since: number;
  tables: Record<string, TableDiff>;
  auditEntriesAfter: number;
  access: AccessChanges;
  /** True when the databases differ in nothing but login sessions. */
  identical: boolean;
}

/** True when `report` lists any access change. */
export function hasAccessChanges(report: LossReport): boolean {
  const a = report.access;
  return a.created.length + a.deleted.length + a.deactivated.length + a.rolesChanged.length + a.mfaReset.length > 0;
}

function tableDiff(db: DatabaseSync, table: string): TableDiff {
  const inMain = columns(db, table, "main");
  const inBackup = new Set(columns(db, table, "backup"));
  const shared = inMain.filter((c) => inBackup.has(c));
  if (!shared.includes("id")) {
    const list = shared.map(quote).join(", ");
    const added = count(db, `SELECT count(*) AS n FROM (SELECT ${list} FROM main.${quote(table)} EXCEPT SELECT ${list} FROM backup.${quote(table)})`);
    const removed = count(db, `SELECT count(*) AS n FROM (SELECT ${list} FROM backup.${quote(table)} EXCEPT SELECT ${list} FROM main.${quote(table)})`);
    return { added, changed: 0, removed };
  }
  const t = quote(table);
  const added = count(db, `SELECT count(*) AS n FROM main.${t} m WHERE NOT EXISTS (SELECT 1 FROM backup.${t} b WHERE b."id" = m."id")`);
  const removed = count(db, `SELECT count(*) AS n FROM backup.${t} b WHERE NOT EXISTS (SELECT 1 FROM main.${t} m WHERE m."id" = b."id")`);
  const list = shared.map(quote).join(", ");
  const differing = count(db, `SELECT count(*) AS n FROM (SELECT ${list} FROM main.${t} EXCEPT SELECT ${list} FROM backup.${t})`);
  return { added, changed: differing - added, removed };
}

interface UserRow {
  id: string;
  username: string;
  active: unknown;
  roles: unknown;
}

function accessChanges(db: DatabaseSync, current: string[], backup: string[]): AccessChanges {
  const out: AccessChanges = { created: [], deleted: [], deactivated: [], rolesChanged: [], mfaReset: [] };
  if (!current.includes(USERS_TABLE) || !backup.includes(USERS_TABLE)) return out;
  const read = (schema: string): Map<string, UserRow> => new Map(boundaryCast<UserRow[]>(db.prepare(`SELECT "id", "username", "active", "roles" FROM ${schema}.${quote(USERS_TABLE)}`).all(), "host").map((u) => [u.id, u]));
  const now = read("main");
  const then = read("backup");
  for (const [id, user] of now) {
    const old = then.get(id);
    if (!old) out.created.push(user.username);
    else {
      if (Number(old.active) === 1 && Number(user.active) !== 1) out.deactivated.push(user.username);
      if (String(old.roles) !== String(user.roles)) out.rolesChanged.push(user.username);
    }
  }
  for (const [id, user] of then) if (!now.has(id)) out.deleted.push(user.username);
  if (current.includes(FACTORS_TABLE) && backup.includes(FACTORS_TABLE)) {
    const factors = (schema: string): Map<string, string> => new Map(boundaryCast<Array<{ userId: string; secret: string }>>(db.prepare(`SELECT "userId", "secret" FROM ${schema}.${quote(FACTORS_TABLE)}`).all(), "host").map((f) => [f.userId, f.secret]));
    const nowFactors = factors("main");
    for (const [userId, secret] of factors("backup")) {
      if (nowFactors.get(userId) === secret) continue;
      const user = then.get(userId) ?? now.get(userId);
      out.mfaReset.push(user?.username ?? userId);
    }
  }
  for (const list of [out.created, out.deleted, out.deactivated, out.rolesChanged, out.mfaReset]) list.sort();
  return out;
}

/**
 * Compares the current database with a backup's and reports what a restore of the backup would discard or bring
 * back. Audit entries after the backup are the ones the backup does not hold by id, or, without an id column, the
 * ones later than `since`.
 */
export function lossReport(currentFile: string, backupFile: string, since: number): LossReport {
  return withDb(currentFile, true, (db) => {
    db.prepare("ATTACH DATABASE ? AS backup").run(backupFile);
    try {
      const current = tables(db, "main");
      const backup = tables(db, "backup");
      const report: LossReport = { since, tables: {}, auditEntriesAfter: 0, access: accessChanges(db, current, backup), identical: true };
      for (const table of [...new Set([...current, ...backup])].sort()) {
        let diff: TableDiff;
        if (!backup.includes(table)) diff = { added: count(db, `SELECT count(*) AS n FROM main.${quote(table)}`), changed: 0, removed: 0 };
        else if (!current.includes(table)) diff = { added: 0, changed: 0, removed: count(db, `SELECT count(*) AS n FROM backup.${quote(table)}`) };
        else diff = tableDiff(db, table);
        if (diff.added + diff.changed + diff.removed === 0) continue;
        report.tables[table] = diff;
        if (table !== SESSIONS_TABLE) report.identical = false;
      }
      const audit = quote(AUDIT_TABLE);
      if (current.includes(AUDIT_TABLE) && backup.includes(AUDIT_TABLE) && columns(db, AUDIT_TABLE, "main").includes("id") && columns(db, AUDIT_TABLE, "backup").includes("id")) report.auditEntriesAfter = count(db, `SELECT count(*) AS n FROM main.${audit} m WHERE NOT EXISTS (SELECT 1 FROM backup.${audit} b WHERE b."id" = m."id")`);
      else if (current.includes(AUDIT_TABLE) && columns(db, AUDIT_TABLE).includes("at")) report.auditEntriesAfter = boundaryCast<{ n: number }>(db.prepare(`SELECT count(*) AS n FROM main.${audit} WHERE "at" > ?`).get(since), "host").n;
      return report;
    } finally {
      db.exec("DETACH DATABASE backup");
    }
  });
}
