import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { allCollections, clearOutboxHandlers, clearRegistry, create, createLocalDriver, ensureOutboxTable, ensureRevisionsTable, getCollection, getResolvedKestrelConfig, outboxHandlersFor, pollOnce, prefixPrimaryLocale, primaryLocale, readOutbox, registerCollection, remove, resetDbInstance, setResolvedKestrelConfig, useDb } from '@kestrel/core'
import {
  registerPlanPublish,
  setPublishRuntime,
  DepsStore,
  classifyWrite,
  planWrite,
  type Invalidation,
  type WriteCollection,
  type PublishQueue,
} from '@kestrel/publishing'
import { pagesCollection } from '@kestrel/collections'
import { mediaCollection, useMediaDbFor, deleteAffected } from '@kestrel/media'

/**
 * Contract under test: planPublish moves from an inline, non-critical after-step (the `planPublishStep`
 * built and registered inside `layers/public/server/plugins/zz.publish.ts`) to an outbox handler
 * (`layers/public/server/handlers/plan-publish.ts`), registered via `registerOutboxHandler`.
 *
 * planPublish's own effect is NOT a DB write: `classifyWrite` + `planWrite` are pure, and the only thing
 * the old after-step did with their result was `queue.enqueue(...)` against the in-memory `PublishQueue`
 * built by `zz.publish.ts` (debounced, coalesced, single-flight — see `queue.ts`). Only a LATER, async,
 * queue-driven run (`publishInvalidation` in `publisher.ts`, which renders via a live Nitro `localFetch`)
 * touches `publish_deps` / `publish_status` — `publisher.ts` documents itself as "NOT unit-tested (needs a
 * running build)". So the observable end state this suite pins is what the handler forwards to a
 * `PublishQueue`-shaped fake (a capturing stand-in for the real queue, conforming to the same public
 * interface `usePublishRuntime()` exposes) — not the DB tables.
 *
 * Every "expected" value below is computed by calling the SAME public `classifyWrite`/`planWrite`
 * functions directly against the actual before/after row the test itself wrote — mirroring how the
 * reindex-refs precedent compares its handler's output against a direct `rebuildRecordRefs()` call.
 */

let db: BetterSQLite3Database
let uploadsDir: string

const migrationsFolder = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'server/database/migrations')

function seed(): void {
  clearRegistry()
  registerCollection(pagesCollection)
  registerCollection(mediaCollection)
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
  resetDbInstance()
  db = useDb() as unknown as BetterSQLite3Database
  migrate(db, { migrationsFolder })
  const sqlite = (db as unknown as { $client: { exec: (sql: string) => void } }).$client
  ensureOutboxTable(sqlite as never, 'content')
  for (const c of allCollections()) ensureRevisionsTable(sqlite as never, c.def.name)
}

/** `output` also has to reach the config-provider seam (`getResolvedKestrelConfig`), not just
 *  `useRuntimeConfig()`: `handlers/plan-publish.ts`'s own `publishOnSave()` now reads the seam (a package
 *  cannot reach `useRuntimeConfig()` — see that file's own TSDoc), while `zz.publish.ts` (still layered)
 *  keeps reading `useRuntimeConfig()` directly — both must agree, so this sets both from ONE `output`
 *  object every time. */
function setupRuntime(publishOnSave = false): void {
  uploadsDir ??= mkdtempSync(join(tmpdir(), 'kestrel-plan-publish-'))
  const output = {
    driver: 'local' as const, dir: uploadsDir, publicDir: uploadsDir, auto: true,
    publishOnSave, reconcileMinutes: 0, verbose: false,
    s3: { bucket: '', region: '', endpoint: '', prefix: '', accessKeyId: '', secretAccessKey: '', sessionToken: '' },
  }
  const media = { driver: 'local', maxUploadBytes: 10_000_000, allowedMimes: '', local: { dir: uploadsDir, baseUrl: '/uploads' }, s3: {} }
  Object.assign(globalThis, { useRuntimeConfig: () => ({ kestrel: { output }, media }) })
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), output })
}

/** A `PublishQueue`-shaped fake that records every non-noop invalidation instead of debouncing/dispatching
 *  it — `noop` is dropped exactly like the real queue drops it (see `PublishQueueOptions`'s TSDoc on
 *  `run`), so `calls` holds only the invalidations that would actually have reached a real publish run. */
