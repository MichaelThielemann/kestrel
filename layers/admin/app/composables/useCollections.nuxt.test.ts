import { describe, it, expect, beforeEach } from 'vitest'
import { useState } from '#imports'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { useCollections } from './useCollections'

let calls = 0
registerEndpoint('/api/collections', () => {
  calls++
  return {
    data: [
      { name: 'posts', mode: 'multi', translatable: true, pageLike: false, seo: false, status: true, blocks: { enabled: false }, label: { singular: 'Post', plural: 'Posts' }, fields: { title: { type: 'text', required: true, unique: false } } },
      { name: 'settings', mode: 'single', translatable: true, pageLike: false, seo: false, status: false, blocks: { enabled: false }, fields: { data: { type: 'json', required: false, unique: false } } },
    ],
  }
})

beforeEach(() => {
  calls = 0
  useState('kestrel-collections').value = null
})

describe('useCollections', () => {
  it('loads the collection defs and exposes mode', async () => {
    const { load, collections } = useCollections()
    const data = await load()
    expect(data).toHaveLength(2)
    expect(data.map((c) => c.name)).toEqual(['posts', 'settings'])
    expect(data[0]!.mode).toBe('multi')
    expect(data[1]!.mode).toBe('single')
    expect(collections.value).toHaveLength(2)
  })

  it('de-dupes: a second load does not refetch', async () => {
    await useCollections().load()
    await useCollections().load()
    expect(calls).toBe(1)
  })
})
