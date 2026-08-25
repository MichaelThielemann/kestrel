import { validateFieldLayoutsDeep } from './field-layout.js'

/** The built-in field type names understood by the field registry, plus any consumer-defined type name
 *  registered via `defineFieldType` (kept open through `(string & {})` so autocomplete still offers the
 * @public
 *  built-ins). */
export type FieldType =
  | 'text' | 'slug' | 'richtext' | 'number' | 'boolean' | 'datetime'
  | 'choice' | 'link' | 'media' | 'relation' | 'repeater' | 'json'
  // Consumer-defined types (registered via `defineFieldType`) — keeps built-in autocomplete while
  // accepting any registered name.
  | (string & {})

/** A display string that may be localized per admin language: either a plain string (one language /
 *  language-agnostic) or a `{ <adminLang>: string }` map resolved against the active admin language
 * @public
 *  (falling back to `en`, then any present value). Works for built-in AND consumer-defined collections. */
export type Localized = string | Record<string, string>

interface BaseFieldDef {
  required?: boolean
  default?: unknown
  unique?: boolean
  /** Add a non-unique DB index on this field's column — for a field frequently FILTERED or SORTED by but
   *  not unique (e.g. `media.folder`). `unique` already implies an index, so this is only the non-unique case. */
  index?: boolean
  /** Editor label, optionally localized per admin language. Defaults to the humanized field key
   *  (e.g. `siteName` → "Site Name") so the editor label matches the collection-list header. */
  label?: Localized
  /** Show this field only when the condition matches other fields' values (see `Condition`). A hidden
   *  field is exempt from `required` and gets a nullable column; its stored value is left as-is (v1). */
  condition?: Condition
  /** The field's previous key. On a schema sync the column is RENAMED (data preserved) instead of being
   *  dropped + re-added. Remove once applied everywhere. */
  renamedFrom?: string
  /** Per-instance read populator override (Pruvious `additional.population`). When set, the field-tree
   *  walker runs THIS instead of the field type's default populator for this one field — e.g. a relation
   *  that should project only a couple of columns, or a masked value. Server-only (a function; never
   *  serialized to the admin). Typed inline (structurally identical to the populate seam's `FieldPopulator`)
   *  so this foundational, import-free types file needs no dependency on `populate.ts`. */
  populate?: (
    bag: Record<string, unknown>,
    key: string,
    field: FieldDef,
    ctx: { depth: number; locale: string; def: CollectionDef },
    keyMode: 'columns' | 'props',
  ) => void
}

/** A leaf value a `Condition` can compare a sibling field's value against.
 * @public
 */
export type ConditionScalar = string | number | boolean | null

/** A single operator test against the referenced field's value. Multiple keys are ANDed.
 * @public
 */
export interface ConditionOperator {
  eq?: ConditionScalar
  ne?: ConditionScalar
  gt?: number | string
  gte?: number | string
  lt?: number | string
  lte?: number | string
  in?: ConditionScalar[]
  notIn?: ConditionScalar[]
  /** Case-sensitive `new RegExp(value).test(dep)`; a non-string dependency never matches. */
  regexp?: string
  /** `true` matches null/undefined/''/[]; `false` matches a present value. */
  empty?: boolean
}

/** A leaf rule: test another field's value. Use `is` (strict-equality shorthand) OR `op`; a bare rule
 * @public
 *  (neither) means "present" (non-empty). `field` is a sibling field's key (v1 scope). */
export interface ConditionRule {
  field: string
  is?: ConditionScalar
  op?: ConditionOperator
}

/** Field visibility logic. A discriminated tree: leaf `ConditionRule`s combined by explicit
 * @public
 *  `and`/`or`/`not` (no overloaded magic keys, so a real field named "and"/"or" never collides). */
export type Condition =
  | ConditionRule
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition }

/** The kind of destination a `link` field's stored `LinkValue` points at.
 * @public
 */
export type LinkType = 'internal' | 'external' | 'email' | 'tel'

