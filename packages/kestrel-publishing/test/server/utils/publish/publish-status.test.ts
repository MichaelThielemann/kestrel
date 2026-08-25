import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { recordPublishStatus, clearPublishStatus, renderOutcome, type PublishStatusDb } from '../../../../src/server/utils/publish/publish-status.js'
import { publishStatus } from '@kestrel/publishing'

// Exercises the writers against a raw, unwrapped drizzle instance (unchecked — no `<Module>Db` ownership
// adapter, on purpose: it's the pure-logic suite, not the ownership suite). `PublishStatusDb` is branded so
// a raw handle no longer satisfies it structurally — `freshDb()`'s cast is the one place that deliberately
// steps around that, mirroring `record-ref-index.test.ts`'s own `asContentDb` helper.
function freshDb(): { db: PublishStatusDb; sqlite: Database.Database } {
  const sqlite = new Database(':memory:')
  sqlite.exec(
    'CREATE TABLE publish_status (route TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, error TEXT, target TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  )
  return { db: drizzle(sqlite) as unknown as PublishStatusDb, sqlite }
}

const rowFor = (db: PublishStatusDb, route: string) =>
  db.select().from(publishStatus).where(eq(publishStatus.route, route)).get()

describe('recordPublishStatus / clearPublishStatus', () => {
  it('records a success outcome (insert) readable back', () => {
    const { db } = freshDb()
    recordPublishStatus(db, '/about', { status: 'success', target: 's3' })
    expect(rowFor(db, '/about')).toMatchObject({ route: '/about', status: 'success', error: null, target: 's3' })
  })

  it('records an error outcome with the failure message and target', () => {
    const { db } = freshDb()
    recordPublishStatus(db, '/blog/x', { status: 'error', error: 'S3 PutObject 403 AccessDenied', target: 's3' })
    expect(rowFor(db, '/blog/x')).toMatchObject({ status: 'error', error: 'S3 PutObject 403 AccessDenied', target: 's3' })
  })

  it('upserts: a later outcome replaces the earlier one for the same route (latest-state, not history)', () => {
    const { db } = freshDb()
    recordPublishStatus(db, '/about', { status: 'error', error: 'boom', target: 'local' })
    recordPublishStatus(db, '/about', { status: 'success', target: 'local' })
    const row = rowFor(db, '/about')
    expect(row).toMatchObject({ status: 'success', error: null, target: 'local' })
    // exactly one row per route
    expect(db.select().from(publishStatus).all()).toHaveLength(1)
  })

  it('stores updatedAt as UNIX seconds (a Date, not raw milliseconds — the bug guard)', () => {
    const { db, sqlite } = freshDb()
    recordPublishStatus(db, '/about', { status: 'success', target: 'local' })
    // drizzle maps the mode:'timestamp' column back to a Date
    expect(rowFor(db, '/about')!.updatedAt).toBeInstanceOf(Date)
    // the raw column holds seconds (~1.7e9), never milliseconds (~1.7e12)
    const raw = sqlite.prepare('SELECT updated_at FROM publish_status WHERE route = ?').get('/about') as { updated_at: number }
    expect(raw.updated_at).toBeLessThan(1e11)
  })

  it('clearPublishStatus deletes the route row (idempotent)', () => {
    const { db } = freshDb()
    recordPublishStatus(db, '/a', { status: 'success', target: 'local' })
    recordPublishStatus(db, '/b', { status: 'success', target: 'local' })
    clearPublishStatus(db, '/a')
    expect(rowFor(db, '/a')).toBeUndefined()
    expect(rowFor(db, '/b')).toBeDefined()
    expect(() => clearPublishStatus(db, '/a')).not.toThrow() // already gone → no-op
  })

  it('degrades gracefully when the publish_status table is absent (a not-yet-migrated deploy)', () => {
    const bare = drizzle(new Database(':memory:')) as unknown as PublishStatusDb // no publish_status table
    expect(() => recordPublishStatus(bare, '/a', { status: 'success', target: 'local' })).not.toThrow()
    expect(() => clearPublishStatus(bare, '/a')).not.toThrow()
  })
})

describe('renderOutcome — classify a render result', () => {
  it('200 with a body → success', () => {
    expect(renderOutcome(200, true)).toBe('success')
  })

  it('a 5xx (page rendered to a server error, a non-200 response not a throw) → error', () => {
    expect(renderOutcome(500, false)).toBe('error')
    expect(renderOutcome(503, false)).toBe('error')
  })

  it('an expected non-200 (draft / unpublish race → 404 / redirect) → skip (leave untouched)', () => {
    expect(renderOutcome(404, false)).toBe('skip')
    expect(renderOutcome(302, false)).toBe('skip')
    expect(renderOutcome(401, false)).toBe('skip')
  })

  it('200 without a body → skip (defensive — nothing to write, nothing failed)', () => {
    expect(renderOutcome(200, false)).toBe('skip')
  })
})
