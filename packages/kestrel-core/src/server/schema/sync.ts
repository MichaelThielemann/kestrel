import type { IntrospectDb } from './introspect.js'
import { diffSchema } from './diff.js'
import { sqlite, type Dialect } from './dialect.js'
import type { SchemaSnapshot, SchemaOp } from './model.js'

/** @public */
export interface SyncDb extends IntrospectDb {
  exec(sql: string): unknown
  transaction(fn: () => void): () => void
}

/** Destructive ops drop or rebuild a table (potential data loss); they require an explicit opt-in (ADR-0002).
 * @public
 */
export function isDestructive(op: SchemaOp): boolean {
  return op.type === 'drop_table' || op.type === 'rebuild_table'
}

/** The table an op targets, regardless of variant shape — the seam `tables` (below) and the per-module
 * @public
 *  migration task filter ops on. */
export function opTable(op: SchemaOp): string {
  switch (op.type) {
    case 'drop_table': return op.name
    case 'create_table':
    case 'rebuild_table': return op.table.name
    case 'add_column':
    case 'rename_column': return op.table
    case 'create_index':
    case 'drop_index': return op.index.table
  }
}

/** Human description of an op, for dry-run reports and the dev skipped-warning so data loss is visible.
 * @public
 */
export function describeOp(op: SchemaOp): string {
  if (op.type === 'drop_table') return `drop table \`${op.name}\``
  if (op.type === 'rebuild_table') {
    // Name the carried columns + any transform sources (not just a count), so the operator can see exactly
    // what survives — everything else that is live but NOT in this list has its data dropped by the rebuild.
    const carried = op.copy.join(', ') || '—'
    const sources = [...new Set(Object.values(op.transforms ?? {}).map((t) => t.from))]
    const from = sources.length ? ` (+ transform source(s): ${sources.join(', ')})` : ''
    return `rebuild table \`${op.table.name}\` — keeps: ${carried}${from}; any other live column's data is dropped`
  }
  if (op.type === 'create_table') return `create table \`${op.table.name}\` (${op.table.columns.length} column(s))`
  if (op.type === 'add_column') return `add column \`${op.table}\`.\`${op.column.name}\` ${op.column.type}`
  if (op.type === 'create_index') return `create index \`${op.index.name}\` on \`${op.index.table}\` (${op.index.columns.join(', ')})`
  if (op.type === 'drop_index') return `drop index \`${op.index.name}\` on \`${op.index.table}\``
  if (op.type === 'rename_column') return `rename column \`${op.table}\`.\`${op.from}\` to \`${op.to}\``
  return (op as SchemaOp).type
}

/**
 * Reasons SQLite would reject a rebuild's `INSERT…SELECT` — surfaced up-front as a clear error instead
 * of an opaque "NOT NULL constraint failed" inside an aborted transaction:
 *  - a NOT NULL column with no default that isn't carried over (a new required field on a populated table)
 *  - a carried-over column that became NOT NULL but whose existing rows still hold NULL
 * Identifier quoting comes from the dialect (the feasibility probes run against the live DB).
 */
