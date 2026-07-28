import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { resolveServerKestrel, serverRuntimeConfig } from './server-config'

let instance: BetterSQLite3Database | undefined

export function useDb(): BetterSQLite3Database {
  if (!instance) {
    // Prefer the path the kestrel module resolved from the consumer's `kestrel: {}` (via runtimeConfig);
    // fall back to resolving Kestrel's own config file + env for non-runtime callers (e.g. node scripts).
    const fromRc = serverRuntimeConfig()?.kestrel as { dbPath?: string } | undefined
    const path = fromRc?.dbPath || resolveServerKestrel().dbPath
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
