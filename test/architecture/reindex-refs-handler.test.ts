import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { allCollections, clearOutboxHandlers, clearRegistry, create, ensureOutboxTable, ensureRevisionsTable, findReferrers, getResolvedKestrelConfig, outboxHandlersFor, pollOnce, readOutbox, rebuildRecordRefs, recordRefs, registerCollection, registerReindexRefs, remove, resetDbInstance, setResolvedKestrelConfig, update, useContentDbFor, useDb } from '@kestrel/core'
import { richtextLinkHref } from '@kestrel/core/client'
import { pagesCollection } from '@kestrel/collections'
import postsCollection from '../../server/collections/posts'

const migrationsFolder = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'server/database/migrations')

// `reindexRefs` (via `useContentDb`) reads the shared `useDb()` singleton, not an injectable port — each
// `seed()` call points the singleton at a fresh in-memory db instead of stubbing a global.
function freshDb(): BetterSQLite3Database {
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
  resetDbInstance()
  const db = useDb() as unknown as BetterSQLite3Database
  migrate(db, { migrationsFolder })
  return db
}

/**
 * Contract under test: reindexRefs moves from an inline critical-path after-step to an outbox handler
 * (layers/core/server/handlers/reindex-refs.ts), registered via registerOutboxHandler for the content
 * events that affect the ref index. The handler must be idempotent: redelivering the SAME
 * envelope must never change the end state.
 */

function edgesSnapshot(db: BetterSQLite3Database): string[] {
  return db.select().from(recordRefs).all()
    .map((r) => `${r.sourceColl}:${r.sourceId}->${r.targetColl}:${r.targetId}`)
    .sort()
}

function seed(): BetterSQLite3Database {
  clearRegistry()
  registerCollection(pagesCollection)
  registerCollection(postsCollection)
  const db = freshDb()
  const sqlite = (db as unknown as { $client: { exec: (sql: string) => void } }).$client
  ensureOutboxTable(sqlite as never, 'content')
  for (const c of allCollections()) ensureRevisionsTable(sqlite as never, c.def.name)
  return db
}

beforeEach(() => {
  clearOutboxHandlers()
})
afterEach(() => {
  clearOutboxHandlers()
})

describe('reindex-refs handler: registration', () => {
  it('registerReindexRefs() leaves handlers registered for content write events', async () => {
    registerReindexRefs()
    // Whatever event-name scheme the implementation picks, registration must leave at least one
    // handler registered for a create event on a real collection — otherwise nothing ever drives the index.
    const registeredSomewhere = ['pages.created', 'posts.created'].some((event) => outboxHandlersFor(event).length > 0)
    expect(registeredSomewhere).toBe(true)
  })
})

describe('reindex-refs handler: the old inline after-step is deleted', () => {
  it('layers/core/server/plugins/03.record-refs.ts (the no-op stub that once held it) no longer exists', () => {
    // A stronger proof than "the file exists but doesn't register X": the file itself is gone. It was
    // kept as an empty stub only so the numbered plugin sequence stayed stable for filename-sort — moot
    // now that plugin order is declared data (layers/core/modules/plugin-order), so it was deleted.
    expect(existsSync(join(process.cwd(), 'layers/core/server/plugins/03.record-refs.ts'))).toBe(false)
  })
})

describe('reindex-refs handler: converges the index via a real write + pollOnce', () => {
  it('a created page with no refs leaves no edges; a post linking to it produces the edge after pollOnce', async () => {
    registerReindexRefs()
    const db = seed()

    const target = create(db, pagesCollection, { title: 'Target', path: '/target', status: 'published' }) as Record<string, unknown>
    const targetId = target.id as number
    const body = `<p><a href="${richtextLinkHref('pages', targetId)}">see the page</a></p>`
    const referrer = create(db, postsCollection, { title: 'Referrer', body, status: 'published' }) as Record<string, unknown>
    const refId = referrer.id as number

    expect(edgesSnapshot(db)).toEqual([])

    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)

    const contentDb = useContentDbFor(db).db
    expect(findReferrers(contentDb, 'pages', targetId)).toEqual([{ collection: 'posts', id: refId }])
    expect(edgesSnapshot(db)).toEqual([`posts:${refId}->pages:${targetId}`])
  })

  it('converges to the same state a full rebuildRecordRefs() produces, after several interleaved writes', async () => {
    registerReindexRefs()
    const db = seed()

    const pageA = create(db, pagesCollection, { title: 'A', path: '/a', status: 'published' }) as Record<string, unknown>
    const pageB = create(db, pagesCollection, { title: 'B', path: '/b', status: 'published' }) as Record<string, unknown>
    const bodyA = `<p><a href="${richtextLinkHref('pages', pageA.id as number)}">a</a></p>`
    const post = create(db, postsCollection, { title: 'P', body: bodyA, status: 'published' }) as Record<string, unknown>
    const bodyB = `<p><a href="${richtextLinkHref('pages', pageB.id as number)}">b</a></p>`
    update(db, postsCollection, post.id as number, { body: bodyB })

    await pollOnce(db, 'content')

    const viaHandler = edgesSnapshot(db)
    expect(viaHandler.length).toBeGreaterThan(0)

    const contentDb = useContentDbFor(db).db
    rebuildRecordRefs(contentDb)
    const viaRebuild = edgesSnapshot(db)

    expect(viaHandler).toEqual(viaRebuild)
  })
})

