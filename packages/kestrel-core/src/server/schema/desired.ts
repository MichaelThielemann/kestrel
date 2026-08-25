import { getTableConfig, SQLiteSyncDialect, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { SQL, is } from 'drizzle-orm'
import { fieldIs, resolveColumnName } from '@kestrel/core'
import { toSnakeCase } from '../utils/naming.js'
import type { CollectionDef } from '@kestrel/core'
import type { ColumnShape, IndexShape, TableShape, SchemaSnapshot } from './model.js'

// Build the *desired* schema snapshot from the Drizzle tables that collections compile to (the
// counterpart to introspect's *actual* snapshot). Reads drizzle's table metadata via getTableConfig and
// normalizes it into the same model `diffSchema` consumes (ADR-0002).

const dialect = new SQLiteSyncDialect()
const sqlText = (value: SQL) => dialect.sqlToQuery(value).sql

/** Map a Drizzle column default to its raw DDL token: a `sql` template-tag default renders verbatim, a JS
 *  literal is quoted.
 * @public
 */
export function defaultToken(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (is(value, SQL)) return sqlText(value)
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  if (typeof value === 'boolean') return value ? '1' : '0'
  // Object / array default (a json-backed column — e.g. a custom field type): emit a quoted JSON string
  // literal, matching how json/repeater columns default via sql`'{}'`. Else String({}) → "[object Object]".
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`
  return String(value)
}

/** @public */
export function desiredTable(table: SQLiteTable, def?: CollectionDef): TableShape {
  const cfg = getTableConfig(table)

  // new column name -> old column name (and any single↔multiple shape transform). Two sources:
  //  - an explicit `renamedFrom` field hint (same field type → same naming rule for both keys);
  //  - a relation/media field, which maps to its opposite-multiplicity column name (`<col>` ↔ `<col>_id`)
  //    so toggling `multiple`/`many` renames + reshapes the data instead of dropping it. Inert unless the
  //    opposite column actually exists in the live DB.
  const renames = new Map<string, string>()
  const transforms = new Map<string, 'wrap' | 'unwrap'>()
  if (def) {
    for (const [key, field] of Object.entries(def.fields)) {
      if (field.renamedFrom) {
        renames.set(resolveColumnName(key, field).dbName, resolveColumnName(field.renamedFrom, field).dbName)
        continue
      }
      if (fieldIs(field, 'media') || fieldIs(field, 'relation')) {
        const multiple = fieldIs(field, 'media') ? field.options?.multiple === true : field.relation.many === true
        const base = toSnakeCase(key)
        const col = multiple ? base : `${base}_id`
        renames.set(col, multiple ? `${base}_id` : base)
        transforms.set(col, multiple ? 'wrap' : 'unwrap')
      }
    }
  }

  const columns: ColumnShape[] = cfg.columns.map((c) => ({
    name: c.name,
    type: c.getSQLType(),
    notNull: c.notNull,
    primaryKey: c.primary,
    autoIncrement: (c as unknown as { autoIncrement?: boolean }).autoIncrement === true,
    default: defaultToken(c.default),
    ...(renames.has(c.name) ? { renamedFrom: renames.get(c.name) } : {}),
    ...(transforms.has(c.name) ? { renameTransform: transforms.get(c.name) } : {}),
  }))

  const indexes: IndexShape[] = cfg.indexes.map((i) => {
    const cfgI = i.config as unknown as { name: string; unique: boolean; columns: { name: string }[]; where?: SQL }
    return {
      name: cfgI.name,
      table: cfg.name,
      columns: cfgI.columns.map((x) => x.name),
      unique: cfgI.unique,
      where: cfgI.where ? sqlText(cfgI.where) : null,
    }
  })

  // A column-level `.unique()` is materialized by drizzle-kit as a named unique index
  // (`<table>_<column>_unique`) — surface it the same way so introspect's view and ours agree.
  for (const c of cfg.columns) {
    const u = c as unknown as { isUnique?: boolean; uniqueName?: string }
    if (u.isUnique) {
      indexes.push({ name: u.uniqueName ?? `${cfg.name}_${c.name}_unique`, table: cfg.name, columns: [c.name], unique: true, where: null })
    }
  }

  return { name: cfg.name, columns, indexes }
}

/**
 * Build a full desired snapshot from a set of Drizzle tables (registered collections + standalone tables).
 * `defsByName` supplies each collection's def so `renamedFrom` field hints become column renames; tables
 * without a def (e.g. `folders`) simply carry no renames.
 * @public
 */
export function desiredSchema(tables: SQLiteTable[], defsByName?: Map<string, CollectionDef>): SchemaSnapshot {
  const snapshot: SchemaSnapshot = {}
  for (const table of tables) {
    const shape = desiredTable(table, defsByName?.get(getTableConfig(table).name))
    snapshot[shape.name] = shape
  }
  return snapshot
}
