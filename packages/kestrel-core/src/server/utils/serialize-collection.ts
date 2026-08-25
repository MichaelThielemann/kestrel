import type { SerializedAction } from './collection-actions.js'
import { fieldIs, isSingleRefColumn, resolveFieldLayout } from '@kestrel/core'
import type { CollectionDef, Condition, FieldDef, FieldType, LayoutNode, Localized } from '@kestrel/core'
/** The wire shape of a `FieldDef` after `serializeField` — what the admin client actually receives.
 *  Server-only concerns (`populate`, `renamedFrom`) are stripped; everything left is JSON-safe by
 * @public
 *  construction. */
export interface SerializedField {
  type: FieldType
  required: boolean
  unique: boolean
  /** Optional (localized) editor label; the admin falls back to the humanized field key when absent. */
  label?: Localized
  /** True when stored as a single `<name>Id` FK column (single relation/media). The editor reads this
   *  to derive the wire/column key instead of re-deriving the rule. Omitted (falsy) for normal fields. */
  single?: boolean
  options?: Record<string, unknown>
  relation?: { collection: string; many: boolean; labelField?: string }
  default?: unknown
  /** Visibility logic (see `Condition`). Crosses to the admin so the editor can hide the field; it is
   *  JSON-safe by construction, so it passes the wire (and the `asFieldDef` cast) unchanged. */
  condition?: Condition
}

/** The wire shape of a `CollectionDef` after `serializeCollection` — what `/api/collections` sends the
 *  admin client. Every optional flag on `CollectionDef` is resolved to its default here, so the client
 * @public
 *  never re-derives one. */
export interface SerializedCollection {
  name: string
  mode: 'multi' | 'single'
  translatable: boolean
  pageLike: boolean
  seo: boolean
  status: boolean
  blocks: { enabled: boolean; allowed?: string[] }
  /** The admin editor body to render — resolved once here so the client just reads it. Defaults from the
   *  `blocks` flag (`'blocks'` / `'fields'`); an explicit `def.editor` (incl. extension types) wins. */
  editor: string
  /** Whether the collection appears in the admin rail (default true; `false` = system/config store). */
  nav: boolean
  label?: { singular?: Localized; plural?: Localized; new?: Localized }
  icon?: string
  fields: Record<string, SerializedField>
  /** Normalized admin editor layout (rows / named groups). Resolved once here; absent when the author
   *  gave none (the admin then renders one field per row). Plain JSON — crosses the wire untouched. */
  fieldLayout?: LayoutNode[]
  /** Admin actions this collection offers beyond the always-present CRUD (`buildCollectionActions`). Passed
   *  in by the caller rather than derived here, so this function stays a pure def → wire mapping, testable
   *  without a live pipeline registry. Optional on the type (absent ≡ `[]`) so an older hand-built fixture
   *  in a test still satisfies the shape; the real endpoints always send it. */
  actions?: SerializedAction[]
}

// A field `default` is typed `unknown`; it crosses the HTTP/JSON boundary verbatim, so anything
// that is not plain JSON (Date, Map, Set, function, NaN, class instance, …) would silently mismatch
// or throw on serialize. Keep only values that survive JSON unchanged.
function isJsonSafe(value: unknown): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object': {
      if (Array.isArray(value)) return value.every(isJsonSafe)
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) return false
      return Object.values(value as Record<string, unknown>).every(isJsonSafe)
    }
    default:
      return false
  }
}

/** Maps one `FieldDef` to its wire shape. Drops any `default`/`options` value that is not JSON-safe (a
 *  Date, Map, Set, function, NaN, class instance, …) rather than letting it throw or silently corrupt the
 * @public
 *  response — see `isJsonSafe`. */
