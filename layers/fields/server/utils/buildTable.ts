import { sqliteTable, integer, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import type { SQLiteColumnBuilderBase, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { Block } from '../../../core/server/utils/blocks'
import type { SeoMeta } from '../../../core/server/utils/seo'
import type { CollectionDef } from '../../../core/server/utils/defineCollection'
import { getFieldType, fieldCanEnforceUnique } from '../field-registry'
import { resolveColumnName } from '../field-registry/naming'

/** The system columns this def actually emits (jsKey + DB-name forms), gated by the SAME flags that add
 *  them in `buildTable` — so a field may only use e.g. `content`/`status` on a collection that doesn't
 *  enable blocks/status. A field resolving to one of these would silently overwrite a system column. */
function reservedColumns(def: CollectionDef): { js: Set<string>; db: Set<string> } {
  const js = new Set(['id', 'createdAt', 'updatedAt'])
  const db = new Set(['id', 'created_at', 'updated_at'])
  const add = (j: string, d: string) => { js.add(j); db.add(d) }
  if (def.translatable) add('locale', 'locale')
  if (def.mode === 'single') add('singletonKey', 'singleton_key')
  else if (def.translatable) add('translationGroup', 'translation_group')
  if (def.pageLike) { add('path', 'path'); add('layout', 'layout') }
  if (def.status) add('status', 'status')
  if (def.seo) add('seo', 'seo')
  if (def.blocks?.enabled) add('content', 'content')
  return { js, db }
}

function buildIndexes(def: CollectionDef, t: Record<string, never>) {
  const out = []
  const names = new Set<string>()
  // System indexes are named first, so a colliding field index (below) is the one that fails loud —
  // the fixed system naming scheme can't be the thing that has to change.
  const system = (name: string) => { names.add(name); return name }
  if (def.mode === 'single') {
    out.push(def.translatable
      ? uniqueIndex(system(`${def.name}_key_locale`)).on(t.singletonKey, t.locale)
      : uniqueIndex(system(`${def.name}_key`)).on(t.singletonKey))
  } else if (def.translatable) {
    out.push(uniqueIndex(system(`${def.name}_group_locale`)).on(t.translationGroup, t.locale))
    out.push(index(system(`${def.name}_group`)).on(t.translationGroup))
  }
  if (def.pageLike) {
    out.push(def.translatable
      ? uniqueIndex(system(`${def.name}_path_locale`)).on(t.path, t.locale).where(sql`path is not null`)
      : uniqueIndex(system(`${def.name}_path`)).on(t.path).where(sql`path is not null`))
  }
  // Opt-in non-unique field indexes (`index: true`) — for columns that are frequently filtered/sorted but
  // not unique (e.g. media.folder). `unique` fields already get an index from the field-type's `.unique()`.
  // A name that collides with a system index (e.g. a field named "key" on a singleton) would otherwise mint
  // TWO indexes of the same name — drizzle-kit's `syncSchema` then throws at DEPLOY time, not authoring
  // time. Fail loud here instead, same style as the reserved-column / duplicate-column guards above.
  for (const [key, field] of Object.entries(def.fields)) {
    if (!field.index || field.unique) continue
    const { jsKey, dbName } = resolveColumnName(key, field)
    const name = `${def.name}_${dbName}`
    if (names.has(name)) {
      throw new Error(`kestrel: collection "${def.name}" field "${key}" produces the index name "${name}", which collides with a system index — rename the field.`)
    }
    names.add(name)
    out.push(index(name).on(t[jsKey as keyof typeof t]))
  }
  return out
}

export function buildTable(def: CollectionDef): SQLiteTable {
  const cols: Record<string, SQLiteColumnBuilderBase> = {}
  cols.id = integer('id').primaryKey({ autoIncrement: true })
  if (def.translatable) cols.locale = text('locale').notNull()
  if (def.mode === 'single') cols.singletonKey = text('singleton_key').notNull()
  else if (def.translatable) cols.translationGroup = text('translation_group').notNull()
  if (def.pageLike) {
    cols.path = text('path')
    // Nullable with no default: an editor's "inherit" must be distinguishable from an explicit `default`,
    // and the render decides the fallback (see resolvePageLayout) so a deleted layout file degrades in one
    // place instead of being frozen into every row.
    cols.layout = text('layout')
  }
  if (def.status) cols.status = text('status').notNull().default('draft')
  if (def.seo) cols.seo = text('seo', { mode: 'json' }).$type<SeoMeta>().notNull().default(sql`'{}'`)
  if (def.blocks?.enabled) cols.content = text('content', { mode: 'json' }).$type<Block[]>().notNull().default(sql`'[]'`)

  const reserved = reservedColumns(def)
  const seenJsKeys = new Set<string>()
  const seenDbNames = new Set<string>()
  for (const [key, field] of Object.entries(def.fields)) {
    const { jsKey, dbName } = resolveColumnName(key, field)
    // Fail loud (matching defineCollection's pageLike guard) rather than silently overwriting a system
    // column — e.g. a field named `id`/`status` would clobber the PK / publish-gating column — or
    // shadowing a sibling whose resolved key collides (a single-ref `foo` → `fooId` vs a literal `fooId`).
    if (reserved.js.has(jsKey) || reserved.db.has(dbName)) {
      throw new Error(`kestrel: collection "${def.name}" field "${key}" resolves to the reserved system column "${jsKey}" — rename the field.`)
    }
    if (seenJsKeys.has(jsKey) || seenDbNames.has(dbName)) {
      throw new Error(`kestrel: collection "${def.name}" field "${key}" resolves to column "${jsKey}"/"${dbName}", which collides with another field — rename one of them.`)
    }
    // `unique` on a json/array-backed column (multi-choice, multi-media, many-relation, repeater, json) is
    // a silent no-op — the column type never carries a DB constraint for it. Warn rather than throw: the
    // flag is inert, so a definition that boots today must keep booting.
    if (field.unique && !fieldCanEnforceUnique(field)) {
      console.warn(`kestrel: collection "${def.name}" field "${key}" is "unique", but its storage (${field.type}, multi-valued) can never enforce a DB uniqueness constraint — the flag is ignored.`)
    }
    seenJsKeys.add(jsKey)
    seenDbNames.add(dbName)
    cols[jsKey] = getFieldType(field.type).column(dbName, field)
  }

  // `timestamp_ms` (not `timestamp`) keeps MILLISECOND precision: the optimistic-concurrency check compares
  // `updatedAt` exactly, and second-granularity would let two saves in the same wall-clock second share a
  // token — a stale tab could then silently revert a newer save. Same INTEGER column type, so no DDL change.
  cols.createdAt = integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date())
  cols.updatedAt = integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date())

  return sqliteTable(def.name, cols, (t) => buildIndexes(def, t as unknown as Record<string, never>))
}
