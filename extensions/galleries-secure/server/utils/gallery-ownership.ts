// Reverse lookup for the GC ownership guard (see 01.gallery-cleanup): which galleryIds are STILL referenced by
// a live row, across all collections. A planned namespace deletion is skipped for any id in this set, so a
// galleryId shared by another record (e.g. a verbatim multilingual copy) isn't removeDir'd out from under that
// record. `rowGalleryIds` reads the same places the cleanup planner does (declared secureGallery fields plus,
// where blocks are enabled, the block tree), so ownership can never see less than the planner deletes; a
// secureGallery column is JSON either way, so drizzle returns it already parsed. `couldHoldGallery` skips
// whole tables — this runs on every gallery write, so collections that can hold no ref cost no read.
import { couldHoldGallery, rowGalleryIds, type GalleryHolderDef } from './gallery-cleanup'

interface ScanDb {
  select(): { from(table: unknown): { all(): Record<string, unknown>[] } }
}
interface ScanCollection {
  def: GalleryHolderDef
  table: unknown
}

/** The set of galleryIds currently referenced by some live row. */
export function referencedGalleryIds(db: ScanDb, collections: readonly ScanCollection[]): Set<string> {
  const ids = new Set<string>()
  for (const c of collections) {
    if (!couldHoldGallery(c.def)) continue
    for (const row of db.select().from(c.table).all()) rowGalleryIds(c.def, row, ids)
  }
  return ids
}
