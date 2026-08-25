import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Effect, TestClock, TestContext } from 'effect'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { registerUpcast, clearUpcasts } from '@kestrel/contracts'
import {
  buildEnvelope, clearPruneCursors, clearRegistry, create, ensureOutboxTable, ensureRevisionsTable,
  insertOutboxRow, readOutbox, readPendingOutbox, readRevisions, registerCollection,
  setResolvedKestrelConfig, sqliteClientOf, update,
  clearOutboxHandlers, makeTicker, outboxHandlersFor, pollOnceEffect, pollOnce, registerOutboxHandler,
} from '@kestrel/core'
import { resolveServerKestrelConfig } from '../../layers/core/server/utils/server-config'
import { createTestDb } from '../helpers/db'
import { pagesCollection } from '@kestrel/collections'

function seed(): BetterSQLite3Database {
  const sqlite = new Database(':memory:')
  ensureOutboxTable(sqlite, 'content')
  return drizzle(sqlite)
}

function push(db: BetterSQLite3Database, name: string, recordId: number): void {
  const sqlite = (db as unknown as { $client: Database.Database }).$client
  const envelope = buildEnvelope({
    name, version: 1, aggregate: { collection: 'pages', recordId }, sequence: 1,
    correlationId: `c${recordId}`, causation: { pipeline: 'createOne', op: 'createOne' },
    occurredAt: new Date().toISOString(), payload: { id: recordId },
  })
  insertOutboxRow(sqlite, 'content', envelope)
}

beforeEach(() => {
  clearOutboxHandlers()
  clearUpcasts()
  clearPruneCursors()
})
afterEach(() => {
  clearOutboxHandlers()
  clearUpcasts()
  clearPruneCursors()
  // Restore the provider to the default resolution — other tests in this file call
  // `revisionRetentionPolicy` (via `pruneAllDueRevisions`) through real ticks.
  setResolvedKestrelConfig(resolveServerKestrelConfig())
})

describe('registerOutboxHandler', () => {
  it('rejects a second handler registered under the same name for the same event', () => {
    registerOutboxHandler('reindex', { event: 'pages.created' }, async () => {})
    expect(() => registerOutboxHandler('reindex', { event: 'pages.created' }, async () => {})).toThrow()
  })
})

describe('registerOutboxHandler: collection wildcard grammar', () => {
  it('rejects a pattern with no dot', () => {
    expect(() => registerOutboxHandler('h', { event: 'pagescreated' }, async () => {})).toThrow()
  })
  it('rejects a pattern with more than one dot', () => {
    expect(() => registerOutboxHandler('h', { event: 'pages.created.extra' }, async () => {})).toThrow()
  })
  it('rejects an empty verb', () => {
    expect(() => registerOutboxHandler('h', { event: 'pages.' }, async () => {})).toThrow()
  })
  it('rejects an empty collection', () => {
    expect(() => registerOutboxHandler('h', { event: '.created' }, async () => {})).toThrow()
  })
  it('rejects a wildcard in the verb position', () => {
    expect(() => registerOutboxHandler('h', { event: 'pages.*' }, async () => {})).toThrow()
  })
  it('rejects a wildcard that is only part of the collection segment', () => {
    expect(() => registerOutboxHandler('h', { event: 'pa*ges.created' }, async () => {})).toThrow()
  })
  it('accepts the collection wildcard alone in the collection segment', () => {
    expect(() => registerOutboxHandler('h', { event: '*.created' }, async () => {})).not.toThrow()
  })
})