describe('reindex-refs handler: idempotency — same envelope delivered twice', () => {
  it('created: delivering the same envelope twice leaves an identical edge set', async () => {
    registerReindexRefs()
    const db = seed()

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    const body = `<p><a href="${richtextLinkHref('pages', target.id as number)}">t</a></p>`
    const post = create(db, postsCollection, { title: 'P', body, status: 'published' }) as Record<string, unknown>

    const envelope = readOutbox(db, 'content').find((r) => r.envelope.name === 'posts.created')!.envelope
    const handlers = outboxHandlersFor('posts.created')
    expect(handlers.length).toBeGreaterThan(0)

    await Promise.all(handlers.map((h) => h.handler(envelope)))
    const afterFirst = edgesSnapshot(db)
    expect(afterFirst).toEqual([`posts:${post.id}->pages:${target.id}`])

    await Promise.all(handlers.map((h) => h.handler(envelope)))
    const afterSecond = edgesSnapshot(db)
    expect(afterSecond).toEqual(afterFirst)
  })

  it('updated: delivering the same envelope twice leaves the same edges as delivering it once (no duplicate rows for a changed ref set)', async () => {
    registerReindexRefs()
    const db = seed()

    const pageA = create(db, pagesCollection, { title: 'A', path: '/a', status: 'published' }) as Record<string, unknown>
    const pageB = create(db, pagesCollection, { title: 'B', path: '/b', status: 'published' }) as Record<string, unknown>
    const bodyA = `<p><a href="${richtextLinkHref('pages', pageA.id as number)}">a</a></p>`
    const post = create(db, postsCollection, { title: 'P', body: bodyA, status: 'published' }) as Record<string, unknown>

    const createdEnvelope = readOutbox(db, 'content').find((r) => r.envelope.name === 'posts.created')!.envelope
    for (const h of outboxHandlersFor('posts.created')) await h.handler(createdEnvelope)
    expect(edgesSnapshot(db)).toEqual([`posts:${post.id}->pages:${pageA.id}`])

    const bodyB = `<p><a href="${richtextLinkHref('pages', pageB.id as number)}">b</a></p>`
    update(db, postsCollection, post.id as number, { body: bodyB })
    const updatedEnvelope = readOutbox(db, 'content').find((r) => r.envelope.name === 'posts.updated')!.envelope
    const updatedHandlers = outboxHandlersFor('posts.updated')
    expect(updatedHandlers.length).toBeGreaterThan(0)

    await Promise.all(updatedHandlers.map((h) => h.handler(updatedEnvelope)))
    const afterFirst = edgesSnapshot(db)
    expect(afterFirst).toEqual([`posts:${post.id}->pages:${pageB.id}`])

    await Promise.all(updatedHandlers.map((h) => h.handler(updatedEnvelope)))
    expect(edgesSnapshot(db)).toEqual(afterFirst)
  })

  it('deleted: delivering the same envelope twice leaves the source with no edges, both times', async () => {
    registerReindexRefs()
    const db = seed()

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    const body = `<p><a href="${richtextLinkHref('pages', target.id as number)}">t</a></p>`
    const post = create(db, postsCollection, { title: 'P', body, status: 'published' }) as Record<string, unknown>

    const createdEnvelope = readOutbox(db, 'content').find((r) => r.envelope.name === 'posts.created')!.envelope
    for (const h of outboxHandlersFor('posts.created')) await h.handler(createdEnvelope)
    expect(edgesSnapshot(db)).toEqual([`posts:${post.id}->pages:${target.id}`])

    remove(db, postsCollection, post.id as number)
    const deletedEnvelope = readOutbox(db, 'content').find((r) => r.envelope.name === 'posts.deleted')!.envelope
    const deletedHandlers = outboxHandlersFor('posts.deleted')
    expect(deletedHandlers.length).toBeGreaterThan(0)

    await Promise.all(deletedHandlers.map((h) => h.handler(deletedEnvelope)))
    expect(edgesSnapshot(db)).toEqual([])

    await Promise.all(deletedHandlers.map((h) => h.handler(deletedEnvelope)))
    expect(edgesSnapshot(db)).toEqual([])
  })

  it('double-delivery interleaved with an unrelated event converges to the same state as single delivery', async () => {
    registerReindexRefs()
    const handlersFor = (name: string) => outboxHandlersFor(name)

    // Single-delivery baseline, computed FIRST against its own fresh db (the handler reads the shared
    // `useDb()` singleton, so only one db can be "live" at a time — the real db under test is seeded after
    // this baseline's snapshot is already captured).
    const baselineDb = seed()
    const baseTarget = create(baselineDb, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    const baseBodyA = `<p><a href="${richtextLinkHref('pages', baseTarget.id as number)}">t</a></p>`
    const basePostA = create(baselineDb, postsCollection, { title: 'A', body: baseBodyA, status: 'published' }) as Record<string, unknown>
    create(baselineDb, postsCollection, { title: 'B', status: 'published' })
    const baseEnvelopeA = readOutbox(baselineDb, 'content').find((r) => r.envelope.aggregate.recordId === basePostA.id && r.envelope.name === 'posts.created')!.envelope
    const baseEnvelopeB = readOutbox(baselineDb, 'content').find((r) => r.envelope.name === 'posts.created' && r.envelope.aggregate.recordId !== basePostA.id)!.envelope
    for (const h of handlersFor('posts.created')) await h.handler(baseEnvelopeA)
    for (const h of handlersFor('posts.created')) await h.handler(baseEnvelopeB)
    const singleDeliveryEnd = edgesSnapshot(baselineDb)

    // Now the real db under test.
    const db = seed()
    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    const bodyA = `<p><a href="${richtextLinkHref('pages', target.id as number)}">t</a></p>`
    const postA = create(db, postsCollection, { title: 'A', body: bodyA, status: 'published' }) as Record<string, unknown>
    const postB = create(db, postsCollection, { title: 'B', status: 'published' }) as Record<string, unknown>
    const envelopeA = readOutbox(db, 'content').find((r) => r.envelope.aggregate.recordId === postA.id && r.envelope.name === 'posts.created')!.envelope
    const envelopeB = readOutbox(db, 'content').find((r) => r.envelope.aggregate.recordId === postB.id && r.envelope.name === 'posts.created')!.envelope

    // Interleaved double delivery against the real db: A, then B (an unrelated event), then A again.
    for (const h of handlersFor('posts.created')) await h.handler(envelopeA)
    for (const h of handlersFor('posts.created')) await h.handler(envelopeB)
    for (const h of handlersFor('posts.created')) await h.handler(envelopeA)

    expect(edgesSnapshot(db)).toEqual(singleDeliveryEnd)
  })
})

describe('reindex-refs handler: redelivery-after-crash semantics', () => {
  it('a row already applied but left unmarked (processed_at NULL) re-applies cleanly on the next pollOnce', async () => {
    registerReindexRefs()
    const db = seed()

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    const body = `<p><a href="${richtextLinkHref('pages', target.id as number)}">t</a></p>`
    const post = create(db, postsCollection, { title: 'P', body, status: 'published' }) as Record<string, unknown>

    await pollOnce(db, 'content')
    const afterFirstPoll = edgesSnapshot(db)
    expect(afterFirstPoll).toEqual([`posts:${post.id}->pages:${target.id}`])

    // Simulate a crash between the handler finishing and the row being marked processed: the row is left
    // exactly as pending as it was before the first poll, everything else (including the index side
    // effects the handler already performed) unchanged.
    const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client
    sqlite.prepare('UPDATE outbox_content SET processed_at = NULL, attempts = 0 WHERE aggregate_key = ?').run(`posts:${post.id}`)

    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)
    expect(edgesSnapshot(db)).toEqual(afterFirstPoll)
  })
})

