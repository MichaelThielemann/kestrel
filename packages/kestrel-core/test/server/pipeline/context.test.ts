import { describe, it, expect } from 'vitest'
import { createPipelineContext } from '../../../src/server/pipeline/context.js'

describe('createPipelineContext', () => {
  it('freezes ctx.exec — a step attempting to write into it throws', () => {
    const ctx = createPipelineContext({ op: 'readOne' })
    expect(() => {
      // @ts-expect-error `exec` is Readonly<ExecPlane> — this proves the freeze, not just the type
      ctx.exec.read = true
    }).toThrow(TypeError)
  })

  it('freezes ctx.exec.request too — a step cannot mutate the transport snapshot in place', () => {
    const ctx = createPipelineContext({ op: 'createOne', request: { ip: '203.0.113.1', method: 'POST', headers: {} } })
    expect(() => {
      ctx.exec.request.ip = '10.0.0.1'
    }).toThrow(TypeError)
  })

  it('resolves ctx.exec.read from the explicit `read` option, not just the op-name default', () => {
    // `updateOne` is a write op by name, but a caller that already resolved a custom PipelineDef with
    // `read: true` (e.g. a consumer override) must be able to say so explicitly.
    const ctx = createPipelineContext({ op: 'updateOne', read: true })
    expect(ctx.exec.read).toBe(true)
  })
})
