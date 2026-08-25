import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { callPipelineRoute } from '../../../../../../test/helpers/pipeline-route.js'
import { buildCollection } from '../../../../src/server/schema/buildCollection.js'
import { defineCollection } from '../../../../src/index.js'
import { clearRegistry, registerCollection } from '../../../../src/server/utils/registry.js'
import { clearPipelines } from '../../../../src/server/pipeline/registry.js'

const things = buildCollection(defineCollection({
  name: 'things', mode: 'multi', translatable: false,
  fields: { title: { type: 'text', required: true } },
}))

beforeEach(() => {
  clearRegistry()
  clearPipelines()
  registerCollection(things)
})
afterEach(() => { clearRegistry(); clearPipelines() })

describe('GET /api/{collection}/schema', () => {
  it('serializes the collection with its actions', async () => {
    const result = await callPipelineRoute('GET', '/api/things/schema', { role: 'admin' }) as { name: string, mode: string, actions: unknown[] }
    expect(result).toMatchObject({ name: 'things', mode: 'multi' })
    expect(result.actions.length).toBeGreaterThan(0) // deleteMany/duplicate surface as generic actions
  })

  it('404s an unknown collection (the router\'s getCollectionOr404, not the step)', async () => {
    await expect(callPipelineRoute('GET', '/api/nope/schema', { role: 'admin' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('refuses an anonymous read', async () => {
    await expect(callPipelineRoute('GET', '/api/things/schema', { role: 'anonymous' })).rejects.toMatchObject({ statusCode: 401 })
  })
})