describe('reindex-refs handler: a stale envelope redelivered later derives from the CURRENT row, not the envelope\'s own payload', () => {
  it('a v1 created envelope redelivered after a later update does not resurrect the superseded refs', async () => {
    registerReindexRefs()
    const db = seed()

    const pageA = create(db, pagesCollection, { title: 'A', path: '/a', status: 'published' }) as Record<string, unknown>
    const pageB = create(db, pagesCollection, { title: 'B', path: '/b', status: 'published' }) as Record<string, unknown>
    const bodyA = `<p><a href="${richtextLinkHref('pages', pageA.id as number)}">a</a></p>`
    const post = create(db, postsCollection, { title: 'P', body: bodyA, status: 'published' }) as Record<string, unknown>
    await pollOnce(db, 'content')
    expect(edgesSnapshot(db)).toEqual([`posts:${post.id}->pages:${pageA.id}`])

    const bodyB = `<p><a href="${richtextLinkHref('pages', pageB.id as number)}">b</a></p>`
    update(db, postsCollection, post.id as number, { body: bodyB })
    await pollOnce(db, 'content')
    const afterUpdate = edgesSnapshot(db)
    expect(afterUpdate).toEqual([`posts:${post.id}->pages:${pageB.id}`])

    // Redeliver the ORIGINAL `posts.created` row (v1's identity) — the record it points at now holds v2's
    // body. Only that one row is reset; the `updated` row (same aggregate_key) must stay untouched.
    const createdRow = readOutbox(db, 'content').find((r) => r.envelope.aggregate.recordId === post.id && r.envelope.name === 'posts.created')!
    const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client
    sqlite.prepare('UPDATE outbox_content SET processed_at = NULL, attempts = 0 WHERE id = ?').run(createdRow.id)

    await pollOnce(db, 'content')
    // Current-row semantics: redelivering the stale `created` envelope must NOT revert the index to A's
    // edge — it re-derives from the row as it stands now (still B), so the end state is unchanged.
    expect(edgesSnapshot(db)).toEqual(afterUpdate)
  })

  it('a created envelope redelivered after the record was deleted leaves the index empty, not resurrected', async () => {
    registerReindexRefs()
    const db = seed()

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    const body = `<p><a href="${richtextLinkHref('pages', target.id as number)}">t</a></p>`
    const post = create(db, postsCollection, { title: 'P', body, status: 'published' }) as Record<string, unknown>
    await pollOnce(db, 'content')
    expect(edgesSnapshot(db)).toEqual([`posts:${post.id}->pages:${target.id}`])

    remove(db, postsCollection, post.id as number)
    await pollOnce(db, 'content')
    expect(edgesSnapshot(db)).toEqual([])

    const createdRow = readOutbox(db, 'content').find((r) => r.envelope.aggregate.recordId === post.id && r.envelope.name === 'posts.created')!
    const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client
    sqlite.prepare('UPDATE outbox_content SET processed_at = NULL, attempts = 0 WHERE id = ?').run(createdRow.id)

    await pollOnce(db, 'content')
    expect(edgesSnapshot(db)).toEqual([])
  })
})

