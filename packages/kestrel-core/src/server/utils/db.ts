import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { getResolvedKestrelConfig } from './kestrel-config-provider.js'

let instance: BetterSQLite3Database | undefined

/** @public */
export function useDb(): BetterSQLite3Database {
  if (!instance) {
    const path = getResolvedKestrelConfig().dbPath
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    const sqlite = new Database(path)
    sqlite.pragma('journal_mode = WAL')
    // NORMAL is durable under WAL (only loses the very last txn on OS crash, never corrupts) and avoids an
    // fsync per commit — markedly faster for admin writes and bulk seed/import. busy_timeout lets a reader
    // (e.g. a concurrent prerender) wait for a writer instead of failing immediately with SQLITE_BUSY.
    sqlite.pragma('synchronous = NORMAL')
    sqlite.pragma('busy_timeout = 5000')
    instance = drizzle(sqlite)
  }
  return instance
}

/** Test-only: drops the cached {@link useDb} connection so the next call re-resolves against the current
 *  config (e.g. after `setResolvedKestrelConfig` points `dbPath` at a fresh `:memory:` db). Mirrors
 * @public
 *  `clearRegistry`/`clearPipelines`'s reset-hook convention; never called from production code paths. */
export function resetDbInstance(): void {
  instance = undefined
}
