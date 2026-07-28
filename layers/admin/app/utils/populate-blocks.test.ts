import { describe, it, expect } from 'vitest'
import { collectMediaIds, populateBlocksMedia, collectLinkRefs, populateBlocksLinks } from './populate-blocks'
import type { ResolvedMedia } from './populate-blocks'

const byType = {
  hero: {
    name: 'hero',
    fields: {
      heading: { type: 'text', required: true },
      image: { type: 'media', options: { accept: 'image' } },
      cta: { type: 'link' },
    },
  },
  gallery: {
    name: 'gallery',
    fields: {
      images: { type: 'media', options: { multiple: true } },
    },
  },
  prose: {
    name: 'prose',
    fields: { body: { type: 'richtext', required: true } },
  },
  // A consumer-style block whose media/link/richtext live inside a repeater (the case the server walker
  // resolves and the preview must mirror). `grid` nests a repeater in a repeater.
  carousel: {
    name: 'carousel',
    fields: {
      items: { type: 'repeater', options: { fields: { pic: { type: 'media' }, cta: { type: 'link' }, note: { type: 'richtext' } } } },
    },
  },
  grid: {
    name: 'grid',
    fields: {
      rows: { type: 'repeater', options: { fields: { cells: { type: 'repeater', options: { fields: { pic: { type: 'media' } } } } } } },
    },
  },
} as never

const fakeMedia = (id: number): ResolvedMedia => ({ id, folder: '', alt: `alt${id}`, title: null, description: null, mime: 'image/webp', thumbhash: null, width: 10, height: 10, src: `/m/${id}.webp`, srcset: [] })
const resolveAll = (id: number) => fakeMedia(id)
const resolveNone = () => null

describe('collectMediaIds', () => {
  it('gathers single + multiple media ids and dedupes them, ignoring non-media props', () => {
    const blocks = [
      { id: 'a', type: 'hero', props: { heading: 'H', image: 5 } },
      { id: 'b', type: 'gallery', props: { images: [5, 7, 7] } },
      { id: 'c', type: 'prose', props: { body: '<p>x</p>' } },
    ]
    expect(collectMediaIds(blocks, byType).sort()).toEqual([5, 7])
  })

  it('ignores unknown block types and non-array input', () => {
    expect(collectMediaIds([{ id: 'a', type: 'mystery', props: { image: 1 } }], byType)).toEqual([])
    expect(collectMediaIds(null, byType)).toEqual([])
  })

  it('walks into slot children (any depth) to collect their media ids too', () => {
    const blocks = [
      { id: 'a', type: 'hero', props: { image: 5 }, slots: { default: [
        { id: 'b', type: 'gallery', props: { images: [7, 8] } },
        { id: 'c', type: 'hero', props: { image: 5 }, slots: { default: [
          { id: 'd', type: 'hero', props: { image: 9 } },
        ] } },
      ] } },
    ]
    expect(collectMediaIds(blocks, byType).sort((x, y) => x - y)).toEqual([5, 7, 8, 9])
  })

  it('collects media ids nested inside repeater entries, including a nested repeater', () => {
    const blocks = [
      { id: 'a', type: 'carousel', props: { items: [{ pic: 5 }, { pic: 7 }] } },
      { id: 'b', type: 'grid', props: { rows: [{ cells: [{ pic: 8 }, { pic: 9 }] }] } },
    ]
    expect(collectMediaIds(blocks, byType).sort((x, y) => x - y)).toEqual([5, 7, 8, 9])
  })
})