describe('outboxHandlersFor: collection wildcard dispatch', () => {
  it('an exact-event handler and a wildcard handler for the same verb both fire', () => {
    registerOutboxHandler('exact', { event: 'pages.created' }, async () => {})
    registerOutboxHandler('wild', { event: '*.created' }, async () => {})
    const names = outboxHandlersFor('pages.created').map((r) => r.name).sort()
    expect(names).toEqual(['exact', 'wild'])
  })
  it('the wildcard does not shadow the exact handler when both are registered', () => {
    registerOutboxHandler('exact', { event: 'pages.created' }, async () => {})
    registerOutboxHandler('wild', { event: '*.created' }, async () => {})
    expect(outboxHandlersFor('pages.created').some((r) => r.name === 'exact')).toBe(true)
  })
  it('a wildcard handler fires for every collection sharing the verb', () => {
    registerOutboxHandler('wild', { event: '*.created' }, async () => {})
    expect(outboxHandlersFor('pages.created').map((r) => r.name)).toEqual(['wild'])
    expect(outboxHandlersFor('posts.created').map((r) => r.name)).toEqual(['wild'])
  })
  it('a wildcard registered for one verb does not fire for a different verb', () => {
    registerOutboxHandler('wild', { event: '*.created' }, async () => {})
    expect(outboxHandlersFor('pages.updated')).toEqual([])
  })
})

describe('pollOnce: happy path', () => {
  it('dispatches a pending row to its handler and marks it processed, recording exactly one attempt', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    const seen: string[] = []
    registerOutboxHandler('probe', { event: 'pages.created' }, async (envelope) => {
      seen.push(envelope.name)
    })

    const result = await pollOnce(db, 'content')
    expect(result).toEqual({ processed: 1, deadLettered: 0, skipped: 0 })
    expect(seen).toEqual(['pages.created'])

    const rows = readOutbox(db, 'content')
    expect(rows[0]!.processedAt).not.toBeNull()
    expect(rows[0]!.dead).toBe(false)
    expect(rows[0]!.attempts).toBe(1)
  })

  it('is a no-op for an event with no registered handler, but still marks it processed', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    const result = await pollOnce(db, 'content')
    expect(result).toEqual({ processed: 1, deadLettered: 0, skipped: 0 })
    expect(readOutbox(db, 'content')[0]!.processedAt).not.toBeNull()
  })

  it('leaves an already-processed row alone on the next poll', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    let calls = 0
    registerOutboxHandler('probe', { event: 'pages.created' }, async () => { calls++ })
    await pollOnce(db, 'content')
    await pollOnce(db, 'content')
    expect(calls).toBe(1)
  })
})

describe('readPendingOutbox batch limit', () => {
  it('caps how many rows one poll reads, so a backlog drains over several ticks', () => {
    const db = seed()
    push(db, 'pages.created', 1)
    push(db, 'pages.created', 2)
    push(db, 'pages.created', 3)
    const rows = readPendingOutbox(db, 'content', 2)
    expect(rows.map((r) => r.aggregateKey)).toEqual(['pages:1', 'pages:2'])
  })
})

describe('row claiming: what the CAS actually protects', () => {
  it('a SAME-SNAPSHOT race (both polls read attempts=0 before either claims) never dispatches twice', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    let calls = 0
    registerOutboxHandler('probe', { event: 'pages.created' }, async () => { calls++ })

    const [a, b] = await Promise.all([pollOnce(db, 'content'), pollOnce(db, 'content')])
    expect(calls).toBe(1)
    expect(a.processed + b.processed).toBe(1)
    expect(a.skipped + b.skipped).toBe(1) // the loser: readable via PollResult, not silently indistinguishable from an empty queue

    const rows = readOutbox(db, 'content')
    expect(rows[0]!.processedAt).not.toBeNull()
    expect(rows[0]!.dead).toBe(false)
    expect(rows[0]!.attempts).toBe(1)
  })

  it('a STAGGERED second poll (reading only after the first has already claimed) re-claims and dispatches again — the CAS does not protect this case, by design (see makeTicker for what does)', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    let calls = 0
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    registerOutboxHandler('probe', { event: 'pages.created' }, async () => {
      calls++
      // Only the first invocation blocks — the second must resolve on its own, or awaiting it below (before
      // `releaseFirst()` runs) would deadlock against the very race this test is staging.
      if (calls === 1) await gate
    })

    const first = pollOnce(db, 'content')
    // Let the first poll's claim (attempts 0 -> 1) land, and its handler start and suspend, before the
    // second poll even reads — this is what makes it "staggered" rather than a same-snapshot race.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toBe(1)

    const second = await pollOnce(db, 'content') // reads attempts=1, CASes against 1, succeeds
    expect(calls).toBe(2)
    expect(second).toEqual({ processed: 1, deadLettered: 0, skipped: 0 })

    releaseFirst()
    const firstResult = await first
    expect(firstResult).toEqual({ processed: 1, deadLettered: 0, skipped: 0 })
    expect(calls).toBe(2)

    // Both claims landed — this is the double-dispatch the ticker's in-flight guard exists to prevent in
    // real operation; pollOnce/dispatchRow themselves make no such promise (see their TSDoc).
    expect(readOutbox(db, 'content')[0]!.attempts).toBe(2)
  })
})

