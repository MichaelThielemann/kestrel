import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { NotFound } from '@michaelthielemann/kestrel-contracts'
import { fromThrowing, fromThrowingAsync } from '../../../../src/server/pipeline/steps/shared.js'
import { runStepAsync, runStepSync } from '../../../../../../test/helpers/run-effect.js'

// fromThrowing/fromThrowingAsync are the escape valves for the handful of step-body call sites where a
// failure is produced OUTSIDE the step's own Effect.gen (a plain helper that still throws, or a nested
// pipeline run reduced back to throw-or-return at its own boundary) — they reclassify a KestrelError throw
// into a proper Effect failure and leave anything else (a survivor, a real bug) as a defect, unchanged.
describe('fromThrowing — bridges a plain throwing function into the typed channel', () => {
  it('a KestrelError throw becomes a proper Effect failure', () => {
    const result = Effect.runSync(Effect.either(fromThrowing((): number => { throw new NotFound({ collection: 'x', id: 1 }) })))
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left).toBeInstanceOf(NotFound)
  })

  it('a non-KestrelError throw stays a defect (surfaces as-is, not as a Fail)', () => {
    const err = new Error('boom')
    expect(() => runStepSync(fromThrowing((): number => { throw err }))).toThrowError(err)
  })

  it('a successful call passes its return value through untouched', () => {
    expect(runStepSync(fromThrowing(() => 42))).toBe(42)
  })
})

describe('fromThrowingAsync — the async counterpart', () => {
  it('a KestrelError rejection becomes a proper Effect failure', async () => {
    const result = await Effect.runPromise(Effect.either(fromThrowingAsync(() => Promise.reject(new NotFound({ collection: 'x', id: 1 })))))
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left).toBeInstanceOf(NotFound)
  })

  it('a non-KestrelError rejection stays a defect', async () => {
    const err = new Error('boom')
    await expect(runStepAsync(fromThrowingAsync(() => Promise.reject(err)))).rejects.toThrow('boom')
  })

  it('a successful call passes its resolved value through untouched', async () => {
    expect(await runStepAsync(fromThrowingAsync(() => Promise.resolve(42)))).toBe(42)
  })
})
