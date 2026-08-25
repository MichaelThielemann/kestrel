import { describe, it, expect } from 'vitest'
import { hasPendingChanges, pendingRoutes, heldRoutes } from '../../../../src/server/utils/publish/pending.js'

describe('hasPendingChanges', () => {
  it('is true when the record was saved after its page was last published', () => {
    expect(hasPendingChanges(5_000, 3_000)).toBe(true)
  })

  it('is false when the last publish is newer than the last save', () => {
    expect(hasPendingChanges(3_000, 5_000)).toBe(false)
  })

  // publish_status.updated_at is stored in whole seconds while a record's updatedAt is milliseconds, so a
  // publish that immediately follows a save reads as up to a second OLDER than the save it published.
  // Without the tolerance the editor would report unpublished changes for a page it just published.
  it('tolerates the second-vs-millisecond truncation of a publish that directly followed the save', () => {
    expect(hasPendingChanges(10_900, 10_000)).toBe(false)
    expect(hasPendingChanges(11_001, 10_000)).toBe(true)
  })

  it('is false when the route was never published — there is no older version to protect', () => {
    expect(hasPendingChanges(5_000, null)).toBe(false)
    expect(hasPendingChanges(5_000, undefined)).toBe(false)
  })

  it('is false when the record carries no save stamp (nothing to compare)', () => {
    expect(hasPendingChanges(null, 3_000)).toBe(false)
  })
})

describe('pendingRoutes', () => {
  it('names the routes whose record moved on after the last publish', () => {
    const saved = new Map([['/a', 9_000], ['/b', 1_000], ['/c', 4_000]])
    const published = new Map([['/a', 2_000], ['/b', 2_000]])
    // /a edited since publish → pending · /b published after its edit → not · /c never published → not
    expect(pendingRoutes(saved, published)).toEqual(['/a'])
  })

  it('is empty when nothing was ever published', () => {
    expect(pendingRoutes(new Map([['/a', 9_000]]), new Map())).toEqual([])
  })
})

describe('heldRoutes', () => {
  // A rename moves the route string, so the record's new route has no publish stamp of its own and the
  // never-published carve-out would wave the unpublished rename straight onto the live site.
  const renamed = (savedMs: number) => heldRoutes(
    new Map([['/new', savedMs]]),
    new Map([['/old', 2_000]]),
    new Map([['/new', 'pages:1']]),
    (tag) => (tag === 'pages:1' ? ['/old'] : []),
  )

  it('holds a renamed route back and protects the old route its record is still served from', () => {
    const { hold, keep } = renamed(9_000)
    expect([...hold]).toEqual(['/new'])
    expect([...keep]).toEqual(['/old'])
  })

  it('releases the rename once the record is no longer pending — the old route is then genuinely stale', () => {
    const { hold, keep } = renamed(1_000)
    expect([...hold]).toEqual([])
    expect([...keep]).toEqual([])
  })

  it('keeps the first-deploy carve-out: a record with no prior published route is never held', () => {
    const { hold, keep } = heldRoutes(
      new Map([['/a', 9_000]]),
      new Map(),
      new Map([['/a', 'pages:1']]),
      () => [],
    )
    expect([...hold]).toEqual([])
    expect([...keep]).toEqual([])
  })

  it('still holds a route back on its own stamp, without consulting any prior route', () => {
    const { hold, keep } = heldRoutes(
      new Map([['/a', 9_000]]),
      new Map([['/a', 2_000]]),
      new Map([['/a', 'pages:1']]),
      () => { throw new Error('must not need the deps index when the route has its own stamp') },
    )
    expect([...hold]).toEqual(['/a'])
    expect([...keep]).toEqual([])
  })

  // Without a deps index there is no way to discover where a record used to be published, so the rename
  // case degrades to same-route withholding rather than guessing.
  it('holds nothing extra when the record cannot be traced to a prior route', () => {
    const { hold } = heldRoutes(new Map([['/new', 9_000]]), new Map([['/old', 2_000]]), new Map(), () => [])
    expect([...hold]).toEqual([])
  })
})
