import { describe, it, expect } from 'vitest'
import { referencedGalleryIds } from './gallery-ownership'

const ID1 = '11111111-1111-1111-1111-111111111111'
const ID2 = '22222222-2222-2222-2222-222222222222'
const ref = (galleryId: string) => ({ v: 2, galleryId, saltB64: 's', verify: { iv: 'i', data: 'd' } })

// A fake DB: select().from(table).all() returns the rows registered for that table, and records which
// tables were actually read (the scan must skip whole collections that can't hold a gallery at all).
function fakeDb(rowsByTable: Map<unknown, Record<string, unknown>[]>, read: unknown[] = []) {
  return { select: () => ({ from: (table: unknown) => { read.push(table); return { all: () => rowsByTable.get(table) ?? [] } } }) }
}
const coll = (name: string, fields: Record<string, { type: string }>, table: unknown, blocks?: { enabled: true }) =>
  ({ def: { name, fields, blocks }, table })

describe('referencedGalleryIds — galleryIds still owned by a live row', () => {
  it('collects galleryIds from every secureGallery field across collections (deduped)', () => {
    const galT = {}, otherT = {}
    const rows = new Map<unknown, Record<string, unknown>[]>([
      [galT, [{ gallery: ref(ID1) }, { gallery: ref(ID1) }, { gallery: ref(ID2) }]], // ID1 shared by two rows
      [otherT, [{ title: 'x' }]],
    ])
    const collections = [
      coll('galleries', { gallery: { type: 'secureGallery' }, title: { type: 'text' } }, galT),
      coll('posts', { title: { type: 'text' } }, otherT), // no secureGallery field → skipped
    ]
    expect(referencedGalleryIds(fakeDb(rows) as never, collections as never)).toEqual(new Set([ID1, ID2]))
  })

  it('handles multiple secureGallery fields on one collection + ignores null/invalid values', () => {
    const t = {}
    const rows = new Map<unknown, Record<string, unknown>[]>([
      [t, [{ a: ref(ID1), b: null }, { a: undefined, b: ref(ID2) }, { a: { galleryId: 'not-a-uuid' }, b: 'x' }]],
    ])
    const collections = [coll('g', { a: { type: 'secureGallery' }, b: { type: 'secureGallery' } }, t)]
    expect(referencedGalleryIds(fakeDb(rows) as never, collections as never)).toEqual(new Set([ID1, ID2]))
  })

  it('returns an empty set when nothing references a gallery', () => {
    const t = {}
    const collections = [coll('g', { gallery: { type: 'secureGallery' } }, t)]
    expect(referencedGalleryIds(fakeDb(new Map()) as never, collections as never)).toEqual(new Set())
  })

  it('finds a gallery declared on a BLOCK (content JSON column), not just a top-level secureGallery field', () => {
    const t = {}
    const rows = new Map<unknown, Record<string, unknown>[]>([
      [t, [{ title: 'x', content: [{ id: 'b1', type: 'myGallery', props: { gallery: ref(ID1) } }] }]],
    ])
    // no top-level secureGallery field — the ref lives in the block tree
    const collections = [coll('pages', { title: { type: 'text' } }, t, { enabled: true })]
    expect(referencedGalleryIds(fakeDb(rows) as never, collections as never)).toEqual(new Set([ID1]))
  })

  // This runs on every gallery write event, so a collection that can hold no gallery ref at all — no
  // secureGallery field, no block tree — must not cost a full table read.
  it('never reads a collection that can hold neither a secureGallery field nor a block tree', () => {
    const galT = {}, plainT = {}
    const read: unknown[] = []
    const rows = new Map<unknown, Record<string, unknown>[]>([[galT, [{ gallery: ref(ID1) }]], [plainT, [{ title: 'x' }]]])
    const collections = [
      coll('galleries', { gallery: { type: 'secureGallery' } }, galT),
      coll('posts', { title: { type: 'text' } }, plainT),
    ]
    expect(referencedGalleryIds(fakeDb(rows, read) as never, collections as never)).toEqual(new Set([ID1]))
    expect(read).toEqual([galT])
  })
})
