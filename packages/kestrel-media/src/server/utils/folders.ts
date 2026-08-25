import type { MediaDb } from '../db/media-db.js'
import { folders } from '../database/folders.js'
import { sanitizeFolder } from './naming.js'
import { selfAndAncestors } from './folder-paths.js'

/** Ensure a folder row exists for `path` and every ancestor (after sanitizing). Idempotent.
 * @public
 */
export function ensureFolder(db: MediaDb, path: string): void {
  const clean = sanitizeFolder(path)
  for (const p of selfAndAncestors(clean)) {
    db.insert(folders).values({ path: p }).onConflictDoNothing().run()
  }
}
