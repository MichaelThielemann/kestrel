import { describe, it, expect } from 'vitest'
import { Effect, Cause } from 'effect'
import { isAsyncFiberException, isFiberFailure, FiberFailureCauseId } from 'effect/Runtime'
import Database from 'better-sqlite3'

// ADR-0011: the assertUnique -> persist critical section runs as an Effect chain under
// Effect.runSync. These five experiments are the regression gate every `effect` upgrade
// must pass before merge; a failure here means the critical-section guarantee no longer holds.

describe('ADR-0011 runSync critical-section regression gate', () => {
  it.each([100_000, 1_000_000])('runSync completes a %i-op sync chain without throwing', (n) => {
    const out = Effect.runSync(
      Effect.iterate(0, {
        while: (i) => i < n,
        body: (i) => Effect.sync(() => i + 1),
      }),
    )
    expect(out).toBe(n)
  })

  it('runSync completes a 10,000,000-op sync chain without throwing (ADR-0011)', () => {
    const n = 10_000_000
    const out = Effect.runSync(
      Effect.iterate(0, {
        while: (i) => i < n,
        body: (i) => Effect.sync(() => i + 1),
      }),
    )
    expect(out).toBe(n)
  }, 30_000)

  it('no event-loop interleaving during runSync: armed timers/microtask never observed mid-chain', () => {
    let intruded = false
    setImmediate(() => { intruded = true })
    setTimeout(() => { intruded = true }, 0)
    queueMicrotask(() => { intruded = true })

    let sawIntrusion = false
    Effect.runSync(
      Effect.iterate(0, {
        while: (i) => i < 2_000_000,
        body: (i) => Effect.sync(() => { if (intruded) sawIntrusion = true; return i + 1 }),
      }),
    )

    expect(sawIntrusion).toBe(false)
  })

  it('SQLite critical section (read -> 1M ops -> write) stays closed against a competing writer (ADR-0011)', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, slug TEXT UNIQUE)')
    setImmediate(() => db.prepare('INSERT INTO t (slug) VALUES (?)').run('intruder'))

    const noInterleavedWrite = Effect.runSync(
      Effect.gen(function* () {
        const before = yield* Effect.sync(() => (db.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c)
        yield* Effect.iterate(0, { while: (i) => i < 1_000_000, body: (i) => Effect.sync(() => i + 1) })
        const mid = yield* Effect.sync(() => (db.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c)
        yield* Effect.sync(() => db.prepare('INSERT INTO t (slug) VALUES (?)').run('mine'))
        return before === mid
      }),
    )

    expect(noInterleavedWrite).toBe(true)
  })

  it('runSync throws AsyncFiberException on a real async boundary (Effect.promise), not silently suspending (ADR-0011)', () => {
    let caught: unknown
    try {
      Effect.runSync(
        Effect.gen(function* () {
          yield* Effect.sync(() => 1)
          yield* Effect.promise(() => Promise.resolve(2))
        }),
      )
    } catch (e) {
      caught = e
    }

    expect(caught).toBeDefined()
    // runSync wraps the fiber's cause in a FiberFailure; the AsyncFiberException identity lives
    // in the squashed cause, not on the thrown error itself.
    expect(isFiberFailure(caught)).toBe(true)
    const squashed = Cause.squash((caught as { [FiberFailureCauseId]: Cause.Cause<unknown> })[FiberFailureCauseId])
    expect(isAsyncFiberException(squashed)).toBe(true)
  })

  it('5000x explicit Effect.yieldNow() drains within the same runSync frame', () => {
    const r = Effect.runSync(
      Effect.gen(function* () {
        let acc = 0
        for (let i = 0; i < 5000; i++) {
          acc++
          yield* Effect.yieldNow()
        }
        return acc
      }),
    )
    expect(r).toBe(5000)
  })
})
