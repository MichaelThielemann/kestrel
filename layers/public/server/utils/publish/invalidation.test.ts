import { describe, it, expect } from 'vitest'
import { classifyWrite, planInvalidation, routesToPrune } from './invalidation'

describe('routesToPrune', () => {
  it('never prunes a route that was just rendered live (render wins a coalesced render+prune collision)', () => {
    // Two writes coalesce: page B created at /x (render) while page A vacates /x (prune). /x is live → keep it.
    expect(routesToPrune(['/x', '/gone'], ['/x', '/other'])).toEqual(['/gone'])
  })
  it('prunes routes that were not rendered (a genuine unpublish/delete still removes the stale file)', () => {
    expect(routesToPrune(['/a', '/b'], ['/c'])).toEqual(['/a', '/b'])
  })
})

const page = { name: 'pages', pageLike: true, status: true }
const data = { name: 'speakers', pageLike: false, status: false } // non-pageLike, read by listing pages
const settings = { name: 'settings', pageLike: false, status: false }
const pub = (over: Record<string, unknown> = {}) => ({ id: 7, path: '/spk/a', locale: 'en', status: 'published', ...over })

describe('classifyWrite + planInvalidation — precise per-case invalidation model', () => {
  // CONTENT EDIT — content freshening: listings (<coll>) + explicit referrers (<coll>:<id>) re-render; own route too.
  it('published content edit → tags [coll, coll:id] + own route', () => {
    const ev = classifyWrite(page, pub(), pub(), 'en')
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:7'], render: ['/spk/a'], prune: [] })
  })

  it('a non-primary locale yields a prefixed self route', () => {
    const ev = classifyWrite(page, pub({ id: 3, path: '/p', locale: 'de' }), pub({ id: 3, path: '/p', locale: 'de' }), 'en')
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:3'], render: ['/de/p'], prune: [] })
  })

  it('with prefixPrimary, the primary self route is prefixed too', () => {
    const ev = classifyWrite(page, pub(), pub(), 'en', true)
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:7'], render: ['/en/spk/a'], prune: [] })
  })

  it('singleton / non-pageLike content edit → tags [coll, coll:id], no own route', () => {
    const ev = classifyWrite(settings, { id: 1 }, { id: 1 }, 'en')
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['settings', 'settings:1'], render: [], prune: [] })
  })

  // SLUG / PATH CHANGE — path freshening: listings + referrers re-render (their link path updates); render new, prune old.
  it('slug/path change → tags [coll, coll:id], render new, prune old', () => {
    const ev = classifyWrite(page, pub({ path: '/x' }), pub({ path: '/y' }), 'en')
    expect(ev.pathChanged).toBe(true)
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:7'], render: ['/y'], prune: ['/x'] })
  })

  // LOCALE-ONLY change — the route is localePath(path, locale), so changing only the locale moves the route
  // even though `path` is unchanged. The old-locale static file must be pruned, not left as a stale duplicate.
  it('locale-only change (path unchanged) → prune old-locale route, render new-locale route', () => {
    const ev = classifyWrite(page, pub({ id: 7, path: '/about', locale: 'en' }), pub({ id: 7, path: '/about', locale: 'de' }), 'en')
    expect(ev.pathChanged).toBe(true)
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:7'], render: ['/de/about'], prune: ['/about'] })
  })

  // PUBLISH — availability change: listings re-render (joins published set); render own route; and the record
  // tag too, because a referrer's baked output DOES depend on the target's availability: link resolution is
  // status-gated, so a page linking to the then-draft record baked href="#" and must now re-resolve it.
  it('publish (draft → published) → tags [coll, coll:id] + own route (referrers baked "#" while it was a draft)', () => {
    const ev = classifyWrite(page, pub({ status: 'draft' }), pub({ status: 'published' }), 'en')
    expect(ev.statusChanged).toBe(true)
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:7'], render: ['/spk/a'], prune: [] })
  })

  // UNPUBLISH — availability change: listings re-render (leaves published set); prune own route; the record tag
  // re-renders the pages whose output embeds this record's availability — its translation siblings' hreflang
  // set (they captured coll:id) and referrers whose link must fall back to "#".
  it('unpublish (published → draft) → tags [coll, coll:id] + prune own route (hreflang siblings/referrers re-render)', () => {
    const ev = classifyWrite(page, pub({ status: 'published' }), pub({ status: 'draft' }), 'en')
    expect(ev.statusChanged).toBe(true)
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:7'], render: [], prune: ['/spk/a'] })
  })

  // DELETE — availability change: listings re-render (leaves collection); prune own route (pageLike); the record
  // tag re-renders hreflang siblings + referrers, whose baked hrefs now point at a deleted page.
  it('delete of a pageLike → tags [coll, coll:id] + prune old route', () => {
    const ev = classifyWrite(page, pub({ id: 1, path: '/x' }), null, 'en')
    expect(ev.status).toBe('deleted')
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:1'], render: [], prune: ['/x'] })
  })

  it('delete of a non-pageLike (a data row a listing reads) → tags [coll, coll:id], no prune', () => {
    const ev = classifyWrite(data, { id: 5 }, null, 'en')
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['speakers', 'speakers:5'], render: [], prune: [] })
  })

  // CREATE — a created published record joins listings + (pageLike) renders its own route. No explicit referrer
  // can point at a brand-new id yet, so no <coll>:<id>. Mirrors publish.
  it('create of a published pageLike → tags [coll] only + own route (NOT coll:id)', () => {
    const ev = classifyWrite(page, null, pub({ id: 1, path: '/x' }), 'en')
    expect(ev.status).toBe('created')
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages'], render: ['/x'], prune: [] })
  })

  it('create of a non-pageLike (a data row) → tags [coll] only', () => {
    const ev = classifyWrite(data, null, { id: 5 }, 'en')
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['speakers'], render: [], prune: [] })
  })

  // NO-OP — draft churn changes no published output.
  it('a draft that stays a draft → noop', () => {
    const ev = classifyWrite(page, pub({ id: 2, path: '/d', status: 'draft' }), pub({ id: 2, path: '/d', status: 'draft' }), 'en')
    expect(planInvalidation(ev)).toEqual({ type: 'noop' })
  })

  it('create of a draft pageLike → noop (no published output yet)', () => {
    const ev = classifyWrite(page, null, pub({ id: 9, path: '/z', status: 'draft' }), 'en')
    expect(planInvalidation(ev)).toEqual({ type: 'noop' })
  })

  // EDGE: unpublish + rename in one save — the live static file is at the OLD path; prune that, not the new one.
  it('unpublish + rename → prune the OLD route (the published file), tags [coll, coll:id]', () => {
    const ev = classifyWrite(page, pub({ status: 'published', path: '/old' }), pub({ status: 'draft', path: '/new' }), 'en')
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:7'], render: [], prune: ['/old'] })
  })

  // A record with no id (a not-yet-persisted / id-less row) can carry no <coll>:<id> tag — the availability
  // branches must fall back to the bare collection tag rather than emitting `pages:null`.
  it('availability change on an id-less row → tags [coll] only', () => {
    const ev = classifyWrite(page, { path: '/x', status: 'published' }, { path: '/x', status: 'draft' }, 'en')
    expect(ev.id).toBe(null)
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages'], render: [], prune: ['/x'] })
  })
})

