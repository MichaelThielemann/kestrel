// Pure planner for storage GC of gallery namespaces. Given a write event, returns the `galleryId`s whose
// namespace (`galleries-secure/<id>/`) must be recursively deleted: a record DELETE drops every gallery it
// held; an UPDATE that REPLACES/clears a gallery field drops the old id. Pure + node-testable; the plugin
// does the `removeDir`. The `event` shape is a structural subset of core's `WriteEvent` (no path import).
//
// Shared galleryId: a value-copy could duplicate a secureGallery ref verbatim across records (e.g. a
// multilingual `applyFrom`), so two records would share one galleryId + its blobs. The cleanup plugin guards
// against deleting shared data by skipping any galleryId still referenced by another live row (see
// `referencedGalleryIds` in gallery-ownership.ts) — so this planner may return an id whose namespace is then
// kept because a sibling still owns it.
import { GALLERY_ID_RE } from './namespace'

/** The part of a `CollectionDef` that says where a gallery ref can live. */
export interface GalleryHolderDef {
  fields: Record<string, { type: string }>
  blocks?: { enabled?: boolean }
}

interface CleanupEvent {
  def: GalleryHolderDef & { name: string }
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

function galleryIdOf(value: unknown): string | null {
  if (value && typeof value === 'object' && 'galleryId' in value) {
    const id = (value as { galleryId?: unknown }).galleryId
    return typeof id === 'string' && GALLERY_ID_RE.test(id) ? id : null
  }
  return null
}

/** Gallery refs inside a block tree. The README's own recipe declares `secureGallery` on a BLOCK, so the ref
 *  sits in the `content` JSON, which the collection's own `def.fields` does not describe. Within that JSON we
 *  match by value SHAPE — that needs no block-registry lookup, so this stays pure and covers nested slots. */
function contentGalleryIds(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== 'object') return
  const id = galleryIdOf(value)
  if (id) { out.add(id); return } // a gallery ref is a leaf — don't recurse into its own sealed innards
  for (const v of Array.isArray(value) ? value : Object.values(value)) contentGalleryIds(v, out)
}

/** Whether a collection can hold a gallery ref at all — lets the ownership scan skip whole tables. */
export function couldHoldGallery(def: GalleryHolderDef): boolean {
  return def.blocks?.enabled === true || Object.values(def.fields).some((f) => f.type === 'secureGallery')
}

/** Every galleryId a row holds: its declared `secureGallery` fields, plus the block tree when the collection
 *  enables blocks. Schema-driven on purpose — a value the schema doesn't call a gallery (say a user-authored
 *  `json` field that happens to carry a `galleryId`) must never get a namespace deleted under it. */
export function rowGalleryIds(def: GalleryHolderDef, row: Record<string, unknown> | null, out: Set<string> = new Set()): Set<string> {
  if (!row) return out
  for (const [key, field] of Object.entries(def.fields)) {
    if (field.type !== 'secureGallery') continue
    const id = galleryIdOf(row[key])
    if (id) out.add(id)
  }
  if (def.blocks?.enabled) contentGalleryIds(row.content, out)
  return out
}

export function planGalleryDeletion(event: CleanupEvent): string[] {
  const before = rowGalleryIds(event.def, event.before)
  if (!before.size) return [] // nothing held before → nothing to clean (incl. create)
  const after = rowGalleryIds(event.def, event.after)
  // Delete → after has none of them; replace/clear → after no longer holds this particular id. Unchanged → skip.
  return [...before].filter((id) => !after.has(id))
}
