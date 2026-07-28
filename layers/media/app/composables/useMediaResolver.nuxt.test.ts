import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import { getQuery } from 'h3'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { useMediaResolver } from './useMediaResolver'

let calls: string[] = []
registerEndpoint('/api/media/resolve', (event) => {
  const q = getQuery(event)
  const ids = String(q.ids ?? '')
  const locale = String(q.locale ?? 'en')
  calls.push(ids)
  const data = ids
    .split(',')
    .filter(Boolean)
    .map(Number)
    .map((id) => ({ id, alt: `${locale}:${id}`, title: null, description: null, mime: 'image/webp', width: 1, height: 1, thumbhash: null, src: `/m/${id}`, srcset: [] }))
  return { data }
})

beforeEach(() => {
  calls = []
})

describe('useMediaResolver', () => {
  it('fetches only missing ids and caches the results', async () => {
    const r = useMediaResolver('en')
    await r.ensure([1, 2])
    expect(r.resolve(1)).toMatchObject({ id: 1, src: '/m/1' })
    expect(r.resolve(2)).toMatchObject({ id: 2 })
    expect(calls).toEqual(['1,2'])

    await r.ensure([1, 2, 3]) // 1 & 2 cached → only 3 is requested
    expect(calls).toEqual(['1,2', '3'])
    expect(r.resolve(3)).toMatchObject({ id: 3 })
  })

  it('returns null for an unresolved id and skips an empty/invalid ensure', async () => {
    const r = useMediaResolver('en')
    expect(r.resolve(99)).toBe(null)
    await r.ensure([])
    await r.ensure([0, -1])
    expect(calls).toEqual([])
  })

  it('re-fetches per locale (reactive) and resolves to the current-locale entry', async () => {
    const locale = ref('en')
    const r = useMediaResolver(locale)
    await r.ensure([1])
    expect(r.resolve(1)).toMatchObject({ alt: 'en:1' })
    await r.ensure([1]) // same locale, cached → no refetch
    expect(calls).toEqual(['1'])

    locale.value = 'de'
    expect(r.resolve(1)).toBe(null) // de not fetched yet
    await r.ensure([1])
    expect(calls).toEqual(['1', '1'])
    expect(r.resolve(1)).toMatchObject({ alt: 'de:1' })
  })
})