export function serializeField(field: FieldDef): SerializedField {
  const out: SerializedField = {
    type: field.type,
    required: field.required ?? false,
    unique: field.unique ?? false,
  }
  if (isSingleRefColumn(field)) out.single = true
  if (field.label) out.label = field.label
  if ('default' in field && isJsonSafe(field.default)) {
    out.default = field.default
  }
  // Top-level (never inside `options`, which relations don't set and repeaters overwrite). One copy
  // here flows to collection fields, repeater sub-fields (the recursion below), and serializeBlock.
  if (field.condition) out.condition = field.condition
  if (fieldIs(field, 'relation')) {
    out.relation = {
      collection: field.relation.collection,
      many: field.relation.many ?? false,
      ...(field.relation.labelField ? { labelField: field.relation.labelField } : {}),
    }
  } else if (fieldIs(field, 'repeater')) {
    out.options = {
      fields: serializeFields(field.options.fields),
      ...(field.options.fieldLayout
        ? { fieldLayout: resolveFieldLayout(field.options.fieldLayout, Object.keys(field.options.fields), 'repeater') }
        : {}),
    }
  } else if ('options' in field && field.options && isJsonSafe(field.options)) {
    // Gate options through the same JSON-safety guard as `default`: a custom defineFieldType config carrying a
    // Date/function/Map/NaN would otherwise throw (or silently corrupt) the whole /api/collections response.
    out.options = field.options as Record<string, unknown>
  }
  return out
}

/** Maps every field in a `fields` record through `serializeField`, keeping the keys.
 * @public
 */
export function serializeFields(fields: Record<string, FieldDef>): Record<string, SerializedField> {
  const out: Record<string, SerializedField> = {}
  for (const [key, def] of Object.entries(fields)) out[key] = serializeField(def)
  return out
}

/**
 * Maps a `CollectionDef` to its wire shape. `actions` is passed in by the caller rather than derived here,
 * so this stays a pure def → wire mapping, testable without a live pipeline registry.
 *
 * @example
 * ```ts
 * serializeCollection(postsCollectionDef, buildCollectionActions(postsCollectionDef))
 * ```
 * @public
 */
export function serializeCollection(def: CollectionDef, actions: SerializedAction[] = []): SerializedCollection {
  return {
    actions,
    name: def.name,
    mode: def.mode,
    translatable: def.translatable ?? false,
    pageLike: def.pageLike ?? false,
    seo: def.seo ?? false,
    status: def.status ?? false,
    blocks: { enabled: def.blocks?.enabled ?? false, ...(def.blocks?.allowed ? { allowed: def.blocks.allowed } : {}) },
    editor: def.editor ?? (def.blocks?.enabled ? 'blocks' : 'fields'),
    nav: def.nav !== false,
    ...(def.label ? { label: def.label } : {}),
    ...(def.icon ? { icon: def.icon } : {}),
    fields: serializeFields(def.fields),
    ...(def.fieldLayout
      ? { fieldLayout: resolveFieldLayout(def.fieldLayout, Object.keys(def.fields), `collection "${def.name}"`) }
      : {}),
  }
}

/** The wire shape of a block definition after `serializeBlock` — a `defineBlock` SFC's fields, serialized
 * @public
 *  the same way a collection's are. */
export interface SerializedBlock {
  name: string
  label?: Localized
  slots?: string[]
  /** Icon name for the admin block picker (from the SFC's `defineBlock({ icon })`). */
  icon?: string
  /** Preview image (URL/path) shown above the name in the admin block picker (from `defineBlock({ image })`). */
  image?: string
  fields: Record<string, SerializedField>
}

/** Maps a block definition to its wire shape. Structurally typed (not importing `BlockDef`) so `core` stays
 *  independent of the `fields` layer; block fields serialize identically to collection fields, so the admin
 * @public
 *  `FieldRenderer` reuses them as-is. */
export function serializeBlock(def: { name: string; label?: Localized; slots?: string[]; icon?: string; image?: string; fields: Record<string, FieldDef> }): SerializedBlock {
  return {
    name: def.name,
    ...(def.label ? { label: def.label } : {}),
    ...(def.slots?.length ? { slots: def.slots } : {}),
    ...(def.icon ? { icon: def.icon } : {}),
    ...(def.image ? { image: def.image } : {}),
    fields: serializeFields(def.fields),
  }
}
