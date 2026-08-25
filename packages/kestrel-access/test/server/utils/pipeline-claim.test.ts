import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Effect } from 'effect'
import { buildCollection, clearPipelines, clearRegistry, defineCollection, definePipeline, registerCollection, registerPipeline  } from '@kestrel/core'
import { claimedByPipelineRoute } from '../../../src/server/utils/pipeline-claim.js'

const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', pageLike: true, status: true,
  fields: { title: { type: 'text', required: true } },
}))

beforeEach(() => {
  clearRegistry()
  clearPipelines()
  registerCollection(pages)
  registerPipeline(definePipeline({ name: 'login', access: { public: true }, steps: [{ name: 'noop', fn: () => Effect.void }] }))
})
afterEach(() => { clearRegistry(); clearPipelines() })

describe('claimedByPipelineRoute', () => {
  it('claims a registered read pipeline on GET and a write pipeline on POST', () => {
    expect(claimedByPipelineRoute('GET', '/api/pages/readMany')).toBe(true)
    expect(claimedByPipelineRoute('GET', '/api/pages/readOne/5')).toBe(true)
    expect(claimedByPipelineRoute('GET', '/api/pages/options')).toBe(true)
    expect(claimedByPipelineRoute('POST', '/api/pages/createOne')).toBe(true)
    expect(claimedByPipelineRoute('POST', '/api/pages/deleteOne/5')).toBe(true)
    expect(claimedByPipelineRoute('POST', '/api/login')).toBe(true)
  })

  // A wrong verb, an unknown name or an unknown collection is unclaimed, so the guard's default-deny
  // answers an anonymous probe instead of a 404/405 that would confirm what exists.
  it('does not claim a mismatched verb, an unknown name, or an unknown collection', () => {
    expect(claimedByPipelineRoute('POST', '/api/pages/readMany')).toBe(false)
    expect(claimedByPipelineRoute('GET', '/api/pages/createOne')).toBe(false)
    expect(claimedByPipelineRoute('PATCH', '/api/pages/updateOne/5')).toBe(false)
    expect(claimedByPipelineRoute('GET', '/api/pages/nonsense')).toBe(false)
    expect(claimedByPipelineRoute('GET', '/api/nope/readMany')).toBe(false)
  })

  it('does not claim a path whose pipeline is not registered here', () => {
    for (const [method, path] of [['GET', '/api/route?path=/x'], ['POST', '/api/publish'], ['GET', '/api/collections'], ['GET', '/api/brokenRefs']] as const) {
      expect(claimedByPipelineRoute(method, path)).toBe(false)
    }
  })

  // A collection-less pipeline lives at /api/<name> and nowhere else: /api/pages/login must not resolve
  // the login pipeline with `pages` standing in as its collection.
  it('does not claim a collection-less pipeline reached under a collection', () => {
    expect(claimedByPipelineRoute('POST', '/api/pages/login')).toBe(false)
  })

  it('never claims a collection operation reached without its collection', () => {
    expect(claimedByPipelineRoute('POST', '/api/createOne')).toBe(false)
    expect(claimedByPipelineRoute('GET', '/api/readMany')).toBe(false)
  })

  it('does not claim a malformed URL', () => {
    expect(claimedByPipelineRoute('GET', '/api/pages/5')).toBe(false)
    expect(claimedByPipelineRoute('GET', '/api')).toBe(false)
    expect(claimedByPipelineRoute('GET', '/api/a/b/c/d')).toBe(false)
  })
})