/** The stored value of a `link` field: a discriminated union keyed by `type`. `internal` addresses another
 *  record by collection + id (never a raw path, so it survives the target's slug changing); the other three
 * @public
 *  arms hold the destination inline. */
export type LinkValue =
  | { type: 'internal'; collection: string; id: number; hash?: string; label?: string }
  | { type: 'external'; url: string; label?: string }
  | { type: 'email'; email: string; label?: string }
  | { type: 'tel'; tel: string; label?: string }

/** A single field's definition: one arm per built-in `type`, each carrying `BaseFieldDef` plus the options
 *  shape specific to that type, closed off by the open consumer arm (`type: string & {}`) for types
 *  registered via `defineFieldType`. Use `fieldIs` to narrow a `FieldDef` to a specific built-in arm — a
 * @public
 *  bare `field.type === 'x'` check does not narrow because the open arm makes `type` a non-discriminant. */
export type FieldDef =
  | (BaseFieldDef & { type: 'text'; options?: { minLength?: number; maxLength?: number; multiline?: boolean } })
  // A url-safe slug (text-backed). `from` = the field key to auto-generate from when left blank; `prefix` is
  // display-only in the editor widget (e.g. '/galleries/').
  | (BaseFieldDef & { type: 'slug'; options?: { from?: string; prefix?: string } })
  | (BaseFieldDef & { type: 'richtext' })
  // `unit` is a display-only suffix shown after the value in the editor widget (e.g. 'rem'); the stored
  // value stays a bare number. `units` is reserved for a future selectable-unit variant and is not yet
  // honoured server-side.
  | (BaseFieldDef & { type: 'number'; options?: { min?: number; max?: number; integer?: boolean; decimals?: number; unit?: string; units?: string[] } })
  | (BaseFieldDef & { type: 'boolean' })
  | (BaseFieldDef & { type: 'datetime'; options?: { precision?: 'date' | 'datetime' | 'time'; range?: boolean } })
  | (BaseFieldDef & { type: 'choice'; options: { choices: { label: Localized; value: string }[]; multiple?: boolean; display?: 'select' | 'buttons' | 'checkboxes' } })
  | (BaseFieldDef & { type: 'link'; options?: { types?: LinkType[]; collections?: string[] } })
  | (BaseFieldDef & { type: 'media'; options?: { multiple?: boolean; accept?: 'image' | 'any' } })
  | (BaseFieldDef & { type: 'relation'; relation: { collection: string; many?: boolean; labelField?: string } })
  | (BaseFieldDef & { type: 'repeater'; options: { fields: Record<string, FieldDef>; fieldLayout?: FieldLayoutDSL } })
  | (BaseFieldDef & { type: 'json' })
  // A consumer-defined field type (registered via `defineFieldType`): any other `type` string, with
  // free-form `options` forwarded to its server descriptor + editor widget.
  | (BaseFieldDef & { type: string & {}; options?: Record<string, unknown> })

/** The specific `FieldDef` arm for a built-in field `type`; falls back to the full union for consumer
 *  types (whose arm is the open `type: string & {}`). The `[…] extends [never]` tuple wrap stops the
 * @public
 *  conditional from distributing over `never`. */
export type FieldOf<T extends FieldType> = [Extract<FieldDef, { type: T }>] extends [never]
  ? FieldDef
  : Extract<FieldDef, { type: T }>

/** Type-guard narrowing a `FieldDef` to a specific built-in arm. Needed because the open consumer arm
 * @public
 *  (`type: string & {}`) makes `type` a non-discriminant, so a bare `f.type === 'x'` won't narrow `f`. */
export function fieldIs<T extends FieldType>(field: FieldDef, type: T): field is FieldOf<T> {
  return field.type === type
}

/** Whether a relation/media field is stored as (and addressed by) a single `<name>Id` FK column —
 *  true unless it is a many-relation or a multiple-media field. The single source of the `Id`-suffix
 * @public
 *  rule shared by column naming (`resolveColumnName`), serialization (the `single` flag), and the editor. */
