import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { folders } from '../database/folders'
import { sanitizeFolder } from './naming'
import { selfAndAncestors } from './folder-paths'

/** Ensure a folder row exists for `path` and every ancestor (after sanitizing). Idempotent. */
export function ensureFolder(db: BetterSQLite3Database, path: string): void {
  const clean = sanitizeFolder(path)
  for (const p of selfAndAncestors(clean)) {
    db.insert(folders).values({ path: p }).onConflictDoNothing().run()
  }
}