describe('makeTicker: in-process re-entrancy guard', () => {
  it('a tick started while another is still in flight is a no-op, not a double dispatch', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    let calls = 0
    let releaseHandler: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseHandler = resolve })
    registerOutboxHandler('slow', { event: 'pages.created' }, async () => {
      calls++
      await gate
    })

    const tick = makeTicker(() => db, 'content')
    const first = tick()
    const second = await tick()
    expect(second).toBeNull()

    releaseHandler()
    const firstResult = await first
    expect(firstResult).toEqual({ processed: 1, deadLettered: 0, skipped: 0 })
    expect(calls).toBe(1)
  })

  it('dispatches on every tick — a write made through the SAME connection between ticks is still seen (no data_version blindness)', async () => {
    const db = seed()
    const seen: number[] = []
    registerOutboxHandler('probe', { event: 'pages.created' }, async (envelope) => {
      seen.push(envelope.aggregate.recordId)
    })
    const tick = makeTicker(() => db, 'content')

    push(db, 'pages.created', 1)
    await tick()
    expect(seen).toEqual([1])

    push(db, 'pages.created', 2)
    await tick()
    expect(seen).toEqual([1, 2])
  })
})

describe('per-aggregate ordering', () => {
  it('dispatches two events for the same aggregate strictly in id order, never concurrently', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    push(db, 'pages.deleted', 1)
    const order: string[] = []
    let releaseCreated: () => void = () => {}
    const createdGate = new Promise<void>((resolve) => { releaseCreated = resolve })
    registerOutboxHandler('onCreated', { event: 'pages.created' }, async () => {
      order.push('created:start')
      await createdGate
      order.push('created:end')
    })
    registerOutboxHandler('onDeleted', { event: 'pages.deleted' }, async () => {
      order.push('deleted:start')
    })

    const pending = pollOnce(db, 'content')
    // Let the created handler start and suspend on its gate before asserting the deleted handler hasn't
    // started yet — a short real wait for in-process scheduling to settle, not a retry-schedule delay.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['created:start'])

    releaseCreated()
    await pending
    expect(order).toEqual(['created:start', 'created:end', 'deleted:start'])
  })
})