function makeCapturingQueue(): { queue: PublishQueue; calls: Invalidation[] } {
  const calls: Invalidation[] = []
  return { queue: { enqueue: (inv) => { if (inv.type !== 'noop') calls.push(inv) } }, calls }
}

function expectedFor(coll: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, publishOnSave = false): Invalidation {
  const def = getCollection(coll)!.def as unknown as WriteCollection
  return planWrite(classifyWrite(def, before, after, primaryLocale(), prefixPrimaryLocale()), publishOnSave)
}

beforeEach(() => {
  seed()
  setupRuntime()
})
afterEach(() => {
  clearOutboxHandlers()
  clearRegistry()
  setPublishRuntime(null)
  delete (globalThis as Record<string, unknown>).useRuntimeConfig
  if (uploadsDir) rmSync(uploadsDir, { recursive: true, force: true })
})

describe('plan-publish handler: registration', () => {
  it('registerPlanPublish() leaves handlers registered for every content write verb', () => {
    registerPlanPublish()
    const registeredForContent = ['pages.created', 'pages.updated', 'pages.deleted'].every((e) => outboxHandlersFor(e).length > 0)
    expect(registeredForContent).toBe(true)
  })

  it('registerPlanPublish() also covers every media write verb (media dep-tagged pages may need replanning)', () => {
    registerPlanPublish()
    const registeredForMedia = ['media.created', 'media.updated', 'media.deleted'].every((e) => outboxHandlersFor(e).length > 0)
    expect(registeredForMedia).toBe(true)
  })
})

describe('plan-publish handler: the old inline after-step is deleted', () => {
  it('layers/public/server/plugins/zz.publish.ts no longer builds/registers planPublishStep as a critical-path after-step', () => {
    const source = readFileSync(join(process.cwd(), 'layers/public/server/plugins/zz.publish.ts'), 'utf-8')
    expect(source).not.toMatch(/registerAfterStep/)
    expect(source).not.toMatch(/planPublishStep/)
  })
})

describe('plan-publish handler: converges publish-planning via a real write + pollOnce', () => {
  it('a deleted published page leaves the queue untouched until pollOnce, then enqueues its removal', async () => {
    registerPlanPublish()
    const { queue, calls } = makeCapturingQueue()
    setPublishRuntime({ queue, deps: new DepsStore() })

    const target = create(db, pagesCollection, { title: 'Target', path: '/target', status: 'published' }) as Record<string, unknown>
    await pollOnce(db, 'content') // drains the CREATE event — a plain save plans nothing (ADR-0008)
    expect(calls).toEqual([])

    remove(db, pagesCollection, target.id as number)
    // Nothing runs inline any more — the delete itself must not have reached the queue yet.
    expect(calls).toEqual([])

    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)

    const expected = expectedFor('pages', target, null)
    expect(calls).toEqual([expected])
  })
})

describe('plan-publish handler: idempotency — same envelope delivered twice', () => {
  it('deleted: delivering the same envelope twice enqueues the identical invalidation both times', async () => {
    registerPlanPublish()
    const { queue, calls } = makeCapturingQueue()
    setPublishRuntime({ queue, deps: new DepsStore() })

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    remove(db, pagesCollection, target.id as number)

    const envelope = readOutbox(db, 'content').find((r) => r.envelope.name === 'pages.deleted')!.envelope
    const handlers = outboxHandlersFor('pages.deleted')
    expect(handlers.length).toBeGreaterThan(0)

    await Promise.all(handlers.map((h) => h.handler(envelope)))
    const expected = expectedFor('pages', target, null)
    expect(calls).toEqual([expected])

    await Promise.all(handlers.map((h) => h.handler(envelope)))
    // Redelivery must compute the SAME plan again — not drift, not compound. The queue itself
    // (debounce + coalesce) owns collapsing repeated identical plans into one publish run; this handler's
    // own idempotency property is that it re-derives the identical invalidation, not a growing one.
    expect(calls).toEqual([expected, expected])
  })

  it('created: a published page create redelivered twice always plans nothing (a save is not a publish, ADR-0008)', async () => {
    registerPlanPublish()
    const { queue, calls } = makeCapturingQueue()
    setPublishRuntime({ queue, deps: new DepsStore() })

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    const envelope = readOutbox(db, 'content').find((r) => r.envelope.name === 'pages.created')!.envelope
    const handlers = outboxHandlersFor('pages.created')
    expect(handlers.length).toBeGreaterThan(0)

    await Promise.all(handlers.map((h) => h.handler(envelope)))
    await Promise.all(handlers.map((h) => h.handler(envelope)))
    expect(calls).toEqual([]) // both deliveries plan a noop — nothing ever reaches the queue
    void target
  })
})

