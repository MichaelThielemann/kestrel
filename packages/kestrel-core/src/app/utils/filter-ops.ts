import type { SerializedField } from '../../server/utils/serialize-collection.js' // type-only, erased client-side

/**
 * The single shared source of truth for list filtering: which normalized "kind" a field/meta column maps
 * to, and which operators that kind allows. Both the server (validation + predicate building) and the admin
 * UI (operator select + typed value control) import this — so the allowed-operators-per-field-type table is
 * defined exactly once. Kept in `core/app/utils` (the server-and-client shared home) and free of any DB or
 * column-naming detail: each side maps its own column keys.
 */

/** @public */
export type FilterOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'notContains'

/**
 * A field's storage/semantics bucket for filtering. `text`/`richtext` do substring LIKE; `stringSet`/`idSet`
 * are JSON-array membership (multi choice / many relation+media); `ref` is a single FK id (eq/ne only);
 * `enum`/`boolean` are equality-only; `number`/`datetime` support the full comparison set.
 * @public
 */
export type FilterKind = 'number' | 'text' | 'datetime' | 'boolean' | 'enum' | 'ref' | 'richtext' | 'stringSet' | 'idSet'

const CMP = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const

/** @public */
export const OPS_BY_KIND: Record<FilterKind, readonly FilterOp[]> = {
  number: CMP,
  datetime: CMP,
  text: ['eq', 'ne', 'contains'],
  richtext: ['contains'], // `contains` matches the stored HTML SOURCE (searching 'p' can hit a '<p>' tag) —
  //                          a stripped shadow column / FTS index is a later enhancement (documented caveat).
  boolean: ['eq', 'ne'],
  enum: ['eq', 'ne'],
  ref: ['eq', 'ne'], // a single relation/media FK id — lt/gt on an id is meaningless.
  stringSet: ['contains', 'notContains'],
  idSet: ['contains', 'notContains'],
}

/** The operator a column's filter row defaults to in the admin UI. `datetime` defaults to `gte` ("on or
 *  after") — `eq` on a millisecond timestamp practically never matches, so it made the filter useless. The
 *  admin always emits the operator explicitly, so this does NOT change the wire parser's separate
 * @public
 *  absent-operator default (a bare `filter[field]` still parses as `eq`, URLs round-trip unchanged). */
export const DEFAULT_OP: Record<FilterKind, FilterOp> = {
  number: 'eq', datetime: 'gte', text: 'eq', boolean: 'eq', enum: 'eq', ref: 'eq',
  richtext: 'contains', stringSet: 'contains', idSet: 'contains',
}

const ALL_OPS = new Set<string>(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'notContains'])

/** Whether a raw wire token is a known operator at all (parse-time guard → a clean 400 for garbage).
 * @public
 */
export const isFilterOp = (s: string): s is FilterOp => ALL_OPS.has(s)

/** Whether `op` is allowed for a column of this kind (list-time guard → a clean 400, never a 500).
 * @public
 */
export const opAllowed = (kind: FilterKind, op: FilterOp): boolean => OPS_BY_KIND[kind].includes(op)

/**
 * The wire key for a filter clause: `filter[field]` or `filter[field][op]`. `[^\]]+` keeps the field/op
 * tokens bracket-free; the optional second group is the operator (absent → `eq`, so a bare
 * `filter[status]=x` stays backward compatible). Defined ONCE here (the shared client+server home) so the
 * admin URL parser (`parseListQuery`) and the server wire parser (`parseFilter`) use exactly one regex.
 * @public
 */
export const FILTER_RE = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/

/**
 * The FilterKind for a field, or `null` when it is not filterable (link / json / repeater / range-datetime).
 * Unknown consumer types fall back to the conservative `text` (equality + substring on their scalar column).
 * @public
 */
export function fieldFilterKind(f: SerializedField): FilterKind | null {
  switch (f.type) {
    case 'text':
    case 'slug':
      return 'text'
    case 'richtext':
      return 'richtext'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'datetime':
      return f.options?.range ? null : 'datetime'
    case 'choice':
      return f.options?.multiple ? 'stringSet' : 'enum'
    case 'relation':
    case 'media':
      return f.single ? 'ref' : 'idSet'
    case 'link':
    case 'json':
    case 'repeater':
      return null
    default:
      return 'text'
  }
}

/** The FilterKind of each filterable meta/system column (keyed by its wire key).
 * @public
 */
export const META_FILTER_KIND: Record<string, FilterKind> = {
  id: 'number',
  path: 'text',
  status: 'enum',
  createdAt: 'datetime',
  updatedAt: 'datetime',
}
