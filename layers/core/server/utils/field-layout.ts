import type { CollectionDef, FieldDef, FieldLayoutDSL, Localized } from './defineCollection'

/**
 * Field layout: the pure, node-testable resolver that turns the author DSL (`CollectionDef.fieldLayout` /
 * a repeater's `options.fieldLayout`) into a normalized, JSON-safe structure the admin renders. It runs at
 * definition time (fail-loud) and again in serialize (the wire copy); no runtime deps — only the erased
 * type imports above.
 */

/** A neutral column track: a flex WEIGHT (a plain number → the UI renders it as an `fr` unit) or an
 *  explicit LENGTH (`'30%'`, `'12rem'`, …). The engine stays free of CSS-grid vocabulary — the UI layer
 *  (Layout.vue) is the single place that turns tracks into a `grid-template-columns` value. */
export type LayoutTrack = number | string

/** A rendered row: the fields (in source/reading order) and one column track per field. */
export interface LayoutRow {
  kind: 'row'
  fields: string[]
  /** One track per field (positionally aligned); default weight `1`. Never an author-supplied CSS string. */
  tracks: LayoutTrack[]
}
/** A single named group (one level deep): a labelled `<fieldset>` wrapping stacked rows. */
export interface LayoutGroup {
  kind: 'group'
  label: Localized
  rows: LayoutRow[]
}
export type LayoutNode = LayoutRow | LayoutGroup

// Width grammar, strict allow-lists so a field width can NEVER inject arbitrary CSS into the grid template.
const WEIGHT = /^\d+(?:\.\d+)?$/ //                  bare number -> `<n>fr` (flex weight)
const LENGTH = /^\d+(?:\.\d+)?(?:fr|%|px|rem|em)$/ // an explicit CSS length/percent (allow-listed units)

interface Cell {
  field: string
  /** A flex weight (number) or an explicit length (string), or undefined → default weight 1. */
  track?: LayoutTrack
}

/** Parse one `'name'` / `'name|2'` / `'name|30%'` token into its field + optional grid track width. */
function parseToken(tok: unknown, ctx: string): Cell {
  if (typeof tok !== 'string') throw new Error(`[kestrel] ${ctx}: a row field must be a string (got ${typeof tok})`)
  const parts = tok.split('|')
  if (parts.length > 2) throw new Error(`[kestrel] ${ctx}: "${tok}" has more than one "|"`)
  const field = parts[0]!.trim()
  if (!field) throw new Error(`[kestrel] ${ctx}: empty field name in "${tok}"`)
  if (parts.length === 1) return { field }
  const w = parts[1]!.trim()
  // A zero (or, defensively, negative) track collapses the cell to a sliver via `.ui-field-cell { min-inline-size:0 }`
  // — silently hiding it. Only a strictly positive value is a real column, so require it alongside the grammar.
  // Strictly positive AND finite: a huge digit run (`'9'.repeat(400)`) parses to Infinity, which passes
  // the digit-only grammar but is not a real column and serializes to JSON `null` on the wire — reject it.
  const positive = (tok: string) => { const n = parseFloat(tok); return n > 0 && Number.isFinite(n) }
  // A bare number or an `fr` length are both FLEX WEIGHTS → emit a plain number (no CSS unit in the wire).
  if (WEIGHT.test(w) && positive(w)) return { field, track: parseFloat(w) }
  if (LENGTH.test(w) && positive(w)) return { field, track: w.endsWith('fr') ? parseFloat(w) : w }
  throw new Error(`[kestrel] ${ctx}: invalid width "${w}" for "${field}" (use a positive number weight like "2", or a length like "30%"/"12rem"/"200px")`)
}

/**
 * Resolve a layout DSL against the field set. A lone string is a full-width row; a string[] is a
 * side-by-side row; a single-key object is a named group of rows (one level, never nested). Fields not
 * mentioned append as full-width rows at the end (declaration order) so adding a field never hides it.
 * Throws on an unknown/duplicate field, a bad width, or a malformed group.
 */
export function resolveFieldLayout(dsl: FieldLayoutDSL, fieldKeys: string[], ctx: string): LayoutNode[] {
  const known = new Set(fieldKeys)
  const seen = new Set<string>()
  const nodes: LayoutNode[] = []

  const use = (field: string) => {
    if (!known.has(field)) throw new Error(`[kestrel] ${ctx}: unknown field "${field}" in the layout`)
    if (seen.has(field)) throw new Error(`[kestrel] ${ctx}: field "${field}" appears more than once in the layout`)
    seen.add(field)
  }
  const toRow = (entry: string | unknown[]): LayoutRow => {
    const tokens = Array.isArray(entry) ? entry : [entry]
    if (!tokens.length) throw new Error(`[kestrel] ${ctx}: a row must contain at least one field`)
    const cells = tokens.map((t) => parseToken(t, ctx))
    cells.forEach((c) => use(c.field))
    return { kind: 'row', fields: cells.map((c) => c.field), tracks: cells.map((c) => c.track ?? 1) }
  }

  for (const entry of dsl) {
    if (typeof entry === 'string' || Array.isArray(entry)) {
      nodes.push(toRow(entry))
      continue
    }
    // A single-key object → a named group of rows.
    const names = Object.keys(entry)
    if (names.length !== 1) throw new Error(`[kestrel] ${ctx}: a group must have exactly one name (got ${names.length})`)
    const label = names[0]!
    const inner = entry[label]!
    if (!Array.isArray(inner) || !inner.length) throw new Error(`[kestrel] ${ctx}: group "${label}" needs at least one row`)
    const rows = inner.map((r) => {
      if (typeof r !== 'string' && !Array.isArray(r)) throw new Error(`[kestrel] ${ctx}: group "${label}" may not nest another group (one level only)`)
      return toRow(r)
    })
    nodes.push({ kind: 'group', label, rows })
  }

  // Any field missing from the layout appends as a full-width row (declaration order) — never hidden.
  for (const field of fieldKeys) if (!seen.has(field)) nodes.push({ kind: 'row', fields: [field], tracks: [1] })
  return nodes
}

/**
 * Validate every field layout a definition carries — the collection's own plus each (nested) repeater's —
 * for the throwing side effect. Called from `defineCollection()` so a bad layout fails at import/startup.
 */
export function validateFieldLayoutsDeep(def: CollectionDef): void {
  if (def.fieldLayout) resolveFieldLayout(def.fieldLayout, Object.keys(def.fields), `collection "${def.name}"`)
  walkRepeaterLayouts(def.fields, '')
}

function walkRepeaterLayouts(fields: Record<string, FieldDef>, prefix: string): void {
  for (const [key, field] of Object.entries(fields)) {
    if (field.type !== 'repeater') continue
    // Structural narrow (avoids a runtime import of `fieldIs` — keeps this file's only runtime edge one-way).
    const options = (field as Extract<FieldDef, { type: 'repeater' }>).options
    const ctx = `${prefix}repeater "${key}"`
    if (options.fieldLayout) resolveFieldLayout(options.fieldLayout, Object.keys(options.fields), ctx)
    walkRepeaterLayouts(options.fields, `${ctx} > `)
  }
}
