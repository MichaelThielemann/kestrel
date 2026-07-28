import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../../../test/helpers/db'
import pagesCollection from '../../../collections/server/collections/pages'
import postsCollection from '../../../../server/collections/posts'
import { registerCollection, clearRegistry } from './registry'
import { registerWriteListener, clearWriteListeners } from './write-events'
import { maintainRecordRefs, recordDeadRefs, findReferrers, findBrokenRefs } from './record-ref-index'
import { create, update, remove, list } from './crud'
import { richtextLinkHref } from '../../../fields/app/utils/richtext-links'

// End-to-end through the REAL write-events bus: crud writes emit, and a listener (wired exactly like the
// production `03.record-refs` plugin) maintains the index. Then the warnings are DERIVED on read — and
// they track the target through publish / unpublish / delete / edit, auto-clearing when fixed. What is
// demonstrated end-to-end on real tables is that derivation — the editor warning. Re-rendering the
// referrers is the publisher's job and is covered by the invalidation tests.
describe('record-refs — end-to-end via the write-events bus', () => {
  let db: ReturnType<typeof createTestDb>
  beforeEach(() => {
    db = createTestDb()
    clearRegistry()
    registerCollection(pagesCollection)
    registerCollection(postsCollection)
    clearWriteListeners()
    registerWriteListener((event) => maintainRecordRefs(db, event)) // mirrors layers/core/server/plugins/03.record-refs.ts
  })

  it('warns a referrer when its target is unpublished or deleted, and clears when fixed', () => {
    // A published target page, and a post whose richtext body links to it (a real internal-link marker).
    const target = create(db, pagesCollection, { title: 'Target', path: '/target', status: 'published' }) as Record<string, unknown>
    const targetId = target.id as number
    const body = `<p><a href="${richtextLinkHref('pages', targetId)}">see the page</a></p>`
    const referrer = create(db, postsCollection, { title: 'Referrer', body, status: 'published' }) as Record<string, unknown>
    const refId = referrer.id as number

    // The bus populated the index in both directions; target is live, so no warning yet.
    expect(findReferrers(db, 'pages', targetId)).toEqual([{ collection: 'posts', id: refId }])
    expect(recordDeadRefs(db, postsCollection, refId)).toEqual([])
    expect(findBrokenRefs(db)).toEqual([])

    // Unpublish the target → the referrer keeps its link (not re-rendered) but is now WARNED.
    update(db, pagesCollection, targetId, { status: 'draft' })
    expect(recordDeadRefs(db, postsCollection, refId)).toEqual([{ field: 'body', collection: 'pages', id: targetId, reason: 'unpublished' }])
    expect(list(db, postsCollection, {}).data.find((r) => r.id === refId)?.$hasDeadRefs).toBe(true)
    expect(findBrokenRefs(db)).toEqual([{ source: { collection: 'posts', id: refId }, target: { collection: 'pages', id: targetId }, reason: 'unpublished' }])

    // Re-publish → the warning clears (derived on read, no stored message to invalidate).
    update(db, pagesCollection, targetId, { status: 'published' })
    expect(recordDeadRefs(db, postsCollection, refId)).toEqual([])

    // Delete the target → the link is now missing.
    remove(db, pagesCollection, targetId)
    expect(recordDeadRefs(db, postsCollection, refId)).toEqual([{ field: 'body', collection: 'pages', id: targetId, reason: 'missing' }])
    expect(list(db, postsCollection, {}).data.find((r) => r.id === refId)?.$hasDeadRefs).toBe(true)

    // Editing the referrer to drop the link removes its edges entirely.
    update(db, postsCollection, refId, { body: '<p>no link any more</p>' })
    expect(findReferrers(db, 'pages', targetId)).toEqual([])
    expect(recordDeadRefs(db, postsCollection, refId)).toEqual([])
  })
})