describe('retry schedule, driven by TestClock (no real waiting)', () => {
  it('follows the exact exponential ladder — 200ms, 400ms, 800ms, 1.6s, 3.2s between attempts', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    let calls = 0
    registerOutboxHandler('always-fails', { event: 'pages.created' }, async () => {
      calls++
      throw new Error('always fails')
    })

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(pollOnceEffect(db, 'content'))
      yield* TestClock.adjust('1 millis')
      expect(calls).toBe(1)

      // Cumulative ms (from the first attempt) at which each retry fires: 200, 200+400, +800, +1600, +3200.
      let elapsed = 1
      let expectedCalls = 1
      for (const threshold of [200, 600, 1400, 3000, 6200]) {
        yield* TestClock.adjust(`${threshold - elapsed - 1} millis`)
        expect(calls).toBe(expectedCalls) // one millisecond short of this step's delay — not fired yet
        yield* TestClock.adjust('1 millis')
        expectedCalls++
        expect(calls).toBe(expectedCalls) // exactly at the delay — fired
        elapsed = threshold
      }
      return yield* fiber.await
    })
    const exit = await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)))

    expect(exit._tag).toBe('Success')
    expect(calls).toBe(6) // 1 initial + 5 retries, matching each ladder step above
  })

  it('retries a transiently-failing handler and eventually processes the row', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    let attempts = 0
    registerOutboxHandler('flaky', { event: 'pages.created' }, async () => {
      attempts++
      if (attempts < 4) throw new Error('transient')
    })

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(pollOnceEffect(db, 'content'))
      yield* TestClock.adjust('10 seconds')
      return yield* fiber.await
    })
    const exit = await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)))

    expect(exit._tag).toBe('Success')
    expect(attempts).toBe(4)
    const rows = readOutbox(db, 'content')
    expect(rows[0]!.dead).toBe(false)
    expect(rows[0]!.processedAt).not.toBeNull()
    expect(rows[0]!.attempts).toBe(4)
  })

  it('dead-letters a poison event after exhausting the retry budget, without blocking a different aggregate', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    push(db, 'pages.created', 2)
    let poisonAttempts = 0
    registerOutboxHandler('poison', { event: 'pages.created' }, async (envelope) => {
      if (envelope.aggregate.recordId === 1) {
        poisonAttempts++
        throw new Error('always fails')
      }
    })

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(pollOnceEffect(db, 'content'))
      yield* TestClock.adjust('60 seconds')
      return yield* fiber.await
    })
    const exit = await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)))

    expect(exit._tag).toBe('Success')
    expect(poisonAttempts).toBe(6) // 1 initial + 5 retries

    const rows = readOutbox(db, 'content')
    const poisoned = rows.find((r) => r.aggregateKey === 'pages:1')!
    const healthy = rows.find((r) => r.aggregateKey === 'pages:2')!
    expect(poisoned.dead).toBe(true)
    expect(poisoned.processedAt).toBeNull()
    expect(poisoned.attempts).toBe(6)
    expect(healthy.dead).toBe(false)
    expect(healthy.processedAt).not.toBeNull()
    expect(healthy.attempts).toBe(1)
  })
})

describe('restart attempt budget', () => {
  it('a row already at the retry-attempts threshold is dead-lettered immediately, without another attempt', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    const sqlite = (db as unknown as { $client: Database.Database }).$client
    // Simulate a prior process that retried this row to exhaustion and crashed before dead-lettering it —
    // exactly the state a restart must not hand a fresh budget to.
    sqlite.prepare('UPDATE outbox_content SET attempts = 6 WHERE aggregate_key = ?').run('pages:1')

    let called = false
    registerOutboxHandler('probe', { event: 'pages.created' }, async () => { called = true })

    const result = await pollOnce(db, 'content')
    expect(result).toEqual({ processed: 0, deadLettered: 1, skipped: 0 })
    expect(called).toBe(false)

    const row = readOutbox(db, 'content')[0]!
    expect(row.dead).toBe(true)
    expect(row.processedAt).toBeNull()
    expect(row.attempts).toBe(6) // unchanged — no attempt was made, just the dead-letter
  })
})

describe('a dead-lettered row does not block its aggregate\'s tail', () => {
  it('a later event for the same aggregate still dispatches after an earlier one dead-letters', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    push(db, 'pages.updated', 1)
    const order: string[] = []
    registerOutboxHandler('onCreated', { event: 'pages.created' }, async () => {
      order.push('created')
      throw new Error('always fails')
    })
    registerOutboxHandler('onUpdated', { event: 'pages.updated' }, async () => {
      order.push('updated')
    })

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(pollOnceEffect(db, 'content'))
      yield* TestClock.adjust('60 seconds')
      return yield* fiber.await
    })
    const exit = await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)))

    expect(exit._tag).toBe('Success')
    expect(order[order.length - 1]).toBe('updated') // dispatched despite the earlier event dead-lettering

    const rows = readOutbox(db, 'content')
    const created = rows.find((r) => r.envelope.name === 'pages.created')!
    const updated = rows.find((r) => r.envelope.name === 'pages.updated')!
    expect(created.dead).toBe(true)
    expect(updated.dead).toBe(false)
    expect(updated.processedAt).not.toBeNull()
  })
})

