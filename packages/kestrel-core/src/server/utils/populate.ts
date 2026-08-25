import type { CollectionDef, FieldDef } from './defineCollection.js'

/** `publicOnly`: the read is served to a principal that may only reach the public collection set, so a
 * @public
 *  populator must not expand a reference into a collection the guard would have refused it directly. */
export interface PopulateCtx { depth: number; locale: string; def: CollectionDef; publicOnly?: boolean }
/** @public */
export type Populator = (row: Record<string, unknown>, ctx: PopulateCtx) => Record<string, unknown>

// A composed list: each registered populator runs in turn over the row (e.g. media attaches `$media`,
// links resolve internal hrefs). They are order-independent — each clones the slice it touches.
const registered: Populator[] = []

/** @public */
export function registerPopulator(fn: Populator): void { registered.push(fn) }
/** @public */
export function clearPopulator(): void { registered.length = 0 }

/** @public */
export function populateRow(row: Record<string, unknown>, ctx: PopulateCtx): Record<string, unknown> {
  if (ctx.depth <= 0) return row
  return registered.reduce((acc, fn) => fn(acc, ctx), row)
}

/**
 * Key-mode captures the storage asymmetry a field populator must read around: a SINGLE relation/media is
 * keyed `${name}Id` in TOP-LEVEL row COLUMNS but BARE `name` in block props / repeater entries (PROPS).
 * Everything else (links, richtext, many-relation, multiple-media) is bare-keyed in both. Mirrors the
 * `KeyMode` in `extract-refs.ts`.
 * @public
 */
export type KeyMode = 'columns' | 'props'

/**
 * A per-field-type read populator (the Pruvious-style seam). Receives the containing — already cloned —
 * value bag, the field's key, its def, the populate ctx, and the key-mode; MUTATES `bag` in place (attach
 * `$media` / a `$<name>` relation sibling, resolve a link value, …). Runs only while `ctx.depth > 0`.
 * SYNCHRONOUS — SQLite reads are synchronous, so the whole populate path stays sync.
 * @public
 */
export type FieldPopulator = (
  bag: Record<string, unknown>,
  key: string,
  field: FieldDef,
  ctx: PopulateCtx,
  keyMode: KeyMode,
) => void

// One populator per field-type name (last-wins, like the field-type registry). The shared field-tree
// walker (`layers/fields`) dispatches into this; the owning layer registers its populator (media →
// `media`, public → `link`/`richtext`, collections → `relation`) so no layer bakes another's read logic
// into a lower-layer field-type descriptor.
const fieldPopulators = new Map<string, FieldPopulator>()

/** @public */
export function registerFieldPopulator(type: string, fn: FieldPopulator): void { fieldPopulators.set(type, fn) }
/** @public */
export function getFieldPopulator(type: string): FieldPopulator | undefined { return fieldPopulators.get(type) }
/** @public */
export function clearFieldPopulators(): void { fieldPopulators.clear() }
