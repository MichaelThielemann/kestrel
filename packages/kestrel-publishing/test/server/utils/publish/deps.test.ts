import { describe, it, expect } from 'vitest'
import { routesForTags, staleRoutes, DepsStore } from '../../../../src/server/utils/publish/deps.js'

describe('routesForTags / DepsStore', () => {
  it('returns routes whose captured tags intersect the changed set (the Speaker case)', () => {
    const s = new DepsStore()
    s.record('/speakers', ['speakers', 'settings'])      // overview: list(speakers) + getSingleton(settings)
    s.record('/speakers/ann', ['speakers:1', 'settings']) // detail: getOne(speakers, 1)
    s.record('/speakers/bob', ['speakers:2', 'settings'])
    s.record('/about', ['pages:9', 'settings'])

    // editing speaker 1 → changed tags {speakers, speakers:1}: overview + ann's detail, NOT bob's
    expect(s.routesForTags(['speakers', 'speakers:1']).sort()).toEqual(['/speakers', '/speakers/ann'])
    // a single record tag hits only its detail page
    expect(s.routesForTags(['speakers:2'])).toEqual(['/speakers/bob'])
    // a singleton tag hits every page that read it
    expect(s.routesForTags(['settings']).sort()).toEqual(['/about', '/speakers', '/speakers/ann', '/speakers/bob'])
    expect(s.routesForTags(['nope'])).toEqual([])
  })

  it('record overwrites a route\'s tag set; routes() lists known routes', () => {
    const s = new DepsStore()
    s.record('/x', ['a'])
    s.record('/x', ['b'])
    expect(s.routesForTags(['a'])).toEqual([])
    expect(s.routesForTags(['b'])).toEqual(['/x'])
    expect(s.routes()).toEqual(['/x'])
  })

  it('routesForTags is a pure function over an index map', () => {
    const idx = new Map<string, Set<string>>([['/a', new Set(['t'])], ['/b', new Set(['u'])]])
    expect(routesForTags(['t'], idx)).toEqual(['/a'])
  })
})

describe('DepsStore durable persistence port', () => {
  function fakePersistence(seed: Array<[string, string[]]> = []) {
    const store = new Map<string, string[]>(seed.map(([r, t]) => [r, [...t]]))
    const calls: string[] = []
    return {
      store,
      calls,
      load: () => { calls.push('load'); return [...store.entries()].map(([r, t]) => [r, t] as const) },
      save: (route: string, tags: Iterable<string>) => { calls.push(`save:${route}`); store.set(route, [...tags]) },
      remove: (route: string) => { calls.push(`remove:${route}`); store.delete(route) },
      clearAll: () => { calls.push('clearAll'); store.clear() },
    }
  }

  it('hydrates the in-memory index from persistence on construction', () => {
    const p = fakePersistence([['/a', ['x']], ['/b', ['y']]])
    const s = new DepsStore(p)
    expect(s.routes().sort()).toEqual(['/a', '/b'])
    expect(s.routesForTags(['x'])).toEqual(['/a'])
    expect(p.calls).toContain('load')
  })

  it('writes through record / forget / clear to persistence', () => {
    const p = fakePersistence()
    const s = new DepsStore(p)
    s.record('/a', ['x', 'y'])
    expect(p.store.get('/a')).toEqual(['x', 'y'])
    s.forget('/a')
    expect(p.store.has('/a')).toBe(false)
    s.record('/b', ['z'])
    s.clear()
    expect(p.store.size).toBe(0)
    expect(p.calls).toEqual(['load', 'save:/a', 'remove:/a', 'save:/b', 'clearAll'])
  })

  it('without a persistence port behaves as a pure in-memory store (unchanged)', () => {
    const s = new DepsStore()
    s.record('/a', ['x'])
    expect(s.routesForTags(['x'])).toEqual(['/a'])
  })
})

describe('staleRoutes', () => {
  it('returns tracked routes no longer published — unpublish / delete / slug change', () => {
    const tracked = ['/', '/about', '/de/ueber-uns', '/posts/old']
    // /de/ueber-uns was unpublished (or deleted); /posts/old was renamed to /posts/new
    const publishedNow = ['/', '/about', '/posts/new']
    expect(staleRoutes(tracked, publishedNow).sort()).toEqual(['/de/ueber-uns', '/posts/old'])
  })
  it('returns nothing when every tracked route is still published', () => {
    expect(staleRoutes(['/', '/a'], ['/', '/a', '/b'])).toEqual([])
  })
  it('handles an empty tracked set (a fresh boot has nothing to prune)', () => {
    expect(staleRoutes([], ['/', '/a'])).toEqual([])
  })
})
