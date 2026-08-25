import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { pagesCollection } from '@kestrel/collections'
import postsCollection from '../../../../../server/collections/posts.js'
import { registerCollection, clearRegistry } from '../../../src/server/utils/registry.js'
import { recordDeadRefs, findReferrers, findBrokenRefs } from '../../../src/server/utils/record-ref-index.js'
import { create, update, remove, list } from '../../../src/server/utils/crud.js'
import { richtextLinkHref } from '@kestrel/core/client'
import { ensureOutboxTable } from '../../../src/server/db/outbox.js'
import { ensureRevisionsTable } from '../../../src/server/db/revisions.js'
import { clearOutboxHandlers, pollOnce } from '../../../src/server/db/outbox-worker.js'
import { registerReindexRefs } from '../../../src/server/handlers/reindex-refs.js'
import { useDb, getResolvedKestrelConfig, setResolvedKestrelConfig } from '../../../src/index.js'
import type { ContentDb } from '../../../src/server/db/content-db.js'

const migrationsFolder = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)), 'server/database/migrations')

// `reindexRefs` (via `useContentDb`) reads the shared `useDb()` singleton, not an injectable port — this
// suite points the singleton at an in-memory db by overriding the resolved config's `dbPath`, then applies
// the real migrations onto it, same as `createTestDb()` does for the layer-level test helper.
setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
const db = useDb() as unknown as BetterSQLite3Database
// `record-ref-index.ts`'s functions take the branded `ContentDb` — `db` above stays the raw
// type for `create`/`update`/`remove`/`list`, so this is the one cast site vouching for the brand here.
const contentDb = db as unknown as ContentDb

// End-to-end through the REAL write path: crud writes emit outbox events, and the `reindexRefs` outbox
// handler (wired exactly like the production `05.reindex-refs` plugin) maintains the index once polled.
// Then the warnings are DERIVED on read — and they track the target through publish / unpublish / delete /
// edit, auto-clearing when fixed. What is demonstrated end-to-end on real tables is that derivation — the
// editor warning. Re-rendering the referrers is the publisher's job and is covered by the invalidation tests.
describe('record-refs — end-to-end via the reindexRefs outbox handler', () => {
  beforeEach(() => {
    migrate(db, { migrationsFolder })
    clearRegistry()
    registerCollection(pagesCollection)
    registerCollection(postsCollection)
    ensureRevisionsTable((db as unknown as { $client: { exec: (sql: string) => void } }).$client as never, 'pages')
    ensureRevisionsTable((db as unknown as { $client: { exec: (sql: string) => void } }).$client as never, 'posts')
    ensureOutboxTable((db as unknown as { $client: { exec: (sql: string) => void } }).$client as never, 'content')
    clearOutboxHandlers()
    registerReindexRefs()
  })

  it('warns a referrer when its target is unpublished or deleted, and clears when fixed', async () => {
    // A published target page, and a post whose richtext body links to it (a real internal-link marker).
    const target = create(db, pagesCollection, { title: 'Target', path: '/target', status: 'published' }) as Record<string, unknown>
    const targetId = target.id as number
    const body = `<p><a href="${richtextLinkHref('pages', targetId)}">see the page</a></p>`
    const referrer = create(db, postsCollection, { title: 'Referrer', body, status: 'published' }) as Record<string, unknown>
    const refId = referrer.id as number
    await pollOnce(db, 'content')

    // The handler populated the index in both directions; target is live, so no warning yet.
    expect(findReferrers(contentDb, 'pages', targetId)).toEqual([{ collection: 'posts', id: refId }])
    expect(recordDeadRefs(contentDb, postsCollection, refId)).toEqual([])
    expect(findBrokenRefs(contentDb)).toEqual([])

    // Unpublish the target → the referrer keeps its link (not re-rendered) but is now WARNED.
    update(db, pagesCollection, targetId, { status: 'draft' })
    expect(recordDeadRefs(contentDb, postsCollection, refId)).toEqual([{ field: 'body', collection: 'pages', id: targetId, reason: 'unpublished' }])
    expect(list(db, postsCollection, {}).data.find((r) => r.id === refId)?.$hasDeadRefs).toBe(true)
    expect(findBrokenRefs(contentDb)).toEqual([{ source: { collection: 'posts', id: refId }, target: { collection: 'pages', id: targetId }, reason: 'unpublished' }])

    // Re-publish → the warning clears (derived on read, no stored message to invalidate).
    update(db, pagesCollection, targetId, { status: 'published' })
    expect(recordDeadRefs(contentDb, postsCollection, refId)).toEqual([])

    // Delete the target → the link is now missing.
    remove(db, pagesCollection, targetId)
    expect(recordDeadRefs(contentDb, postsCollection, refId)).toEqual([{ field: 'body', collection: 'pages', id: targetId, reason: 'missing' }])
    expect(list(db, postsCollection, {}).data.find((r) => r.id === refId)?.$hasDeadRefs).toBe(true)

    // Editing the referrer to drop the link removes its edges entirely, once polled.
    update(db, postsCollection, refId, { body: '<p>no link any more</p>' })
    await pollOnce(db, 'content')
    expect(findReferrers(contentDb, 'pages', targetId)).toEqual([])
    expect(recordDeadRefs(contentDb, postsCollection, refId)).toEqual([])
  })
})
