import { describe, it, expect } from 'vitest'
import { mediaStorageKeys, planMediaDeletion } from './media-cleanup'
import type { WriteEvent } from '../../../core/server/utils/write-events'

const mediaRow = {
  id: 5,
  storageKey: 'uploads/2026/pic.jpg',
  derivatives: {
    '320.webp': { key: 'uploads/2026/pic-320.webp', width: 320, height: 200, mime: 'image/webp' },
    '640.webp': { key: 'uploads/2026/pic-640.webp', width: 640, height: 400, mime: 'image/webp' },
  },
}

describe('mediaStorageKeys', () => {
  it('returns the original + every derivative key (the webp ladder)', () => {
    expect(mediaStorageKeys(mediaRow)).toEqual([
      'uploads/2026/pic.jpg', 'uploads/2026/pic-320.webp', 'uploads/2026/pic-640.webp',
    ])
  })
  it('returns just the original when there are no derivatives', () => {
    expect(mediaStorageKeys({ storageKey: 'a/b.png', derivatives: null })).toEqual(['a/b.png'])
    expect(mediaStorageKeys({ storageKey: 'a/b.png' })).toEqual(['a/b.png'])
    expect(mediaStorageKeys({ storageKey: 'a/b.png', derivatives: {} })).toEqual(['a/b.png'])
  })
  it('returns [] when the row has no storageKey, and skips malformed derivative entries', () => {
    expect(mediaStorageKeys({})).toEqual([])
    expect(mediaStorageKeys({ storageKey: 'a.png', derivatives: { x: { width: 1 }, y: { key: '' }, z: { key: 'a-1.webp' } } }))
      .toEqual(['a.png', 'a-1.webp'])
  })
})

const ev = (over: Partial<WriteEvent>): WriteEvent =>
  ({ def: { name: 'media' } as unknown as WriteEvent['def'], before: null, after: null, ...over })

describe('planMediaDeletion', () => {
  it('on a media DELETE → original + all derivatives (covers the generic CRUD delete path)', () => {
    expect(planMediaDeletion(ev({ before: mediaRow, after: null }))).toEqual([
      'uploads/2026/pic.jpg', 'uploads/2026/pic-320.webp', 'uploads/2026/pic-640.webp',
    ])
  })
  it('ignores a media create (before null) and a media update (after non-null) — only deletes GC storage', () => {
    expect(planMediaDeletion(ev({ before: null, after: mediaRow }))).toEqual([])
    expect(planMediaDeletion(ev({ before: mediaRow, after: { ...mediaRow } }))).toEqual([])
  })
  it('ignores deletes of any other collection', () => {
    expect(planMediaDeletion(ev({ def: { name: 'posts' } as unknown as WriteEvent['def'], before: { storageKey: 'x' }, after: null }))).toEqual([])
  })
})