describe('plan-publish handler: redelivery-after-crash semantics', () => {
  it('a row already applied but left unmarked (processed_at NULL) re-applies cleanly on the next pollOnce', async () => {
    registerPlanPublish()
    const { queue, calls } = makeCapturingQueue()
    setPublishRuntime({ queue, deps: new DepsStore() })

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    remove(db, pagesCollection, target.id as number)
    await pollOnce(db, 'content')
    const expected = expectedFor('pages', target, null)
    expect(calls).toEqual([expected])

    const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client
    sqlite.prepare('UPDATE outbox_content SET processed_at = NULL, attempts = 0 WHERE aggregate_key = ?').run(`pages:${target.id}`)

    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)
    // Redelivery re-derives the same plan, not a different or duplicated-with-drift one.
    expect(calls).toEqual([expected, expected])
  })
})

describe('plan-publish handler: per-aggregate ordering sensitivity', () => {
  it('created then deleted, delivered in order via pollOnce, ends consistent with the record being gone', async () => {
    registerPlanPublish()
    const { queue, calls } = makeCapturingQueue()
    setPublishRuntime({ queue, deps: new DepsStore() })

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    remove(db, pagesCollection, target.id as number)

    const pending = readOutbox(db, 'content')
      .filter((r) => r.envelope.aggregate.collection === 'pages' && r.envelope.aggregate.recordId === target.id)
      .sort((a, b) => a.id - b.id)
    expect(pending.map((r) => r.envelope.name)).toEqual(['pages.created', 'pages.deleted'])

    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)

    // The create plans nothing (a save, not a publish); only the delete reaches the queue, and its
    // invalidation is the removal derived from the record's LAST known state, not a stale render for a
    // route that no longer exists.
    const expectedDelete = expectedFor('pages', target, null)
    expect(calls).toEqual([expectedDelete])
    if (expectedDelete.type === 'tags') {
      expect(expectedDelete.render).toEqual([]) // nothing renders a route for a record that's gone
    }
  })
})

describe('plan-publish handler: a stale envelope redelivered later derives from the CURRENT row, not the envelope\'s own payload', () => {
  it('a v1 created envelope redelivered after the record was deleted does not resurrect a render for it', async () => {
    registerPlanPublish()
    const { queue, calls } = makeCapturingQueue()
    setPublishRuntime({ queue, deps: new DepsStore() })

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    await pollOnce(db, 'content')
    expect(calls).toEqual([]) // create plans nothing

    remove(db, pagesCollection, target.id as number)
    await pollOnce(db, 'content')
    const expectedDelete = expectedFor('pages', target, null)
    expect(calls).toEqual([expectedDelete])

    const createdRow = readOutbox(db, 'content').find((r) => r.envelope.aggregate.recordId === target.id && r.envelope.name === 'pages.created')!
    const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client
    sqlite.prepare('UPDATE outbox_content SET processed_at = NULL, attempts = 0 WHERE id = ?').run(createdRow.id)

    await pollOnce(db, 'content')
    // The redelivered `created` envelope must re-derive from the CURRENT (now-deleted) row, not resurrect a
    // render for a page that no longer exists — its own plan is still a noop (create-of-a-since-deleted
    // record's current state is "gone", and `classifyWrite`'s `before === null` reading only ever produces
    // a create-shaped plan, never a synthetic delete), so the queue must gain nothing new.
    expect(calls).toEqual([expectedDelete])
  })
})