// A page's baked hreflang set covers its whole translation group, so every member's output depends on
// every other member's existence — an edge `<coll>:<id>` cannot express, because a member that rendered
// before a sibling existed never captured that sibling's id. The group tag carries it on every branch.
describe('translation-group invalidation', () => {
  const member = (over: Record<string, unknown> = {}) => pub({ id: 11, path: '/x', locale: 'de', translationGroup: 'g1', ...over })

  it('creating a published sibling tags the group (no id edge reaches the members that predate it)', () => {
    const ev = classifyWrite(page, null, member(), 'en')
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages#group:g1'], render: ['/de/x'], prune: [] })
  })

  it('publishing a sibling that was created as a draft tags the group', () => {
    const ev = classifyWrite(page, member({ status: 'draft' }), member({ status: 'published' }), 'en')
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:11', 'pages#group:g1'], render: ['/de/x'], prune: [] })
  })

  it('unpublishing a sibling tags the group', () => {
    const ev = classifyWrite(page, member({ status: 'published' }), member({ status: 'draft' }), 'en')
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:11', 'pages#group:g1'], render: [], prune: ['/de/x'] })
  })

  it('deleting a sibling tags the group (the group it left is smaller for everyone else)', () => {
    const ev = classifyWrite(page, member(), null, 'en')
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:11', 'pages#group:g1'], render: [], prune: ['/de/x'] })
  })

  it('renaming a sibling tags the group (every member advertises the new hreflang href)', () => {
    const ev = classifyWrite(page, member({ path: '/x' }), member({ path: '/y' }), 'en')
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:11', 'pages#group:g1'], render: ['/de/y'], prune: ['/de/x'] })
  })

  it('a group-less row carries no group tag (a non-translatable write must not over-invalidate)', () => {
    const ev = classifyWrite(page, pub(), pub(), 'en')
    expect(ev.groupTag).toBe(null)
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['pages', 'pages:7'], render: ['/spk/a'], prune: [] })
  })

  it('an empty translationGroup is not a group', () => {
    const ev = classifyWrite(data, null, { id: 5, translationGroup: '' }, 'en')
    expect(ev.groupTag).toBe(null)
    expect(planInvalidation(ev)).toEqual({ type: 'tags', tags: ['speakers'], render: [], prune: [] })
  })
})
