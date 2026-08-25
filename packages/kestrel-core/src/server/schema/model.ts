// Normalized, dialect-agnostic schema model for the migration engine (ADR-0002). Both sides of a diff
// are expressed in this shape: the *desired* snapshot (built from collection tables via getTableConfig)
// and the *actual* snapshot (introspected from the live DB). `diffSchema` compares them; a dialect
// renderer turns the resulting ops into DDL. SQLite is the first dialect.

/** @public */
export interface ColumnShape {
  name: string
  /** SQLite storage type as it appears in DDL: `integer` | `text` | `real` | `blob`. */
  type: string
  notNull: boolean
  primaryKey: boolean
  autoIncrement: boolean
  /** Raw SQL default token, exactly as it follows `DEFAULT` (e.g. `'draft'`, `0`), or null for none. */
  default: string | null
  /** The column's previous name (from a `renamedFrom` field hint) — the diff renames in place rather
   *  than dropping the old column and losing its data. */
  renamedFrom?: string
  /** A relation/media `single↔multiple` toggle: the column moved between `<col>_id` (scalar) and `<col>`
   *  (json array), so the rename needs a data shape transform. `wrap` = scalar→array, `unwrap` = array→scalar. */
  renameTransform?: 'wrap' | 'unwrap'
}

/** @public */
export interface IndexShape {
  name: string
  table: string
  columns: string[]
  unique: boolean
  /** Partial-index predicate (the text after `WHERE`), or null for a full index. */
  where: string | null
}

/** @public */
export interface TableShape {
  name: string
  columns: ColumnShape[]
  indexes: IndexShape[]
}

/** A whole schema, keyed by table name.
 * @public
 */
export type SchemaSnapshot = Record<string, TableShape>

/**
 * One structured, dialect-agnostic schema change. The first four variants are **additive** (no data
 * loss): create table/column/index, and drop_index (indexes hold no row data, so dropping one is
 * reversible). The last two are **destructive** (see `isDestructive`):
 *  - `drop_table` — a collection was removed.
 *  - `rebuild_table` — a column was dropped or its definition changed; since SQLite has no in-place
 *    ALTER COLUMN, the table is recreated and the surviving columns (`copy`) are carried over.
 * Destructive ops are never auto-applied; they require an explicit opt-in (ADR-0002).
 * @public
 */
export type SchemaOp =
  | { type: 'create_table'; table: TableShape }
  | { type: 'add_column'; table: string; column: ColumnShape }
  | { type: 'create_index'; index: IndexShape }
  | { type: 'drop_index'; index: IndexShape }
  // `rename_column` is additive (data-preserving, `ALTER TABLE … RENAME COLUMN`); it runs before any
  // rebuild, so a rebuilt table sees the column under its new name.
  | { type: 'rename_column'; table: string; from: string; to: string }
  | { type: 'drop_table'; name: string }
  // `transforms` maps a copied column to a shape transform of a differently-named source column (a
  // relation/media single↔multiple toggle); plain copies just use the column's own (new) name.
  | { type: 'rebuild_table'; table: TableShape; copy: string[]; transforms?: Record<string, { from: string; type: 'wrap' | 'unwrap' }> }
