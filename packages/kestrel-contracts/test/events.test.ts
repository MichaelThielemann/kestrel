import { Schema } from 'effect'
import { fc, test } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearUpcasts, registerUpcast, upcastToLatest } from '../src/events.js'
import type { EventEnvelope } from '../src/envelope.js'

// Registry-reset mechanism chosen for test isolation: an exported `clearUpcasts()` that wipes every
// registered upcast. This is the only mechanism the implementer may swap (e.g. for a factory) — the
// semantics asserted below must hold either way.
beforeEach(() => {
  clearUpcasts()
})

function envelope(name: string, version: number, payload: unknown): EventEnvelope {
  return {
    id: '2f5b3e0a-6b1a-4a2a-9a3b-1c2d3e4f5a6b',
    name,
    version,
    aggregate: { collection: 'posts', recordId: 1 },
    sequence: 1,
    correlationId: 'corr-1',
    causation: { pipeline: 'publish', op: 'update' },
    occurredAt: Schema.decodeUnknownSync(Schema.DateTimeUtc)('2024-01-01T00:00:00.000Z'),
    payload,
  } as EventEnvelope
}

describe('upcasting: random chains', () => {
  test.prop([
    fc.integer({ min: 2, max: 6 }).chain((chainLength) =>
      fc.record({
        chainLength: fc.constant(chainLength),
        startVersion: fc.integer({ min: 1, max: chainLength }),
      }),
    ),
    fc.uuid(),
  ])('lands every event at the latest version with the composed transformation applied', ({ chainLength, startVersion }, name) => {
    clearUpcasts()
    for (let v = 1; v < chainLength; v++) {
      registerUpcast(name, v, (p: unknown) => ({
        steps: [...((p as { steps: number[] }).steps), v],
      }))
    }

    const event = envelope(name, startVersion, { steps: [] })
    const result = upcastToLatest(event)

    expect(result.version).toBe(chainLength)
    const expectedSteps = Array.from({ length: chainLength - startVersion }, (_, i) => startVersion + i)
    expect((result.payload as { steps: number[] }).steps).toEqual(expectedSteps)
  })

  test.prop([fc.integer({ min: 2, max: 6 }), fc.uuid()])(
    'is idempotent: upcasting an already-latest event is identity',
    (chainLength, name) => {
      clearUpcasts()
      for (let v = 1; v < chainLength; v++) {
        registerUpcast(name, v, (p: unknown) => ({
          steps: [...((p as { steps: number[] }).steps), v],
        }))
      }

      const latest = envelope(name, chainLength, { steps: [1, 2, 3] })
      const result = upcastToLatest(latest)

      expect(result).toEqual(latest)
    },
  )

  it('is total: every version from 1 to the registered max upcasts without throwing', () => {
    const name = 'total-check'
    const chainLength = 5
    for (let v = 1; v < chainLength; v++) {
      registerUpcast(name, v, (p: unknown) => p)
    }
    for (let start = 1; start <= chainLength; start++) {
      expect(() => upcastToLatest(envelope(name, start, {}))).not.toThrow()
    }
  })
})

describe('upcasting: version gaps', () => {
  it('throws a tagged error when the chain has a gap', () => {
    const name = 'gappy'
    registerUpcast(name, 1, (p) => p)
    registerUpcast(name, 3, (p) => p)
    // no upcast registered for fromVersion 2 — v2 -> v3 is a gap

    let thrown: unknown
    try {
      upcastToLatest(envelope(name, 2, {}))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeDefined()
    expect((thrown as { _tag?: string })._tag).toBeTruthy()
  })
})

describe('upcasting: registry hygiene', () => {
  it('rejects a duplicate (name, fromVersion) registration with a tagged error', () => {
    const name = 'dup'
    registerUpcast(name, 1, (p) => p)

    let thrown: unknown
    try {
      registerUpcast(name, 1, (p) => p)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeDefined()
    expect((thrown as { _tag?: string })._tag).toBeTruthy()
  })
})

describe('upcasting: purity guard', () => {
  const originalNow = Date.now

  afterEach(() => {
    Date.now = originalNow
  })

  it('never touches Date.now during a chain run', () => {
    const spy = vi.fn(originalNow)
    Date.now = spy

    const name = 'pure'
    registerUpcast(name, 1, (p) => ({ ...(p as object), touched: true }))
    registerUpcast(name, 2, (p) => ({ ...(p as object), touchedAgain: true }))

    upcastToLatest(envelope(name, 1, {}))

    expect(spy).not.toHaveBeenCalled()
  })
})
