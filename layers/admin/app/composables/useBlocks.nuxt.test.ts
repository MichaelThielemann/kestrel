import { describe, it, expect, beforeEach } from 'vitest'
import { useState } from '#imports'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { useBlocks } from './useBlocks'
import { useCollections } from './useCollections'

let blockCalls = 0
registerEndpoint('/api/blocks', () => {
  blockCalls++
  return {
    data: [
      { name: 'hero', label: 'Hero', fields: { heading: { type: 'text', required: true } } },
      { name: 'prose', label: 'Prose', fields: { body: { type: 'richtext', required: true } } },
    ],
  }
})
// A second resource sharing the per-request dedup map — guards against cross-contamination.
registerEndpoint('/api/collections', () => ({
  data: [
    { name: 'posts', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false, blocks: { enabled: false }, fields: {} },
  ],
}))

beforeEach(() => {
  blockCalls = 0
  useState('kestrel-blocks').value = null
  useState('kestrel-collections').value = null
})

describe('useBlocks', () => {
  it('loads the block defs', async () => {
    const { load, blocks } = useBlocks()
    const data = await load()
    expect(data.map((b) => b.name)).toEqual(['hero', 'prose'])
    expect(blocks.value).toHaveLength(2)
  })

  it('de-dupes: a second load does not refetch', async () => {
    await useBlocks().load()
    await useBlocks().load()
    expect(blockCalls).toBe(1)
  })

  it('does not cross-contaminate a concurrent sibling load in one request', async () => {
    // Both resources share the per-request in-flight map; each must resolve with its own data.
    const [blocks, collections] = await Promise.all([useBlocks().load(), useCollections().load()])
    expect(blocks.map((b) => b.name)).toEqual(['hero', 'prose'])
    expect(collections.map((c) => c.name)).toEqual(['posts'])
  })
})
