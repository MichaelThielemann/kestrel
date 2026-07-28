import { describe, it, expect } from 'vitest'
import { planGalleryDeletion } from './gallery-cleanup'

const ID1 = '11111111-1111-1111-1111-111111111111'
const ID2 = '22222222-2222-2222-2222-222222222222'
const def = { name: 'galleries', fields: { title: { type: 'text' }, gallery: { type: 'secureGallery' } } }
// A collection whose gallery lives on a BLOCK instead of a top-level field (the README's own recipe).
const blockDef = { name: 'pages', fields: { title: { type: 'text' } }, blocks: { enabled: true } }
const ref = (galleryId: string) => ({ v: 2, galleryId, saltB64: 's', verify: { iv: 'i', data: 'd' } })

describe('planGalleryDeletion', () => {
  it('record delete → the held gallery id', () => {
    expect(planGalleryDeletion({ def, before: { gallery: ref(ID1) }, after: null })).toEqual([ID1])
  })

  it('gallery replaced on update → the OLD id only', () => {
    expect(planGalleryDeletion({ def, before: { gallery: ref(ID1) }, after: { gallery: ref(ID2) } })).toEqual([ID1])
  })

  it('gallery cleared on update → the old id', () => {
    expect(planGalleryDeletion({ def, before: { gallery: ref(ID1) }, after: { gallery: null } })).toEqual([ID1])
  })

  it('unchanged gallery on update → nothing', () => {
    expect(planGalleryDeletion({ def, before: { gallery: ref(ID1) }, after: { gallery: ref(ID1) } })).toEqual([])
  })

  it('create (no before) → nothing', () => {
    expect(planGalleryDeletion({ def, before: null, after: { gallery: ref(ID1) } })).toEqual([])
  })

  it('collection without a secureGallery field → nothing', () => {
    const plain = { name: 'posts', fields: { title: { type: 'text' } } }
    expect(planGalleryDeletion({ def: plain, before: { title: 'x' }, after: null })).toEqual([])
  })

  // A gallery field declared on a BLOCK (the README's own recipe) lives in the `content` JSON column, not a
  // top-level field the def declares — the planner must find it there too, or the namespace never gets GC'd.
  it('gallery declared on a block inside content → record delete finds it', () => {
    const before = { title: 'x', content: [{ id: 'b1', type: 'myGallery', props: { gallery: ref(ID1) } }] }
    expect(planGalleryDeletion({ def: blockDef, before, after: null })).toEqual([ID1])
  })

  it('gallery nested inside a block SLOT → still found', () => {
    const before = {
      content: [{ id: 'b1', type: 'wrapper', props: {}, slots: { default: [{ id: 'b2', type: 'myGallery', props: { gallery: ref(ID1) } }] } }],
    }
    expect(planGalleryDeletion({ def: blockDef, before, after: null })).toEqual([ID1])
  })

  it('a block gallery that survives the update (unchanged) → nothing', () => {
    const content = [{ id: 'b1', type: 'myGallery', props: { gallery: ref(ID1) } }]
    expect(planGalleryDeletion({ def: blockDef, before: { content }, after: { content } })).toEqual([])
  })

  // The schema decides WHERE to look: declared secureGallery fields, plus `content` only when the collection
  // enables blocks. Anything else is left alone, so an arbitrary user-authored value can't be mistaken for a
  // gallery ref and have a namespace deleted under it.
  it('a gallery-shaped value in a plain json field is not a gallery ref', () => {
    const plain = { name: 'posts', fields: { data: { type: 'json' } } }
    expect(planGalleryDeletion({ def: plain, before: { data: ref(ID1) }, after: null })).toEqual([])
  })

  it('block content is only scanned when the collection enables blocks', () => {
    const before = { content: [{ id: 'b1', type: 'myGallery', props: { gallery: ref(ID2) } }] }
    expect(planGalleryDeletion({ def, before, after: null })).toEqual([])
  })
})
