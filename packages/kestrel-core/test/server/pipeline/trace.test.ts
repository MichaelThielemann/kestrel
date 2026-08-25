import { describe, it, expect } from 'vitest'
import { TraceCollector } from '../../../src/server/pipeline/trace.js'

describe('TraceCollector', () => {
  it('serializes gates, steps and a total duration', () => {
    const trace = new TraceCollector({ pipeline: 'createOne', collection: 'pages', op: 'createOne' })
    trace.gate('access', true)
    trace.gate('csrf', false, 'missing token')
    trace.beginStep('validate', 'main')('ok')
    const json = trace.toJSON()
    expect(json.pipeline).toBe('createOne')
    expect(json.collection).toBe('pages')
    expect(json.gates).toEqual([{ gate: 'access', passed: true }, { gate: 'csrf', passed: false, detail: 'missing token' }])
    expect(json.steps[0]).toMatchObject({ name: 'validate', phase: 'main', status: 'ok' })
    expect(typeof json.steps[0]!.ms).toBe('number')
    expect(typeof json.ms).toBe('number')
  })

  it('defaults collection to null', () => {
    expect(new TraceCollector({ pipeline: 'login', op: 'login' }).toJSON().collection).toBeNull()
  })

  it('records status and reason on close', () => {
    const trace = new TraceCollector({ pipeline: 'p', op: 'p' })
    trace.beginStep('resolveSlug', 'main')('skipped-condition', 'pageLike only')
    trace.beginStep('reindexRefs', 'after', false)('error', 'boom')
    expect(trace.toJSON().steps).toEqual([
      expect.objectContaining({ name: 'resolveSlug', status: 'skipped-condition', reason: 'pageLike only' }),
      expect.objectContaining({ name: 'reindexRefs', phase: 'after', critical: false, status: 'error', reason: 'boom' }),
    ])
  })

  it('attaches annotations to the running step', () => {
    const trace = new TraceCollector({ pipeline: 'p', op: 'p' })
    const end = trace.beginStep('persist', 'main')
    trace.annotate('rows', 3)
    end('ok')
    trace.annotate('stray', true)
    const steps = trace.toJSON().steps
    expect(steps[0]!.annotations).toEqual({ rows: 3 })
    expect(steps).toHaveLength(1)
  })

  it('returns a plain, JSON-round-trippable structure', () => {
    const trace = new TraceCollector({ pipeline: 'p', op: 'p' })
    trace.gate('access', true)
    trace.beginStep('a', 'main')('ok')
    const json = trace.toJSON()
    expect(JSON.parse(JSON.stringify(json))).toEqual(json)
  })
})