describe('strict-mode upcast on the consumer path', () => {
  it('dead-letters an envelope whose upcast chain has a gap, without ever calling the handler, and does not retry', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    // A chain step registered only from version 5 onward leaves versions 1-4 unwalkable — the row was
    // written at version 1.
    registerUpcast('pages.created', 5, (payload) => payload)
    let called = false
    registerOutboxHandler('probe', { event: 'pages.created' }, async () => { called = true })

    const result = await pollOnce(db, 'content')
    expect(result).toEqual({ processed: 0, deadLettered: 1, skipped: 0 })
    expect(called).toBe(false)

    const rows = readOutbox(db, 'content')
    expect(rows[0]!.dead).toBe(true)
    expect(rows[0]!.processedAt).toBeNull()
    expect(rows[0]!.attempts).toBe(1) // the claim itself — no retries for a structural gap
  })

  it('passes an event with no registered upcasts through unchanged (not a gap)', async () => {
    const db = seed()
    push(db, 'pages.created', 1)
    let seenVersion: number | undefined
    registerOutboxHandler('probe', { event: 'pages.created' }, async (envelope) => { seenVersion = envelope.version })

    const result = await pollOnce(db, 'content')
    expect(result).toEqual({ processed: 1, deadLettered: 0, skipped: 0 })
    expect(seenVersion).toBe(1)
  })
})

describe('makeTicker: idle ticks also run a bounded revision-prune pass', () => {
  function seedPagesWithRevisions(): { db: BetterSQLite3Database; recordId: number } {
    clearRegistry()
    registerCollection(pagesCollection)
    const db = createTestDb()
    const client = sqliteClientOf(db)
    ensureOutboxTable(client, 'content')
    ensureRevisionsTable(client, 'pages')
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as { id: number }
    for (let i = 0; i < 3; i++) update(db, pagesCollection, row.id, { title: `A v${i}` })
    return { db, recordId: row.id }
  }

  it('a tick with no pending outbox rows still prunes revisions per the resolved retention policy', async () => {
    setResolvedKestrelConfig({ ...resolveServerKestrelConfig(), revisions: { keep: 1 } })
    const { db, recordId } = seedPagesWithRevisions()
    expect(readRevisions(db, 'pages', recordId)).toHaveLength(4)
    // Every create/update above also emitted its own outbox row — drain those first so the tick under
    // test genuinely observes an empty (idle) outbox, not a coincidentally-busy one.
    await pollOnce(db, 'content')

    const tick = makeTicker(() => db, 'content')
    const result = await tick()

    expect(result).toEqual({ processed: 0, deadLettered: 0, skipped: 0 })
    expect(readRevisions(db, 'pages', recordId)).toHaveLength(1)
  })

  it('a BUSY tick (something dispatched) does not prune — pruning never delays dispatch', async () => {
    setResolvedKestrelConfig({ ...resolveServerKestrelConfig(), revisions: { keep: 1 } })
    const { db, recordId } = seedPagesWithRevisions()
    await pollOnce(db, 'content') // drain the create/update writes' own outbox rows first
    registerOutboxHandler('probe', { event: 'pages.created' }, async () => {})
    push(db, 'pages.created', recordId)

    const tick = makeTicker(() => db, 'content')
    const result = await tick()

    expect(result!.processed).toBe(1)
    expect(readRevisions(db, 'pages', recordId)).toHaveLength(4)
  })
})
