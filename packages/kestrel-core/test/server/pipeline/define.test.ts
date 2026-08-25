import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { definePipeline } from '../../../src/server/pipeline/define.js'
import type { StepDef } from '../../../src/server/pipeline/types.js'

const step = (name: string): StepDef => ({ name, fn: () => Effect.void })

describe('definePipeline', () => {
  it('returns the def unchanged', () => {
    const def = definePipeline({ name: 'savePage', access: { public: false }, steps: [step('a')] })
    expect(def.name).toBe('savePage')
    expect(def.steps).toHaveLength(1)
  })

  it('rejects a missing name', () => {
    expect(() => definePipeline({ steps: [step('a')] } as never)).toThrow('non-empty `name`')
  })

  it('rejects an unknown target op', () => {
    expect(() => definePipeline({ name: 'savePage', op: 'saveOne', steps: [step('a')] }))
      .toThrow('not one of the standard operations')
  })

  it('rejects steps and patch together', () => {
    expect(() => definePipeline({ name: 'x', steps: [step('a')], patch: [{ before: 'a', step: step('b') }] }))
      .toThrow('pick one')
  })

  it('rejects a def that declares nothing', () => {
    expect(() => definePipeline({ name: 'x' })).toThrow('would do nothing')
  })

  it('rejects duplicate step names', () => {
    expect(() => definePipeline({ name: 'x', steps: [step('a'), step('a')] })).toThrow('twice')
  })

  it('rejects a step without fn', () => {
    expect(() => definePipeline({ name: 'x', steps: [{ name: 'a' } as never] })).toThrow('has no `fn`')
  })

  it('rejects a patch entry without exactly one anchor', () => {
    expect(() => definePipeline({ name: 'x', patch: [{ step: step('a') } as never] })).toThrow('with no anchor')
    expect(() => definePipeline({ name: 'x', patch: [{ before: 'a', replace: 'b', step: step('c') } as never] }))
      .toThrow('more than one anchor')
  })

  it('rejects unsafeReplace on a non-replace patch entry', () => {
    expect(() => definePipeline({ name: 'x', patch: [{ before: 'a', step: step('b'), unsafeReplace: true } as never] }))
      .toThrow('only applies to `replace`')
  })

  it('rejects an after entry without an explicit critical flag', () => {
    expect(() => definePipeline({ name: 'x', after: [{ step: step('a') } as never] })).toThrow('`critical` flag')
  })
})