function rebuildProblems(db: SyncDb, op: Extract<SchemaOp, { type: 'rebuild_table' }>, quote: Dialect['quote'], renames: Map<string, string>): string[] {
  const carried = new Set(op.copy)
  const problems: string[] = []
  // The probes run against the LIVE table, which still holds the PRE-migration column names: rename_column
  // ops and the rebuild's INSERT…SELECT only run later, inside the transaction. So resolve each carried
  // column to its live SOURCE expression — a transform's `from`, else its own name — and skip when no live
  // source exists yet (a plain rename we can't map here), rather than probe a name that doesn't exist and
  // abort the whole migration with `no such column`. The expressions mirror render-sqlite's `copySource`.
  const liveCols = new Set((db.pragma(`table_info("${op.table.name.replace(/"/g, '""')}")`) as { name: string }[]).map((r) => r.name))
  const liveSourceIsNull = (c: string): boolean | null => {
    const t = op.transforms?.[c]
    if (t) {
      // `wrap` (single→multiple) coalesces NULL to '[]' → never NULL. `unwrap` (multiple→single) is
      // `json_extract(from, '$[0]')` → NULL for a NULL or empty source array.
      if (t.type === 'wrap') return false
      if (!liveCols.has(t.from)) return null
      return db.prepare(`SELECT 1 FROM ${quote(op.table.name)} WHERE json_extract(${quote(t.from)}, '$[0]') IS NULL LIMIT 1`).all().length > 0
    }
    if (!liveCols.has(c)) {
      // The column isn't live under its NEW name yet — it arrives via a plain `rename_column` that runs
      // first. Probe its OLD live name instead (the rename preserves data, so a NOT NULL target still
      // fails on rows the old column left NULL). Only skip when even the source name isn't live.
      const from = renames.get(`${op.table.name} ${c}`)
      if (from && liveCols.has(from)) return db.prepare(`SELECT 1 FROM ${quote(op.table.name)} WHERE ${quote(from)} IS NULL LIMIT 1`).all().length > 0
      return null
    }
    return db.prepare(`SELECT 1 FROM ${quote(op.table.name)} WHERE ${quote(c)} IS NULL LIMIT 1`).all().length > 0
  }
  for (const c of op.table.columns) {
    if (!c.notNull || c.default !== null || c.autoIncrement) continue
    if (!carried.has(c.name)) {
      problems.push(`${op.table.name}.${c.name}: new NOT NULL column has no default and no data to copy`)
    } else if (liveSourceIsNull(c.name) === true) {
      problems.push(`${op.table.name}.${c.name}: became NOT NULL but existing rows hold NULL`)
    }
  }
  // A UNIQUE index recreated by the rebuild over carried-over data that already holds duplicates would
  // abort the migration; flag it up front. (SQLite treats NULLs as distinct, so only non-null rows count.)
  // Only probe when every index column already exists live (a renamed/transformed column can't be checked
  // here without a live name — skip rather than crash, same as the NULL probe above).
  for (const idx of op.table.indexes) {
    if (!idx.unique || !idx.columns.every((c) => carried.has(c) && liveCols.has(c))) continue
    const cols = idx.columns.map(quote).join(', ')
    const notNull = idx.columns.map((c) => `${quote(c)} IS NOT NULL`).join(' AND ')
    const partial = idx.where ? ` AND (${idx.where})` : ''
    const dup = db.prepare(`SELECT 1 FROM ${quote(op.table.name)} WHERE ${notNull}${partial} GROUP BY ${cols} HAVING COUNT(*) > 1 LIMIT 1`).all().length > 0
    if (dup) problems.push(`${op.table.name}.(${idx.columns.join(', ')}): UNIQUE index "${idx.name}" has duplicate values in existing rows`)
  }
  return problems
}

/**
 * A plain `ALTER TABLE … ADD COLUMN` can't add a NOT NULL column with no default to a table that
 * already holds rows (SQLite rejects it; an empty table is fine). This is reachable purely additively —
 * adding a required field with no default to a populated collection emits a standalone `add_column`,
 * never a rebuild — so the rebuild pre-flight misses it. Surface it as the same up-front 'infeasible'
 * message instead of an opaque mid-transaction abort.
 */
function addColumnProblems(db: SyncDb, op: Extract<SchemaOp, { type: 'add_column' }>, quote: Dialect['quote']): string[] {
  const c = op.column
  if (!c.notNull || c.default !== null || c.autoIncrement) return []
  const hasRows = db.prepare(`SELECT 1 FROM ${quote(op.table)} LIMIT 1`).all().length > 0
  return hasRows ? [`${op.table}.${c.name}: new NOT NULL column has no default and the table already has rows`] : []
}

/**
 * A new standalone UNIQUE index (e.g. flipping an existing populated column to `unique: true`) aborts if
 * current rows already hold duplicate non-null values. Same duplicate probe `rebuildProblems` runs, but
 * for a `create_index` op against the live table. Skip when an index column isn't live yet (it arrives
 * via a rename that runs first) rather than probe a missing column and abort with `no such column`.
 */
function createIndexProblems(db: SyncDb, op: Extract<SchemaOp, { type: 'create_index' }>, quote: Dialect['quote']): string[] {
  const idx = op.index
  if (!idx.unique) return []
  const liveCols = new Set((db.pragma(`table_info("${idx.table.replace(/"/g, '""')}")`) as { name: string }[]).map((r) => r.name))
  if (!idx.columns.every((c) => liveCols.has(c))) return []
  const cols = idx.columns.map(quote).join(', ')
  const notNull = idx.columns.map((c) => `${quote(c)} IS NOT NULL`).join(' AND ')
  const partial = idx.where ? ` AND (${idx.where})` : ''
  const dup = db.prepare(`SELECT 1 FROM ${quote(idx.table)} WHERE ${notNull}${partial} GROUP BY ${cols} HAVING COUNT(*) > 1 LIMIT 1`).all().length > 0
  return dup ? [`${idx.table}.(${idx.columns.join(', ')}): UNIQUE index "${idx.name}" has duplicate values in existing rows`] : []
}

