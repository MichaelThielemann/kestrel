import type { SchemaSnapshot, SchemaOp, IndexShape, ColumnShape } from './model'

/** Two indexes are equivalent when uniqueness, partial predicate, and ordered columns all match. */
function sameIndex(a: IndexShape, b: IndexShape): boolean {
  return a.unique === b.unique
    && a.where === b.where
    && a.columns.length === b.columns.length
    && a.columns.every((c, i) => c === b.columns[i])
}

/** A column's definition drifted (same name, different shape) — only fixable by a table rebuild in SQLite. */
function columnDiffers(a: ColumnShape, b: ColumnShape): boolean {
  return a.type !== b.type || a.notNull !== b.notNull || a.primaryKey !== b.primaryKey
    || a.autoIncrement !== b.autoIncrement || a.default !== b.default
}

/**
 * Schema diff (ADR-0002). Additive changes (create table/column/index, drop_index) are always emitted.
 * Destructive changes are emitted too but kept distinct: a table only in `actual` becomes `drop_table`;
 * a table whose columns were dropped or whose definitions drifted becomes a `rebuild_table` (SQLite has
 * no in-place ALTER COLUMN). A table needing a rebuild takes the rebuild path WHOLE — its added columns
 * and indexes are recreated by the rebuild, not emitted separately.
 *
 * Returned in an apply-safe order: additive first (create_table → add_column → drop_index →
 * create_index), destructive last (rebuild_table → drop_table). The additive/destructive split lets the
 * apply layer gate destructive ops behind an explicit opt-in (see `isDestructive`).
 */
export function diffSchema(desired: SchemaSnapshot, actual: SchemaSnapshot): SchemaOp[] {
  const createTables: SchemaOp[] = []
  const renames: SchemaOp[] = []
  const addColumns: SchemaOp[] = []
  const dropIndexes: SchemaOp[] = []
  const createIndexes: SchemaOp[] = []
  const rebuilds: SchemaOp[] = []
  const dropTables: SchemaOp[] = []

  for (const name of Object.keys(desired)) {
    const want = desired[name]
    const have = actual[name]

    if (!have) {
      createTables.push({ type: 'create_table', table: want })
      for (const index of want.indexes) createIndexes.push({ type: 'create_index', index })
      continue
    }

    const haveByName = new Map(have.columns.map((c) => [c.name, c]))
    const wantNames = new Set(want.columns.map((c) => c.name))

    // Resolve renames: a desired column whose `renamedFrom` exists in actual while its own name does not.
    // `rename_column` is additive and ordered before any rebuild, so the rest of the diff can treat the
    // column as already present under its NEW name (the "effective" actual view).
    const renameMap = new Map<string, string>() // newName -> oldName
    const transformMap = new Map<string, { from: string; type: 'wrap' | 'unwrap' }>() // single↔multiple toggles
    for (const c of want.columns) {
      if (c.renamedFrom && haveByName.has(c.renamedFrom) && !haveByName.has(c.name)) {
        renameMap.set(c.name, c.renamedFrom)
        if (c.renameTransform) transformMap.set(c.name, { from: c.renamedFrom, type: c.renameTransform })
      }
    }
    const renamedOld = new Set(renameMap.values())
    // A name vacated by a rename (renamedOld) reads as absent unless something else renamed INTO it —
    // otherwise a field re-using a just-freed name is mistaken for the column that just moved away.
    const effectiveHas = (n: string) => (haveByName.has(n) && !renamedOld.has(n)) || renameMap.has(n)
    const actualColOf = (n: string) => (renameMap.has(n) || !renamedOld.has(n)) ? haveByName.get(renameMap.get(n) ?? n) : undefined

    const dropped = have.columns.some((c) => !wantNames.has(c.name) && !renamedOld.has(c.name))
    const changed = want.columns.some((c) => { const a = actualColOf(c.name); return a !== undefined && columnDiffers(a, c) })

    // Plain renames are an in-place ALTER RENAME; a single↔multiple toggle reshapes the data, so it is
    // handled by the rebuild's transformed copy below (NO rename_column for those).
    for (const [to, from] of renameMap) {
      if (!transformMap.has(to)) renames.push({ type: 'rename_column', table: name, from, to })
    }

    if (dropped || changed || transformMap.size > 0) {
      // Rebuild recreates the table at `want`, copying columns present in both (by effective/new name —
      // plain renames already ran). A toggled column is copied from its old, differently-named source via
      // a shape transform. Columns dropped without a rename hint are not copied: the data loss line.
      const copy = want.columns.filter((c) => effectiveHas(c.name)).map((c) => c.name)
      const transforms = Object.fromEntries(copy.filter((c) => transformMap.has(c)).map((c) => [c, transformMap.get(c)!]))
      rebuilds.push({ type: 'rebuild_table', table: want, copy, ...(Object.keys(transforms).length ? { transforms } : {}) })
      continue
    }

    // Purely additive for this table (renames already queued above).
    for (const column of want.columns) {
      if (!effectiveHas(column.name)) addColumns.push({ type: 'add_column', table: name, column })
    }
    const haveIdx = new Map(have.indexes.map((i) => [i.name, i]))
    const wantIdx = new Map(want.indexes.map((i) => [i.name, i]))
    for (const index of want.indexes) {
      const existing = haveIdx.get(index.name)
      if (!existing) { createIndexes.push({ type: 'create_index', index }); continue }
      if (!sameIndex(existing, index)) {
        dropIndexes.push({ type: 'drop_index', index: existing })
        createIndexes.push({ type: 'create_index', index })
      }
    }
    for (const index of have.indexes) {
      if (!wantIdx.has(index.name)) dropIndexes.push({ type: 'drop_index', index })
    }
  }

  for (const name of Object.keys(actual)) {
    if (!desired[name]) dropTables.push({ type: 'drop_table', name })
  }

  return [...createTables, ...renames, ...addColumns, ...dropIndexes, ...createIndexes, ...rebuilds, ...dropTables]
}
