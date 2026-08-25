import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { clearRegistry, desiredSchema, diffSchema, getResolvedKestrelConfig, registerCollection, renderSqlite, resetDbInstance, setResolvedKestrelConfig, useDb } from '@kestrel/core'
import { redirectsCollection } from '@kestrel/publishing'
import { liveRedirectFor, invalidateLiveRedirects } from '../../src/server/redirects.js'

// No @kestrel/core mock here — a real in-memory DB + the real redirectsCollection, through
// liveRedirectFor's actual compileFromDb/matchRedirect path (mirrors layers/public/server/routes/
// redirects.json.get.test.ts's own fixture for the static artifact's sibling read path).
function save(sqlite: Database.Database, rules: unknown): void {
  sqlite.prepare('INSERT OR REPLACE INTO redirects (singleton_key, rules, created_at, updated_at) VALUES (?, ?, 0, 0)')
    .run('redirects', JSON.stringify(rules))
}

let sqlite: Database.Database

beforeEach(() => {
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
  resetDbInstance()
  const db = useDb() as unknown as BetterSQLite3Database
  sqlite = (db as unknown as { $client: Database.Database }).$client
  for (const stmt of renderSqlite(diffSchema(desiredSchema([redirectsCollection.table]), {}))) sqlite.exec(stmt)
  clearRegistry()
  registerCollection(redirectsCollection)
  invalidateLiveRedirects()
})

describe('liveRedirectFor against a real DB + the real redirects collection', () => {
  it('matches a saved rule and returns its target/status', () => {
    save(sqlite, [{ from: '/old-page', to: '/new-page', status: '301' }])
    expect(liveRedirectFor('/old-page')).toEqual({ target: '/new-page', status: 301 })
  })

  it('returns null for a path with no matching rule', () => {
    save(sqlite, [{ from: '/old-page', to: '/new-page', status: '301' }])
    expect(liveRedirectFor('/unrelated')).toBeNull()
  })

  it('honors authored order — the first matching rule wins', () => {
    save(sqlite, [{ from: '/a', to: '/one' }, { from: '/a', to: '/two' }])
    expect(liveRedirectFor('/a')).toMatchObject({ target: '/one' })
  })

  it('reflects a save made after the cache was already warm, once invalidated', () => {
    save(sqlite, [{ from: '/a', to: '/one' }])
    expect(liveRedirectFor('/a')).toMatchObject({ target: '/one' })
    save(sqlite, [{ from: '/a', to: '/two' }])
    expect(liveRedirectFor('/a')).toMatchObject({ target: '/one' }) // still cached
    invalidateLiveRedirects()
    expect(liveRedirectFor('/a')).toMatchObject({ target: '/two' })
  })

  it('returns null when the singleton has never been saved', () => {
    expect(liveRedirectFor('/anything')).toBeNull()
  })
})