describe('the synthetic-media-write outbox seam feeds plan-publish', () => {
  it('a synthetic media delete (deleteAffected, bypassing core CRUD) leaves the queue untouched until pollOnce, then dispatches without error', async () => {
    registerPlanPublish()
    const { queue, calls } = makeCapturingQueue()
    setPublishRuntime({ queue, deps: new DepsStore() })

    const row = create(db, mediaCollection, { storageKey: 'a/pic.png', filename: 'pic.png', mime: 'image/png', ext: 'png', size: 3 }) as Record<string, unknown>
    const driver = createLocalDriver({ dir: uploadsDir, baseUrl: '/uploads' })
    await driver.put('a/pic.png', Buffer.from('x'), 'image/png')

    const mediaDb = useMediaDbFor(db).db
    await deleteAffected(mediaDb, driver, [{ type: 'file', id: row.id as number }])

    expect(calls).toEqual([]) // the synthetic write's own outbox row is not dispatched until pollOnce

    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)

    // planPublish's job for a non-pageLike record (media has no route of its own) is to plan the
    // DATA-TAG invalidation a later publish run resolves against the deps index to find embedding pages —
    // NOT to resolve or re-render those pages itself (that needs a live Nitro `localFetch`, see the
    // suite-level TSDoc). Pin exactly that tag-only consequence via the same public classifyWrite/planWrite
    // this handler is expected to drive.
    const expected = expectedFor('media', row, null)
    expect(calls).toEqual([expected])
    if (expected.type === 'tags') {
      expect(expected.tags).toContain(`media:${row.id}`)
      expect(expected.render).toEqual([]) // media is not pageLike — nothing renders directly
    }
  })
})

describe('plan-publish handler: real before/after diffing through the outbox (not just the same-functions oracle)', () => {
  it('a real unpublish (update to status: draft) enqueues a real invalidation with a literal prune — the before/after payload actually carries the prior published state', async () => {
    registerPlanPublish()
    const { queue, calls } = makeCapturingQueue()
    setPublishRuntime({ queue, deps: new DepsStore() })

    const target = create(db, pagesCollection, { title: 'T', path: '/spk/a', status: 'published' }) as Record<string, unknown>
    await pollOnce(db, 'content')
    calls.length = 0

    const { update } = await import('@kestrel/core')
    update(db, pagesCollection, target.id as number, { status: 'draft' })
    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)

    // Literal, not the same-functions oracle: if the `updated` envelope's payload lost the real `before`
    // (e.g. collapsed to `{ before: after, after }`), `statusChanged` would read false and this would
    // wrongly plan a noop instead of a prune. `pages#group:<group>` is real (pages is translatable, so
    // `create` assigns a translation group) — captured off `target`, not hardcoded, since it's random.
    const groupTag = `pages#group:${target.translationGroup as string}`
    expect(calls).toEqual([{ type: 'tags', tags: ['pages', `pages:${target.id}`, groupTag, '#path:/spk/a'], render: [], prune: ['/spk/a'] }])
  })

  it('a path change (publishOnSave: true) prunes the literal OLD route and renders the literal NEW one', async () => {
    registerPlanPublish()
    const { queue, calls } = makeCapturingQueue()
    setPublishRuntime({ queue, deps: new DepsStore() })
    setupRuntime(true)

    const target = create(db, pagesCollection, { title: 'T', path: '/spk/old', status: 'published' }) as Record<string, unknown>
    await pollOnce(db, 'content')
    calls.length = 0

    const { update } = await import('@kestrel/core')
    update(db, pagesCollection, target.id as number, { path: '/spk/new' })
    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)

    // Literal: if the envelope's `before` were lost, `pathChanged` would read false and the OLD route
    // would never be pruned (the site would keep serving a static file at a path the record no longer has).
    const groupTag = `pages#group:${target.translationGroup as string}`
    expect(calls).toEqual([{
      type: 'tags',
      tags: ['pages', `pages:${target.id}`, groupTag, '#path:/spk/old', '#path:/spk/new'],
      render: ['/spk/new'],
      prune: ['/spk/old'],
    }])
  })
})

describe('plan-publish handler: output.publishOnSave (the pre-2.0 escape hatch)', () => {
  it('a plain content edit that stays published renders inline when publishOnSave is true', async () => {
    registerPlanPublish()
    const { queue, calls } = makeCapturingQueue()
    setPublishRuntime({ queue, deps: new DepsStore() })
    setupRuntime(true)

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    await pollOnce(db, 'content')
    calls.length = 0

    const { update } = await import('@kestrel/core')
    const updated = update(db, pagesCollection, target.id as number, { title: 'edited' }) as Record<string, unknown>
    await pollOnce(db, 'content')

    const expected = expectedFor('pages', { ...target }, updated, true)
    expect(calls).toEqual([expected])
    if (expected.type === 'tags') expect(expected.render).not.toEqual([])
  })
})

