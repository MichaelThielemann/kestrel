import { META_FILTER_KIND, fieldFilterKind } from '@kestrel/core/client'
import type { FilterKind } from '@kestrel/core/client'
import type { SerializedCollection, SerializedField } from '@kestrel/core'
import { jsKey } from './field-keys'

export type ListColumnType = 'meta' | 'field' | 'translations' | 'deadRefs'

export interface ListColumn {
  /** The wire/row key: used to read `row[key]` and as the sort/filter field. The translations column
   *  uses the server sidecar key `$translations`, which is never sent as a sort/filter (not a real column). */
  key: string
  type: ListColumnType
  /** Field display name (only for `type:'field'`) — used directly as the column label. */
  name?: string
  /** i18n key for the column label (meta + translations columns). */
  labelKey?: string
  field?: SerializedField
  sortable: boolean
  filterable: boolean
  /** The column's filter kind (present iff `filterable`) — drives the operator set + typed value control. */
  filterKind?: FilterKind
}

/** The sidecar key the server attaches per row for translation status (mirrors `$media`). */
export const TRANSLATIONS_KEY = '$translations'

/** The sidecar key the server attaches per row when any reference it holds points at a dead/unpublished
 *  target (the derived stale-reference warning). Like `$translations`, never a real sort/filter column. */
export const DEAD_REFS_KEY = '$hasDeadRefs'

/** Whether a collection holds any field/block that can reference another record — gates the dead-reference
 *  column (mirrors the server's `collectionMayReference`, over the serialized schema). */
export function hasReferenceFields(schema: SerializedCollection): boolean {
  if (schema.blocks.enabled) return true
  if (schema.seo) return true // the `seo` system column carries a media ref (the social image)
  return Object.values(schema.fields).some(fieldMayReference)
}
function fieldMayReference(field: SerializedField): boolean {
  switch (field.type) {
    case 'relation':
    case 'media':
    case 'link':
    case 'richtext':
      return true
    case 'repeater':
      return Object.values((field.options?.fields ?? {}) as Record<string, SerializedField>).some(fieldMayReference)
    default:
      return false
  }
}

const META_LABEL: Record<string, string> = {
  id: 'list.col.id',
  path: 'list.col.slug',
  status: 'list.col.status',
  createdAt: 'list.col.createdAt',
  updatedAt: 'list.col.updatedAt',
}

/** Whether a field can be meaningfully SORTED as a single scalar DB column. JSON-backed fields
 *  (richtext/json/repeater/link, multi-value choice/relation/media) cannot. (Filterability is a separate,
 *  richer question — see `fieldFilterKind`: richtext and the multi-value fields ARE filterable, via
 *  substring / JSON-array membership, even though they are not sortable.) */
function isSortableField(f: SerializedField): boolean {
  switch (f.type) {
    case 'richtext':
    case 'json':
    case 'repeater':
    case 'link':
      return false
    case 'choice':
      return !f.options?.multiple
    case 'relation':
    case 'media':
      return !!f.single
    default:
      return true // text, number, boolean, datetime
  }
}

/** Whether a field column is shown by default — only plain scalar display types. Heavier/structured fields
 *  (richtext, json, repeater, link, relation, media, multi-choice) are available but off by default. */
function isDefaultFieldColumn(f: SerializedField): boolean {
  switch (f.type) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'datetime':
      return true
    case 'choice':
      return !f.options?.multiple
    default:
      return false
  }
}

/** A meta/system column, filterable iff it has a FilterKind (id/path/status/timestamps all do). */
function metaColumn(key: string): ListColumn {
  const filterKind = META_FILTER_KIND[key]
  return { key, type: 'meta', labelKey: META_LABEL[key], sortable: true, filterable: !!filterKind, ...(filterKind ? { filterKind } : {}) }
}

/** Every column a collection list can offer, in display order: id · fields · slug · status · timestamps ·
 *  translations. The user picks which are visible (see `defaultVisibleKeys` / `resolveVisibleColumns`). */
export function availableColumns(schema: SerializedCollection): ListColumn[] {
  const cols: ListColumn[] = [metaColumn('id')]
  for (const [name, field] of Object.entries(schema.fields)) {
    const filterKind = fieldFilterKind(field)
    cols.push({ key: jsKey(name, field), type: 'field', name, field, sortable: isSortableField(field), filterable: filterKind !== null, ...(filterKind ? { filterKind } : {}) })
  }
  if (schema.pageLike) cols.push(metaColumn('path'))
  if (schema.status) cols.push(metaColumn('status'))
  cols.push(metaColumn('createdAt'))
  cols.push(metaColumn('updatedAt'))
  if (schema.translatable && schema.mode === 'multi') {
    cols.push({ key: TRANSLATIONS_KEY, type: 'translations', labelKey: 'list.translations', sortable: false, filterable: false })
  }
  // A compact warning column (a triangle on rows holding a stale reference) — only where refs are possible.
  if (hasReferenceFields(schema)) {
    cols.push({ key: DEAD_REFS_KEY, type: 'deadRefs', labelKey: 'list.deadRefs', sortable: false, filterable: false })
  }
  return cols
}

/** The default visible set: everything except `id` and the heavier field types — i.e. the scalar fields
 *  plus slug, status, timestamps and translations. */
export function defaultVisibleKeys(schema: SerializedCollection): string[] {
  return availableColumns(schema)
    .filter((c) => {
      if (c.key === 'id') return false
      if (c.type === 'field') return isDefaultFieldColumn(c.field!)
      return true
    })
    .map((c) => c.key)
}

/** Project the requested keys onto the available columns: preserves the canonical column order and silently
 *  drops keys that no longer exist (e.g. a removed field still listed in a saved preference). */
export function resolveVisibleColumns(available: ListColumn[], keys: string[]): ListColumn[] {
  const wanted = new Set(keys)
  return available.filter((c) => wanted.has(c.key))
}
