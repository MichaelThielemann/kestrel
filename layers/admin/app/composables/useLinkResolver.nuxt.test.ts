import { describe, it, expect, beforeEach } from 'vitest'
import { getQuery } from 'h3'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { useLinkResolver } from './useLinkResolver'

let calls: string[] = []
registerEndpoint('/api/links/resolve', (event) => {
  const refs = String(getQuery(event).refs ?? '')
  calls.push(refs)
  const data = refs.split(',').filter(Boolean).flatMap((r) => {
    const [collection, idStr] = r.split(':')
    const id = Number(idStr)
    if (collection === 'pages' && id === 5) return [{ collection, id, href: '/about' }]
    if (collection === 'pages' && id === 6) return [{ collection, id, href: '/de/x' }]
    return [] // unresolved (draft / non-page / dangling)
  })
  return { data }
})

beforeEach(() => { calls = [] })

describe('useLinkResolver', () => {
  it('batches refs, caches hrefs, and only fetches missing ones', async () => {
    const r = useLinkResolver()
    await r.ensure([{ collection: 'pages', id: 5 }, { collection: 'pages', id: 6 }])
    expect(r.resolve('pages', 5)).toBe('/about')
    expect(r.resolve('pages', 6)).toBe('/de/x')
    expect(calls).toEqual(['pages:5,pages:6'])

    await r.ensure([{ collection: 'pages', id: 5 }, { collection: 'posts', id: 9 }]) // 5 cached → only posts:9
    expect(calls).toEqual(['pages:5,pages:6', 'posts:9'])
  })

  it('caches misses so an unresolved ref is not re-fetched, and resolves it to null', async () => {
    const r = useLinkResolver()
    await r.ensure([{ collection: 'posts', id: 99 }])
    expect(r.resolve('posts', 99)).toBe(null)
    await r.ensure([{ collection: 'posts', id: 99 }]) // cached miss → no refetch
    expect(calls).toEqual(['posts:99'])
  })

  it('returns null before resolution and skips empty/invalid refs', async () => {
    const r = useLinkResolver()
    expect(r.resolve('pages', 5)).toBe(null)
    await r.ensure([])
    await r.ensure([{ collection: 'pages', id: 0 }, { collection: '', id: 3 }])
    expect(calls).toEqual([])
  })
})