/** Compute the ops needed to bring `db` to `desired` WITHOUT applying them — the dry-run / `--check`
 * @public
 *  source. Reads the live schema through `dialect.introspect` (defaults to SQLite). */
export function planOps(db: SyncDb, desired: SchemaSnapshot, dialect: Dialect = sqlite): SchemaOp[] {
  return diffSchema(desired, dialect.introspect(db))
}

/** @public */
export interface SyncOptions {
  /** Apply `rebuild_table` ops (a managed collection's columns were dropped or changed). */
  allowDestructive?: boolean
  /** Table names allowed to be dropped. A `drop_table` applies ONLY if its table is listed here, so an
   *  unmanaged / unrelated table is never dropped just because `allowDestructive` was set. */
  dropTables?: string[]
  /** Restrict this call to ops on these tables (the per-module migration task's ownership-manifest
   *  scoping); omitted applies every pending op, as before. */
  tables?: readonly string[]
}

/** @public */
export interface SyncResult {
  /** DDL statements applied, in order (empty when already in sync). */
  applied: string[]
  /** Destructive ops withheld (not opted into) — the DB was left intact for them. */
  skipped: SchemaOp[]
}

/**
 * Reconcile a live database to `desired` through `dialect` (defaults to SQLite). Additive ops always
 * apply. Destructive ops need an explicit, op-specific opt-in: `rebuild_table` requires
 * `allowDestructive`; `drop_table` requires the table to be named in `dropTables` (a blanket
 * `allowDestructive` never drops tables). Withheld ops are returned in `skipped`. Everything applied runs
 * in one transaction.
 * @public
 */
export function syncSchema(db: SyncDb, desired: SchemaSnapshot, opts: SyncOptions = {}, dialect: Dialect = sqlite): SyncResult {
  const droppable = new Set(opts.dropTables ?? [])
  const allowed = (op: SchemaOp): boolean => {
    if (op.type === 'rebuild_table') return opts.allowDestructive === true
    if (op.type === 'drop_table') return droppable.has(op.name)
    return true
  }
  const ops = planOps(db, desired, dialect)
  const scoped = opts.tables ? ops.filter((op) => opts.tables!.includes(opTable(op))) : ops
  let toApply = scoped.filter(allowed)
  let skipped = scoped.filter((op) => !allowed(op))

  // A `rename_column` queued ahead of a `rebuild_table` is only sound as that rebuild's prologue (diff.ts
  // never re-gates it on the rebuild being applied). If the rebuild was withheld, ship neither half — a
  // bare rename would leave the table renamed but not rebuilt, silently diverging from `desired`.
  const withheldRebuildTables = new Set(skipped.filter((op) => op.type === 'rebuild_table').map((op) => op.table.name))
  if (withheldRebuildTables.size) {
    const demoted = toApply.filter((op) => op.type === 'rename_column' && withheldRebuildTables.has(op.table))
    if (demoted.length) {
      toApply = toApply.filter((op) => !demoted.includes(op))
      skipped = [...skipped, ...demoted]
    }
  }

  // Validate feasibility BEFORE opening the transaction, so an impossible migration fails loud and
  // changes nothing (rather than aborting the transaction with an opaque constraint error). Every
  // apply-time-fatal op is pre-flighted: rebuilds, plus the purely-additive add_column(NOT NULL, no
  // default) on a populated table and create_index(UNIQUE) over existing duplicates.
  // Plain renames (`ALTER TABLE … RENAME COLUMN`) run BEFORE the rebuilds, so a rebuild's carried column
  // may be probed under its OLD live name — build a PER-TABLE new→old map so the NOT NULL feasibility check
  // can. Keyed by table: two tables renaming a different column to the SAME new name must not collide.
  const renames = new Map<string, string>() // `${table} ${to}` → from
  for (const op of toApply) if (op.type === 'rename_column') renames.set(`${op.table} ${op.to}`, op.from)
  const problems = toApply.flatMap((op) =>
    op.type === 'rebuild_table' ? rebuildProblems(db, op, dialect.quote, renames)
    : op.type === 'add_column' ? addColumnProblems(db, op, dialect.quote)
    : op.type === 'create_index' ? createIndexProblems(db, op, dialect.quote)
    : [])
  if (problems.length) {
    throw new Error(`kestrel: schema migration is infeasible — fix the collection or its data, then retry:\n  - ${problems.join('\n  - ')}`)
  }

  const applied = dialect.render(toApply)
  if (applied.length) {
    db.transaction(() => {
      for (const sql of applied) db.exec(sql)
    })()
  }
  return { applied, skipped }
}