export function isSingleRefColumn(field: FieldDef): boolean {
  return (fieldIs(field, 'relation') && !field.relation.many)
    || (fieldIs(field, 'media') && !field.options?.multiple)
}

/**
 * Author-facing field-layout DSL (resolved by `resolveFieldLayout`). Each entry is one of:
 *  - a string — a single full-width row (`'title'`), optionally widthed (`'title|50%'`);
 *  - a string[] — a side-by-side row, equal columns by default, or per-field `field|2` (flex weight) /
 *    `field|30%` (a CSS length/percent);
 *  - a single-key object — a named group of rows: `{ 'SEO': [ 'metaTitle', ['a', 'b'] ] }` (one level deep).
 * @public
 */
export type FieldLayoutEntry = string | string[] | Record<string, FieldLayoutEntry[]>

/** A whole `fieldLayout`: an ordered list of `FieldLayoutEntry` rows/groups, resolved by
 *  `resolveFieldLayout` and validated (unknown/duplicate field, invalid width, malformed group) by
 * @public
 *  `validateFieldLayoutsDeep` at `defineCollection` time. */
export type FieldLayoutDSL = FieldLayoutEntry[]

/** The author-facing shape of a collection, passed to `defineCollection`. Validated (not built) at
 *  definition time — the desired-schema sync and pipeline composition happen later, against the returned,
 * @public
 *  unchanged `CollectionDef`. */
export interface CollectionDef {
  name: string
  mode: 'multi' | 'single'
  /** Per-locale content. Optional — defaults to false (a single, non-localized record set). */
  translatable?: boolean
  pageLike?: boolean
  seo?: boolean
  blocks?: { enabled: true; allowed?: string[] }
  status?: boolean
  /** Which admin editor renders this collection's body (the presentation axis, kept separate from the
   *  `blocks` schema flag). Defaults to `'blocks'` when `blocks.enabled`, else `'fields'`. Open string:
   *  extensions register additional editor types (e.g. `'node-graph'`) via `registerCollectionEditor`. */
  editor?: string
  fields: Record<string, FieldDef>
  /** Admin editor layout: rows of fields. A string is its own full-width row; a nested array puts fields
   *  side by side (equal columns, or `field|2` / `field|30%` for flex weights / CSS lengths); a single-key
   *  object is a named group `{ 'SEO': [ … ] }`. Fields omitted from the layout append as full-width rows,
   *  so adding a field never hides it. Absent → today's one-field-per-row. (Deviates from Pruvious, which
   *  nests this under a `dashboard` wrapper — Kestrel keeps its flat CollectionDef idiom.) */
  fieldLayout?: FieldLayoutDSL
  /** Whole-record validation the per-field Zod schema cannot express, because a field validator only ever
   *  sees its own value — e.g. a rule set whose rows have to compile as a unit. Runs server-side BEFORE
   *  the write, next to the conditional-required check, and its issues become the same field-scoped 400
   *  the editor already renders. Server-only: a function, never serialized.
   *  Note the asymmetry: `record` is keyed by COLUMN name (`authorId` for a single relation/media field —
   *  see `resolveColumnName`), while an issue's `path[0]` is the FIELD key the editor renders against. */
  validate?: (record: Record<string, unknown>) => Array<{ path: (string | number)[]; message: string }>
  /** Display labels. `new` is the complete, per-locale "create" phrase (e.g. de `'Neue Seite'` /
   *  `'Neuer Beitrag'`) — supplying the whole phrase sidesteps German gender agreement, which no
   *  `'Neu {x}'` template can get right. Falls back to a generic phrase from `singular` when absent. */
  label?: { singular?: Localized; plural?: Localized; new?: Localized }
  /** Nav/dashboard icon: a UI registry icon name (e.g. `'settings'`) or raw inline SVG markup. Lets
   *  each collection — including custom ones — be visually distinct in the admin rail. */
  icon?: string
  /** Marks a Kestrel-shipped built-in (`pages`, `media`). Built-ins register by default but a consumer
   *  can disable them via `kestrel: { collections: { <name>: false } }` (config → `KESTREL_COLLECTIONS_<NAME>`
   *  env → default-on). Ignored for user-defined collections. */
  builtin?: boolean
  /** Show this collection in the admin rail (default true). Set `false` for a system/config store — e.g.
   *  a settings singleton — that a layer manages internally and surfaces (if at all) through its own UI, so
   *  it never appears as a flat top-level rail item beside the layer's main page. */
  nav?: boolean
}

