import type { ColumnShape, IndexShape, TableShape, SchemaOp } from './model'

// SQLite dialect renderer: structured ops → DDL strings. Kept separate from `diffSchema` (which is
// dialect-agnostic) so a future Postgres renderer can sit behind the same op interface (ADR-0002).

const q = (id: string) => `\`${id.replace(/`/g, '``')}\``
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * A column definition, shared by CREATE TABLE and ALTER TABLE ADD COLUMN. Clause order matches the
 * committed drizzle-kit migrations: `<type> [PRIMARY KEY [AUTOINCREMENT]] [DEFAULT <x>] [NOT NULL]`.
 * (SQLite rejects a NOT-NULL ADD COLUMN without a default on a non-empty table — that guard belongs to
 * the apply/validation layer, not here.)
 */
function columnClause(c: ColumnShape): string {
  let s = `${q(c.name)} ${c.type}`
  if (c.primaryKey) s += c.autoIncrement ? ' PRIMARY KEY AUTOINCREMENT' : ' PRIMARY KEY'
  if (c.default !== null) s += ` DEFAULT ${c.default}`
  if (c.notNull) s += ' NOT NULL'
  return s
}

// Indexes are emitted as separate create_index ops, so CREATE TABLE renders columns only.
function createTableSql(name: string, columns: ColumnShape[]): string {
  const cols = columns.map((c) => `  ${columnClause(c)}`).join(',\n')
  return `CREATE TABLE ${q(name)} (\n${cols}\n);`
}

/**
 * SQLite has no ALTER COLUMN / safe DROP COLUMN, so a destructive column change is a table rebuild:
 * create a new table at the desired shape, copy the surviving columns' data, drop the old, rename the
 * new into place, then recreate the indexes. (No foreign keys exist in this schema, so the usual
 * `PRAGMA foreign_keys` dance is unnecessary.)
 */
/** SELECT source for a copied column: itself, or a single↔multiple shape transform of a differently-named source. */
function copySource(col: string, transforms?: Record<string, { from: string; type: 'wrap' | 'unwrap' }>): string {
  const t = transforms?.[col]
  if (!t) return q(col)
  return t.type === 'wrap'
    ? `CASE WHEN ${q(t.from)} IS NULL THEN '[]' ELSE json_array(${q(t.from)}) END`
    : `json_extract(${q(t.from)}, '$[0]')`
}

function rebuildTable(table: TableShape, copy: string[], transforms?: Record<string, { from: string; type: 'wrap' | 'unwrap' }>): string[] {
  const tmp = `__kestrel_new_${table.name}`
  // `DROP TABLE IF EXISTS` first so an orphan temp from an interrupted earlier rebuild self-heals
  // instead of colliding on CREATE and wedging the migration.
  const stmts = [`DROP TABLE IF EXISTS ${q(tmp)};`, createTableSql(tmp, table.columns)]
  if (copy.length) {
    const into = copy.map(q).join(', ')
    const select = copy.map((c) => copySource(c, transforms)).join(', ')
    stmts.push(`INSERT INTO ${q(tmp)} (${into}) SELECT ${select} FROM ${q(table.name)};`)
  }
  // Preserve the AUTOINCREMENT high-water mark across the rebuild so ids are never reused (a reused id
  // could silently repoint a stale internal-link / relation reference). `sqlite_sequence` has no UNIQUE
  // on `name`, so INSERT-OR-REPLACE won't work — ensure the temp row exists, then bump it to the old
  // table's mark. Must run while the old table's seq row still exists (before its DROP); the RENAME then
  // carries the row's name across.
  if (table.columns.some((c) => c.autoIncrement)) {
    stmts.push(`INSERT INTO sqlite_sequence (name, seq) SELECT ${lit(tmp)}, 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ${lit(tmp)});`)
    stmts.push(`UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = ${lit(table.name)}), 0)) WHERE name = ${lit(tmp)};`)
  }
  stmts.push(`DROP TABLE ${q(table.name)};`)
  stmts.push(`ALTER TABLE ${q(tmp)} RENAME TO ${q(table.name)};`)
  for (const index of table.indexes) stmts.push(createIndex(index))
  return stmts
}

function createIndex(i: IndexShape): string {
  const unique = i.unique ? 'UNIQUE ' : ''
  const cols = i.columns.map(q).join(',')
  const where = i.where ? ` WHERE ${i.where}` : ''
  return `CREATE ${unique}INDEX ${q(i.name)} ON ${q(i.table)} (${cols})${where};`
}

/** Render structured ops into SQLite DDL, preserving order. Most ops are one statement; a rebuild is several. */
export function renderSqlite(ops: SchemaOp[]): string[] {
  return ops.flatMap((op): string[] => {
    switch (op.type) {
      case 'create_table': return [createTableSql(op.table.name, op.table.columns)]
      case 'add_column': return [`ALTER TABLE ${q(op.table)} ADD COLUMN ${columnClause(op.column)};`]
      case 'create_index': return [createIndex(op.index)]
      case 'drop_index': return [`DROP INDEX IF EXISTS ${q(op.index.name)};`]
      case 'rename_column': return [`ALTER TABLE ${q(op.table)} RENAME COLUMN ${q(op.from)} TO ${q(op.to)};`]
      case 'drop_table': return [`DROP TABLE ${q(op.name)};`]
      case 'rebuild_table': return rebuildTable(op.table, op.copy, op.transforms)
    }
  })
}
