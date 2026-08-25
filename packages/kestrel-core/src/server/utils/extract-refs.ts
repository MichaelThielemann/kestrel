import type { CollectionDef, FieldDef } from './defineCollection.js'
import { fieldIs } from './defineCollection.js'
import type { KeyMode } from './populate.js'
import { seoPopulateFields } from './seo.js'
import { getBlock } from '../blocks/registry.js'
import { collectRichtextRefs } from '../../app/utils/richtext-links.js'

/**
 * Static reference extraction over a record's fields — the pure core of the `record_refs` durable index
 * and the derived stale-reference warnings. Walks every reference-bearing field type (relation, media,
 * internal link, richtext internal-link markers, repeater) plus the block tree, and yields the
 * `(collection, id)` targets it points at. PURE (no DB / no Nuxt) so it unit-tests hard.
 * @public
 */
export interface FieldRef {
  collection: string
  id: number
}

/** A ref tagged with WHERE it lives, for the editor's per-field / per-block dead-reference notes.
 * @public
 */
export interface LocatedRef extends FieldRef {
  /** The top-level field key (a repeater attributes all its entries' refs to the repeater key). */
  field: string
  /** The id of the block node the ref lives in, or undefined at the record root. */
  blockId?: string
}

// `KeyMode` (columns vs props storage asymmetry) is owned by core's populate seam and imported above —
// the same asymmetry the field-tree populator walks, so both share one definition.

/** The internal-link guard, reimplemented locally to keep this `core`/`fields`-side extractor from
 *  importing the `public` layer's private `isInternal` (which would invert the layer dependency). */
function internalLinkRef(value: unknown): FieldRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.type === 'internal' && typeof v.collection === 'string' && typeof v.id === 'number') {
    return { collection: v.collection, id: v.id }
  }
  return null
}

/** Located refs inside one flat value bag (top-level row | block props | a repeater entry). */
function bagRefs(fields: Record<string, FieldDef>, bag: Record<string, unknown>, keyMode: KeyMode): LocatedRef[] {
  const out: LocatedRef[] = []
  for (const [key, field] of Object.entries(fields)) {
    // `if (fieldIs(...))` not `switch (field.type)`: the open consumer arm makes `type` a non-discriminant,
    // so a switch wouldn't narrow `field` to its arm. (text / number / boolean / datetime / choice / json
    // carry no typed references, so they're not handled here.)
    if (fieldIs(field, 'relation')) {
      const coll = field.relation.collection
      if (field.relation.many) {
        const ids = bag[key]
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'number') out.push({ field: key, collection: coll, id })
      } else {
        const value = bag[keyMode === 'columns' ? `${key}Id` : key]
        if (typeof value === 'number') out.push({ field: key, collection: coll, id: value })
      }
    } else if (fieldIs(field, 'media')) {
      if (field.options?.multiple) {
        const ids = bag[key]
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'number') out.push({ field: key, collection: 'media', id })
      } else {
        const value = bag[keyMode === 'columns' ? `${key}Id` : key]
        if (typeof value === 'number') out.push({ field: key, collection: 'media', id: value })
      }
    } else if (field.type === 'link') {
      const ref = internalLinkRef(bag[key])
      if (ref) out.push({ field: key, collection: ref.collection, id: ref.id })
    } else if (field.type === 'richtext') {
      const value = bag[key]
      if (typeof value === 'string') for (const r of collectRichtextRefs(value)) out.push({ field: key, collection: r.collection, id: r.id })
    } else if (fieldIs(field, 'repeater')) {
      const entries = bag[key]
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (entry && typeof entry === 'object') {
            // A repeater entry is keyed bare (props mode); attribute its refs to the repeater field.
            for (const r of bagRefs(field.options.fields, entry as Record<string, unknown>, 'props')) {
              out.push({ field: key, collection: r.collection, id: r.id })
            }
          }
        }
      }
    }
  }
  return out
}

/** Located refs inside a block `content` array, recursing slots; each ref carries the innermost block id. */
function blockRefs(content: unknown): LocatedRef[] {
  const out: LocatedRef[] = []
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      const n = node as { id?: string; type?: string; props?: Record<string, unknown>; slots?: Record<string, unknown> }
      const def = n.type ? getBlock(n.type) : undefined
      if (def && n.props && typeof n.props === 'object') {
        for (const r of bagRefs(def.fields, n.props, 'props')) out.push({ field: r.field, blockId: n.id, collection: r.collection, id: r.id })
      }
      if (n.slots && typeof n.slots === 'object') {
        for (const slotNodes of Object.values(n.slots)) walk(slotNodes)
      }
    }
  }
  walk(content)
  return out
}

function dedupe(refs: FieldRef[]): FieldRef[] {
  const seen = new Set<string>()
  const out: FieldRef[] = []
  for (const r of refs) {
    const k = `${r.collection}:${r.id}`
    if (!seen.has(k)) { seen.add(k); out.push({ collection: r.collection, id: r.id }) }
  }
  return out
}

function dedupeLocated(refs: LocatedRef[]): LocatedRef[] {
  const seen = new Set<string>()
  const out: LocatedRef[] = []
  for (const r of refs) {
    const k = `${r.blockId ?? ''} ${r.field} ${r.collection}:${r.id}`
    if (!seen.has(k)) { seen.add(k); out.push(r) }
  }
  return out
}

/** Deduped `(collection,id)` refs in a single flat value bag (one field set), honouring the key-mode.
 * @public
 */
export function extractFieldRefs(fields: Record<string, FieldDef>, bag: Record<string, unknown>, keyMode: KeyMode): FieldRef[] {
  return dedupe(bagRefs(fields, bag, keyMode))
}

/** Every distinct `(collection,id)` a record points at — its top-level columns plus, if blocks are
 * @public
 *  enabled, its whole block tree. The forward edges stored in `record_refs`. */
export function extractRecordRefs(def: CollectionDef, row: Record<string, unknown>): FieldRef[] {
  return dedupe(extractLocatedRecordRefs(def, row))
}

/** Like `extractRecordRefs` but each ref carries its field + block-node location (for editor warnings).
 * @public
 */
export function extractLocatedRecordRefs(def: CollectionDef, row: Record<string, unknown>): LocatedRef[] {
  const refs = bagRefs(def.fields, row, 'columns')
  // The `seo` system column carries a media ref (the social image) — track it like any media field so
  // dead-link warnings and the published-media GC see a record whose ONLY use of an image is og:image.
  if (def.seo && row.seo && typeof row.seo === 'object') {
    for (const r of bagRefs(seoPopulateFields, row.seo as Record<string, unknown>, 'props')) {
      refs.push({ ...r, field: `seo.${r.field}` })
    }
  }
  if (def.blocks?.enabled) refs.push(...blockRefs(row.content))
  return dedupeLocated(refs)
}