/**
 * Validates a {@link CollectionDef} and returns it unchanged — the definition-time gate every collection
 * passes through before it can be registered. Invalid combinations fail loud here, at import/startup,
 * rather than surfacing later as a silently-dropped write or a leaked draft.
 *
 * @throws `Error` when `pageLike` is combined with `mode: 'single'` — a routable record needs the slug
 * engine, which only runs through the multi create/update path.
 * @throws `Error` when `editor: 'blocks'` is set without `blocks: { enabled: true }` — the block editor
 * would mount with nowhere to persist its edits.
 * @throws `Error` when `name` collides with a reserved framework API namespace (see
 * `RESERVED_API_NAMESPACES`) — it would shadow `/api/<name>` and leak it into the anonymous public-read set.
 * @throws `Error` on an invalid `fieldLayout` (unknown/duplicate field, invalid width, malformed group), at
 * any nesting depth including inside repeaters — see `validateFieldLayoutsDeep`.
 *
 * @example
 * ```ts
 * export const posts = defineCollection({
 *   name: 'posts',
 *   mode: 'multi',
 *   pageLike: true,
 *   fields: { title: { type: 'text', required: true } },
 * })
 * ```
 * @public
 */
export function defineCollection(def: CollectionDef): CollectionDef {
  // A pageLike record is governed by the slug engine (required + auto-generated + globally unique route),
  // which only runs through the multi create/update path — `putSingleton` writes directly. A routable
  // singleton would silently skip that enforcement, so refuse the combo loudly at definition time.
  if (def.pageLike && def.mode === 'single') {
    throw new Error(`[kestrel] pageLike collection "${def.name}" must be mode: 'multi' (a routable record needs the slug engine)`)
  }
  // The built-in `blocks` editor body persists to the `content` column, which the write schema only exposes
  // when blocks are enabled. editor:'blocks' without blocks:{enabled:true} would mount a working page builder
  // whose every edit is silently dropped on save — refuse the combo loudly at definition time.
  if (def.editor === 'blocks' && !def.blocks?.enabled) {
    throw new Error(`[kestrel] collection "${def.name}" sets editor: 'blocks' but is missing blocks: { enabled: true } — its block edits would never persist`)
  }
  // Framework tool endpoints share the flat /api/<segment> namespace. A pageLike collection whose name
  // matches one enters the anonymous public-read set (publicReadableResources) and makes that endpoint
  // anonymously reachable — e.g. a `links` collection exposes /api/links/resolve, leaking draft slugs.
  // Refuse the collision loudly. (`media` is served by the generic router, so it is NOT a tool namespace.)
  if (RESERVED_API_NAMESPACES.has(def.name)) {
    throw new Error(`[kestrel] collection name "${def.name}" is a reserved framework API namespace — it would shadow /api/${def.name} and leak it into the anonymous public-read set; choose another name`)
  }
  // Fail loud at definition time on a bad field layout (unknown/duplicate field, invalid width, malformed
  // group) — top level plus every nested repeater — so it surfaces at import/startup, not on first render.
  validateFieldLayoutsDeep(def)
  return def
}

const RESERVED_API_NAMESPACES = new Set([
  'auth', 'blocks', 'collections', 'links', 'publish-status', 'references', 'route',
  'galleries-secure', 'galleries-secure-proofing',
])