describe('populateBlocksMedia', () => {
  it('attaches a $media bag for a single media field, preserving other props', () => {
    const out = populateBlocksMedia([{ id: 'a', type: 'hero', props: { heading: 'H', image: 5 } }], byType, resolveAll)
    expect(out[0]).toMatchObject({ id: 'a', type: 'hero' })
    expect(out[0]!.props).toMatchObject({ heading: 'H', image: 5, $media: { image: fakeMedia(5) } })
  })

  it('resolves a multiple media field to an ordered, filtered array', () => {
    const out = populateBlocksMedia([{ id: 'b', type: 'gallery', props: { images: [5, 7] } }], byType, resolveAll)
    expect((out[0]!.props as { $media: { images: ResolvedMedia[] } }).$media.images).toEqual([fakeMedia(5), fakeMedia(7)])
  })

  it('omits unresolved media (no $media key) so the renderer shows nothing until it loads', () => {
    const out = populateBlocksMedia([{ id: 'a', type: 'hero', props: { heading: 'H', image: 5 } }], byType, resolveNone)
    expect(out[0]!.props).not.toHaveProperty('$media')
    expect(out[0]!.props).toMatchObject({ heading: 'H', image: 5 })
  })

  it('leaves media-free and unknown-type blocks untouched (no new object identity churn beyond props clone)', () => {
    const prose = { id: 'c', type: 'prose', props: { body: '<p>x</p>' } }
    const unknown = { id: 'd', type: 'mystery', props: { image: 1 } }
    const out = populateBlocksMedia([prose, unknown], byType, resolveAll)
    expect(out[0]).toBe(prose)
    expect(out[1]).toBe(unknown)
  })

  it('attaches $media to nested slot blocks too', () => {
    const out = populateBlocksMedia([
      { id: 'a', type: 'hero', props: { heading: 'H', image: 5 }, slots: { default: [
        { id: 'b', type: 'hero', props: { heading: 'N', image: 7 } },
      ] } },
    ], byType, resolveAll)
    expect((out[0]!.props as { $media: { image: ResolvedMedia } }).$media.image).toEqual(fakeMedia(5))
    const child = (out[0]!.slots as { default: { props: Record<string, unknown> }[] }).default[0]!
    expect(child.props.$media).toEqual({ image: fakeMedia(7) })
  })

  it('populates slot children even when the parent block has no media of its own', () => {
    const out = populateBlocksMedia([
      { id: 'a', type: 'prose', props: { body: '<p>x</p>' }, slots: { default: [
        { id: 'b', type: 'hero', props: { heading: 'N', image: 7 } },
      ] } },
    ], byType, resolveAll)
    const child = (out[0]!.slots as { default: { props: Record<string, unknown> }[] }).default[0]!
    expect(child.props.$media).toEqual({ image: fakeMedia(7) })
  })

  it('leaves a block with empty slots and no media untouched (by reference)', () => {
    const block = { id: 'a', type: 'prose', props: { body: 'x' }, slots: { default: [] } }
    expect(populateBlocksMedia([block], byType, resolveNone)[0]).toBe(block)
  })

  it('returns the same block reference when nothing in its slot subtree needs media', () => {
    const child = { id: 'b', type: 'prose', props: { body: 'y' } }
    const parent = { id: 'a', type: 'prose', props: { body: 'x' }, slots: { default: [child] } }
    expect(populateBlocksMedia([parent], byType, resolveAll)[0]).toBe(parent)
  })

  it('attaches $media to each repeater entry (and a nested repeater), leaving raw ids intact', () => {
    const out = populateBlocksMedia([
      { id: 'a', type: 'carousel', props: { items: [{ pic: 5 }, { pic: 7 }] } },
      { id: 'b', type: 'grid', props: { rows: [{ cells: [{ pic: 8 }] }] } },
    ], byType, resolveAll)
    const items = (out[0]!.props as { items: Array<Record<string, unknown>> }).items
    expect(items[0]).toMatchObject({ pic: 5, $media: { pic: fakeMedia(5) } })
    expect(items[1]).toMatchObject({ pic: 7, $media: { pic: fakeMedia(7) } })
    const cell = ((out[1]!.props as { rows: Array<{ cells: Array<Record<string, unknown>> }> }).rows[0].cells[0])
    expect(cell).toMatchObject({ pic: 8, $media: { pic: fakeMedia(8) } })
  })

  it('returns the block by reference when a repeater has no resolvable media', () => {
    const block = { id: 'a', type: 'carousel', props: { items: [{ pic: 5 }] } }
    expect(populateBlocksMedia([block], byType, resolveNone)[0]).toBe(block)
  })

  it('does not mutate the original repeater entries', () => {
    const entry = { pic: 5 }
    const block = { id: 'a', type: 'carousel', props: { items: [entry] } }
    populateBlocksMedia([block], byType, resolveAll)
    expect((entry as Record<string, unknown>).$media).toBeUndefined()
  })

  it('returns [] for non-array input', () => {
    expect(populateBlocksMedia(undefined, byType, resolveAll)).toEqual([])
  })
})

const fakeHref = (collection: string, id: number): string | null =>
  collection === 'pages' && id === 5 ? '/about' : collection === 'pages' && id === 6 ? '/de/x' : null

describe('collectLinkRefs', () => {
  it('gathers internal-link {collection,id} refs, dedupes, ignores external/email/tel + non-link props', () => {
    const blocks = [
      { id: 'a', type: 'hero', props: { heading: 'H', cta: { type: 'internal', collection: 'pages', id: 5 } } },
      { id: 'b', type: 'hero', props: { cta: { type: 'internal', collection: 'pages', id: 5 } } }, // dup
      { id: 'c', type: 'hero', props: { cta: { type: 'external', url: 'https://x.io' } } },
    ]
    expect(collectLinkRefs(blocks, byType)).toEqual([{ collection: 'pages', id: 5 }])
  })

  it('walks slot children and ignores unknown types / non-array input', () => {
    const blocks = [
      { id: 'a', type: 'prose', props: { body: 'x' }, slots: { default: [
        { id: 'b', type: 'hero', props: { cta: { type: 'internal', collection: 'pages', id: 6 } } },
      ] } },
      { id: 'c', type: 'mystery', props: { cta: { type: 'internal', collection: 'pages', id: 9 } } },
    ]
    expect(collectLinkRefs(blocks, byType)).toEqual([{ collection: 'pages', id: 6 }])
    expect(collectLinkRefs(null, byType)).toEqual([])
  })

  it('gathers internal-link + richtext-marker refs nested inside repeater entries', () => {
    const blocks = [{ id: 'a', type: 'carousel', props: { items: [
      { cta: { type: 'internal', collection: 'pages', id: 5 } },
      { note: '<a href="kestrel:posts:9">x</a>' },
    ] } }]
    expect(collectLinkRefs(blocks, byType)).toEqual([{ collection: 'pages', id: 5 }, { collection: 'posts', id: 9 }])
  })
})

