import type { ColumnShape, IndexShape, TableShape, SchemaSnapshot } from './model'

// Read the *actual* schema of a live SQLite database into the normalized model, so `diffSchema` can
// compare it against the desired schema (ADR-0002). Typed structurally (prepare + pragma) to keep the
// native module out of this file — but the shape is narrower than better-sqlite3's own (which types
// `pragma` as returning `unknown`), so a real connection only reaches these entry points through a cast.

interface Row { [key: string]: unknown }
export interface IntrospectDb {
  prepare(sql: string): { all(...params: unknown[]): Row[] }
  pragma(source: string): Row[]
}

/** Double-quote an identifier for a PRAGMA argument (names come from sqlite_master, but quote defensively). */
const dq = (id: string) => `"${id.replace(/"/g, '""')}"`

export function introspect(db: IntrospectDb): SchemaSnapshot {
  // Exclude sqlite internals, the drizzle migrations ledger, and any `__kestrel_new_*` rebuild temp
  // table left by an interrupted rebuild — so an orphan is never mistaken for a real (droppable) table.
  const tables = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__kestrel_new_%' AND name <> '__drizzle_migrations'",
  ).all() as { name: string; sql: string | null }[]

  const snapshot: SchemaSnapshot = {}
  for (const { name, sql } of tables) {
    snapshot[name] = { name, columns: columnsOf(db, name, sql ?? ''), indexes: indexesOf(db, name) }
  }
  return snapshot
}

function columnsOf(db: IntrospectDb, table: string, tableSql: string): ColumnShape[] {
  // PRAGMA exposes no AUTOINCREMENT flag — it only ever applies to the INTEGER PRIMARY KEY, so detect
  // it from the table's stored CREATE statement.
  const hasAutoInc = /\bAUTOINCREMENT\b/i.test(tableSql)
  const rows = db.pragma(`table_info(${dq(table)})`) as
    { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[]
  return rows.map((r) => ({
    name: r.name,
    type: r.type.toLowerCase(),
    notNull: r.notnull === 1,
    primaryKey: r.pk > 0,
    autoIncrement: r.pk > 0 && hasAutoInc,
    default: r.dflt_value == null ? null : String(r.dflt_value),
  }))
}

function indexesOf(db: IntrospectDb, table: string): IndexShape[] {
  const uniqueByName = new Map(
    (db.pragma(`index_list(${dq(table)})`) as { name: string; unique: number }[]).map((m) => [m.name, m.unique === 1]),
  )
  // Only explicitly-created indexes carry a non-null `sql`; auto-indexes from UNIQUE/PK constraints are
  // null-sql and excluded (they mirror column constraints, not declared indexes).
  const rows = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
  ).all(table) as { name: string; sql: string }[]

  return rows.map(({ name, sql }) => {
    const columns = (db.pragma(`index_info(${dq(name)})`) as { name: string }[]).map((c) => c.name)
    const where = sql.match(/\bWHERE\b\s+(.+)$/is)
    return {
      name,
      table,
      columns,
      unique: uniqueByName.get(name) ?? /\bCREATE\s+UNIQUE\b/i.test(sql),
      where: where ? where[1].trim() : null,
    }
  })
}