describe('plan-publish handler: defensive fallback for a stale (pre-shape-change) `updated` payload', () => {
  it('an unpublish whose stored payload is a plain row (not {before, after}) still tag-invalidates, but NEVER prunes on a guess', async () => {
    registerPlanPublish()
    const { queue, calls } = makeCapturingQueue()
    setPublishRuntime({ queue, deps: new DepsStore() })

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    await pollOnce(db, 'content') // drain the create — nothing pinned by this test
    calls.length = 0

    // A real unpublish, so the row's current state actually goes to draft underneath the synthetic
    // payload below. Under the default (non-publishOnSave) plan, a real {before, after} would classify
    // this as `statusChanged && !isPublished` — a removal, per `planSaveInvalidation`. The whole point of
    // the fallback is that a handler with no reliable `before` must not silently miss the AVAILABILITY
    // change (hence still non-noop) — but it also must not synthesize a `prune` route it cannot actually
    // vouch for (hence `prune: []`, never a guessed route).
    const { update } = await import('@kestrel/core')
    update(db, pagesCollection, target.id as number, { status: 'draft' })

    const row = readOutbox(db, 'content').find((r) => r.envelope.name === 'pages.updated')!
    const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client
    // Hand-reset the stored envelope's payload to the OLD (pre-shape-change) wire shape: a plain row, not
    // {before, after} — simulates a row written before this version's payload shape and left pending.
    sqlite.prepare('UPDATE outbox_content SET envelope = json_set(envelope, \'$.payload\', json(?)) WHERE id = ?')
      .run(JSON.stringify({ id: target.id, title: 'T', path: '/t', status: 'draft' }), row.id)

    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)

    expect(calls.length).toBe(1)
    expect(calls[0]!.type).not.toBe('noop')
    if (calls[0]!.type === 'tags') expect(calls[0]!.prune).toEqual([])
  })

  it('a draft→draft edit under the same stale payload shape never prunes — the fallback trades a possibly-unneeded tag invalidation for never guessing a route to delete', async () => {
    registerPlanPublish()
    const { queue, calls } = makeCapturingQueue()
    setPublishRuntime({ queue, deps: new DepsStore() })

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'draft' }) as Record<string, unknown>
    await pollOnce(db, 'content')
    calls.length = 0

    const { update } = await import('@kestrel/core')
    update(db, pagesCollection, target.id as number, { title: 'T2' })

    const row = readOutbox(db, 'content').find((r) => r.envelope.name === 'pages.updated')!
    const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client
    sqlite.prepare('UPDATE outbox_content SET envelope = json_set(envelope, \'$.payload\', json(?)) WHERE id = ?')
      .run(JSON.stringify({ id: target.id, title: 'T2', path: '/t', status: 'draft' }), row.id)

    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)

    // The forced statusChanged=true, combined with the (genuinely known) current draft state, still routes
    // through the UNPUBLISH branch internally — which is exactly the case that must never emit a prune here,
    // since this record's route (if it even has a live one) was never actually vacated.
    expect(calls.length).toBe(1)
    for (const call of calls) {
      if (call.type === 'tags') expect(call.prune).toEqual([])
    }
  })

  it('a plain content edit that stays published, under the same stale payload shape, still plans nothing under the default (non-publishOnSave) mode', async () => {
    registerPlanPublish()
    const { queue, calls } = makeCapturingQueue()
    setPublishRuntime({ queue, deps: new DepsStore() })

    const target = create(db, pagesCollection, { title: 'T', path: '/t', status: 'published' }) as Record<string, unknown>
    await pollOnce(db, 'content')
    calls.length = 0

    const { update } = await import('@kestrel/core')
    update(db, pagesCollection, target.id as number, { title: 'T2' })

    const row = readOutbox(db, 'content').find((r) => r.envelope.name === 'pages.updated')!
    const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client
    sqlite.prepare('UPDATE outbox_content SET envelope = json_set(envelope, \'$.payload\', json(?)) WHERE id = ?')
      .run(JSON.stringify({ id: target.id, title: 'T2', path: '/t', status: 'published' }), row.id)

    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)
    // A published→published edit is never auto-republished under the default mode, real `before` or not —
    // ADR-0008. The fallback's forced `statusChanged`/`pathChanged` only feed the removal check (real
    // `isPublished` decides it); they never turn a plain save into an inline render.
    expect(calls).toEqual([])
  })
})