describe('populateBlocksLinks', () => {
  it('replaces an internal link value with a cloned {...value, href}, preserving other props', () => {
    const out = populateBlocksLinks([{ id: 'a', type: 'hero', props: { heading: 'H', cta: { type: 'internal', collection: 'pages', id: 5, label: 'About' } } }], byType, fakeHref)
    expect(out[0]!.props).toEqual({ heading: 'H', cta: { type: 'internal', collection: 'pages', id: 5, label: 'About', href: '/about' } })
  })

  it('leaves external/email/tel and unresolved internal links untouched (by reference)', () => {
    const ext = { id: 'a', type: 'hero', props: { cta: { type: 'external', url: 'https://x.io' } } }
    const dangling = { id: 'b', type: 'hero', props: { cta: { type: 'internal', collection: 'pages', id: 999 } } }
    const out = populateBlocksLinks([ext, dangling], byType, fakeHref)
    expect(out[0]).toBe(ext)
    expect(out[1]).toBe(dangling)
  })

  it('resolves links inside nested slot blocks', () => {
    const out = populateBlocksLinks([
      { id: 'a', type: 'prose', props: { body: 'x' }, slots: { default: [
        { id: 'b', type: 'hero', props: { cta: { type: 'internal', collection: 'pages', id: 6 } } },
      ] } },
    ], byType, fakeHref)
    const child = (out[0]!.slots as { default: { props: Record<string, unknown> }[] }).default[0]!
    expect(child.props.cta).toEqual({ type: 'internal', collection: 'pages', id: 6, href: '/de/x' })
  })

  it('does not mutate the input and returns [] for non-array input', () => {
    const block = { id: 'a', type: 'hero', props: { cta: { type: 'internal', collection: 'pages', id: 5 } } }
    populateBlocksLinks([block], byType, fakeHref)
    expect((block.props.cta as Record<string, unknown>).href).toBeUndefined()
    expect(populateBlocksLinks(undefined, byType, fakeHref)).toEqual([])
  })

  it('collectLinkRefs also gathers refs from richtext field markers', () => {
    const blocks = [{ id: 'a', type: 'prose', props: { body: '<a href="kestrel:pages:5">A</a><a href="kestrel:posts:9">B</a>' } }]
    expect(collectLinkRefs(blocks, byType)).toEqual([{ collection: 'pages', id: 5 }, { collection: 'posts', id: 9 }])
  })

  it('resolves richtext markers in props (unresolved → #)', () => {
    const blocks = [{ id: 'a', type: 'prose', props: { body: '<a href="kestrel:pages:5">A</a> <a href="kestrel:pages:999">B</a>' } }]
    const out = populateBlocksLinks(blocks, byType, fakeHref)
    expect((out[0]!.props as { body: string }).body).toBe('<a href="/about">A</a> <a href="#">B</a>')
  })

  it('returns the block by reference when its richtext has no markers', () => {
    const block = { id: 'a', type: 'prose', props: { body: '<p>no links</p>' } }
    expect(populateBlocksLinks([block], byType, fakeHref)[0]).toBe(block)
  })

  it('resolves internal links + richtext markers inside repeater entries, leaving other props alone', () => {
    const out = populateBlocksLinks([{ id: 'a', type: 'carousel', props: { items: [
      { pic: 5, cta: { type: 'internal', collection: 'pages', id: 5 }, note: '<a href="kestrel:pages:6">n</a>' },
    ] } }], byType, fakeHref)
    const item = (out[0]!.props as { items: Array<Record<string, unknown>> }).items[0]
    expect(item.cta).toEqual({ type: 'internal', collection: 'pages', id: 5, href: '/about' })
    expect(item.note).toBe('<a href="/de/x">n</a>')
    expect(item.pic).toBe(5)
  })

  it('returns the block by reference when repeater entries need no link change', () => {
    const block = { id: 'a', type: 'carousel', props: { items: [{ cta: { type: 'external', url: 'https://x.io' } }] } }
    expect(populateBlocksLinks([block], byType, fakeHref)[0]).toBe(block)
  })
})
