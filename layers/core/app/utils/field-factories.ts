import type { FieldDef } from '@michaelthielemann/kestrel-core'

/**
 * Field factories for single-file (SFC) block authoring, à la Pruvious. A block's schema is declared as its
 * component's `defineProps({ heading: textField({ required: true }), … })`; each factory returns a DUAL
 * object — a Vue prop descriptor (`type` = a JS-global constructor) that ALSO carries the Kestrel `FieldDef`
 * under `[KESTREL_FIELD]`. Vue reads `type` at runtime; the build-time SFC extractor reads `[KESTREL_FIELD]`.
 *
 * This file imports NO Vue/Nuxt runtime (only JS globals), so it is importable BOTH in the browser (the SFC's
 * props declaration) AND by the Node extractor that injects these factories to evaluate a block's schema.
 * `Symbol.for` (global registry) keeps the key identical even if the file is instantiated twice.
 */
export const KESTREL_FIELD = Symbol.for('kestrel.field')

export interface FieldFactoryResult<C = unknown> {
  /** A Vue prop constructor (String / Number / Boolean / Object / Array) — the runtime prop shape. Typed as
   *  the specific constructor so Vue's `defineProps` accepts the factory result AND infers the prop's value
   *  type (`textField()` → `string`, `mediaField()` → `number`, …). */
  type: C
  /** The Kestrel field definition the extractor lifts into the block's schema. */
  [KESTREL_FIELD]: FieldDef
}

// Keys that belong on the FieldDef itself (not inside `options`); everything else a factory receives is a
// type-specific option. Mirrors `BaseFieldDef` in defineCollection.ts.
const BASE_KEYS = new Set(['required', 'unique', 'label', 'default', 'condition', 'renamedFrom', 'populate'])

function partition(opts: Record<string, unknown>): { base: Record<string, unknown>; options: Record<string, unknown> } {
  const base: Record<string, unknown> = {}
  const options: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(opts)) (BASE_KEYS.has(k) ? base : options)[k] = v
  return { base, options }
}

function wrap<C>(def: Record<string, unknown>, vueType: C): FieldFactoryResult<C> {
  // The factory assembles the FieldDef structurally (open discriminated union); cast through `unknown`.
  return { type: vueType, [KESTREL_FIELD]: def as unknown as FieldDef }
}

/** A leaf field: base props at the top level, everything else under `options`. */
function leaf<C>(type: string, vueType: C) {
  return (opts: Record<string, unknown> = {}): FieldFactoryResult<C> => {
    const { base, options } = partition(opts)
    const def: Record<string, unknown> = { type, ...base }
    if (Object.keys(options).length) def.options = options
    return wrap(def, vueType)
  }
}

/** Generic escape hatch for a CUSTOM field type (registered via `defineFieldType`) that has no dedicated
 *  factory — `field('secureGallery', { … })`. Base props split off the top level, the rest into `options`;
 *  the Vue prop is typed `Object` (unknown value shape). */
export function field(type: string, opts: Record<string, unknown> = {}): FieldFactoryResult<ObjectConstructor> {
  const { base, options } = partition(opts)
  const def: Record<string, unknown> = { type, ...base }
  if (Object.keys(options).length) def.options = options
  return wrap(def, Object)
}

export const textField = leaf('text', String)
export const slugField = leaf('slug', String)
export const richtextField = leaf('richtext', String)
export const numberField = leaf('number', Number)
export const booleanField = leaf('boolean', Boolean)
export const jsonField = leaf('json', Object)
export const linkField = leaf('link', Object)

/** Media: `multiple` (stored bare, an id array) → Array prop; single (a `<name>Id` FK) → Number prop. */
export function mediaField(opts: Record<string, unknown> = {}): FieldFactoryResult<ArrayConstructor | NumberConstructor> {
  const { base, options } = partition(opts)
  const def: Record<string, unknown> = { type: 'media', ...base }
  if (Object.keys(options).length) def.options = options
  return wrap(def, options.multiple ? Array : Number)
}

/** Choice: `multiple` → the value is a `string[]` (Array prop), single → a `string` (String prop). */
export function choiceField(opts: Record<string, unknown> = {}): FieldFactoryResult<ArrayConstructor | StringConstructor> {
  const { base, options } = partition(opts)
  const def: Record<string, unknown> = { type: 'choice', ...base }
  if (Object.keys(options).length) def.options = options
  return wrap(def, options.multiple ? Array : String)
}

/** Datetime: `range` → the value is a `{ start, end }` object (Object prop), else a `string` (String prop). */
export function datetimeField(opts: Record<string, unknown> = {}): FieldFactoryResult<ObjectConstructor | StringConstructor> {
  const { base, options } = partition(opts)
  const def: Record<string, unknown> = { type: 'datetime', ...base }
  if (Object.keys(options).length) def.options = options
  return wrap(def, options.range ? Object : String)
}

/** Relation: `collection`/`many`/`labelField` map into `relation`; `many` → Array prop, single → Number. */
export function relationField(opts: Record<string, unknown> = {}): FieldFactoryResult<ArrayConstructor | NumberConstructor> {
  const { collection, many, labelField, ...rest } = opts as {
    collection?: string
    many?: boolean
    labelField?: string
  } & Record<string, unknown>
  if (typeof collection !== 'string' || !collection) {
    throw new Error('relationField requires a `collection` (the target collection name)')
  }
  const { base, options } = partition(rest)
  const relation: Record<string, unknown> = { collection }
  if (many) relation.many = many
  if (labelField) relation.labelField = labelField
  const def: Record<string, unknown> = { type: 'relation', ...base, relation }
  if (Object.keys(options).length) def.options = options
  return wrap(def, many ? Array : Number)
}

/** Repeater: sub-fields are authored as factory calls too — unwrap each to its FieldDef (recursively).
 *  `fieldLayout` (the sub-field editor layout) forwards into `options` instead of being dropped. */
export function repeaterField(opts: Record<string, unknown> = {}): FieldFactoryResult<ArrayConstructor> {
  const { fields, fieldLayout, ...rest } = opts as { fields?: Record<string, unknown>; fieldLayout?: unknown } & Record<string, unknown>
  const { base } = partition(rest)
  const options: Record<string, unknown> = { fields: unwrapFields(fields ?? {}) }
  if (fieldLayout !== undefined) options.fieldLayout = fieldLayout
  return wrap({ type: 'repeater', ...base, options }, Array)
}

/** Convert a `{ name: <factory-result | FieldDef> }` map into a `{ name: FieldDef }` map. A nested repeater's
 *  result already carries a fully-unwrapped def, so recursion is implicit. */
function unwrapFields(fields: Record<string, unknown>): Record<string, FieldDef> {
  const out: Record<string, FieldDef> = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v && typeof v === 'object' && KESTREL_FIELD in v ? (v as FieldFactoryResult)[KESTREL_FIELD] : (v as FieldDef)
  }
  return out
}
