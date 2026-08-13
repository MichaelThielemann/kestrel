import { describe, it, expect } from 'vitest'
import { hasPendingChanges, pendingRoutes } from './pending'

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