describe('reindex-refs handler: per-aggregate ordering sensitivity', () => {
  it('created then deleted, delivered in order via pollOnce, leaves no refs for that record', async () => {
    registerReindexRefs()
    const db = seed()

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    const body = `<p><a href="${richtextLinkHref('pages', target.id as number)}">t</a></p>`
    const post = create(db, postsCollection, { title: 'P', body, status: 'published' }) as Record<string, unknown>
    remove(db, postsCollection, post.id as number)

    // Both events are queued (created seq 1, deleted seq 2) before either is dispatched — pollOnce's
    // per-aggregate ordering (see outbox-worker.ts groupByAggregate) is what guarantees the delete is
    // applied after the create, not the other way around, which is what leaves zero refs, not one.
    // `pages` and `posts` are separate autoincrement tables, so recordId alone does not identify the
    // aggregate — the target page and the post can share an id; the collection must be checked too.
    const pending = readOutbox(db, 'content')
      .filter((r) => r.envelope.aggregate.collection === 'posts' && r.envelope.aggregate.recordId === post.id)
      .sort((a, b) => a.id - b.id)
    expect(pending.map((r) => r.envelope.name)).toEqual(['posts.created', 'posts.deleted'])

    await pollOnce(db, 'content')
    expect(edgesSnapshot(db)).toEqual([])
  })
})
