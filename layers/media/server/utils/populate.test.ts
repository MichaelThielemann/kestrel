import { describe, it, expect, beforeEach } from 'vitest'
import { buildMediaFieldPopulator } from './populate'
import { buildFieldTreePopulator } from '../../../fields/server/utils/field-populate'
import type { FieldPopulator } from '../../../core/server/utils/populate'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { defineBlock, registerBlock, clearBlocks } from '../../../fields/server/utils/defineBlock'
import { withReadCapture } from '../../../core/server/utils/read-capture'
import type { ResolvedMedia } from './resolve'

beforeEach(() => clearBlocks())

const fakeResolve = (id: number, _locale: string): ResolvedMedia | null =>
  id === 999 ? null : ({ id, src: `/u/${id}.jpg` } as ResolvedMedia)

// The media field populator runs under the shared field-tree walker (repeater/block descent for free),
// exactly as the media plugin wires it via the global registry.
const mediaLookup = (type: string): FieldPopulator | undefined =>
  type === 'media' ? buildMediaFieldPopulator(fakeResolve) : undefined
const populate = buildFieldTreePopulator(mediaLookup)

describe('media field populator (under the field-tree walker)', () => {
  it('attaches collection media fields under $media (raw ids untouched)', () => {
    const def = defineCollection({
      name: 'posts', mode: 'multi', translatable: false,
      fields: { cover: { type: 'media' }, gallery: { type: 'media', options: { multiple: true } } },
    })
    const out = populate({ id: 1, coverId: 7, gallery: [2, 3] }, { depth: 1, locale: 'en', def })
    expect(out.coverId).toBe(7)
    expect((out.$media as Record<string, unknown>).cover).toEqual({ id: 7, src: '/u/7.jpg' })
    expect((out.$media as Record<string, unknown>).gallery).toEqual([{ id: 2, src: '/u/2.jpg' }, { id: 3, src: '/u/3.jpg' }])
  })

  it('resolves media props inside block content + tolerates a dangling id', () => {
    registerBlock(defineBlock({ name: 'hero', fields: { heading: { type: 'text' }, image: { type: 'media' } } }))
    const def = defineCollection({ name: 'pages', mode: 'multi', translatable: false, blocks: { enabled: true }, fields: {} })
    const out = populate({
      id: 1,
      content: [
        { id: 'a', type: 'hero', props: { heading: 'H', image: 5 } },
        { id: 'b', type: 'hero', props: { heading: 'X', image: 999 } },
      ],
    }, { depth: 1, locale: 'en', def })
    const content = out.content as Array<{ props: Record<string, unknown> }>
    expect((content[0].props.$media as Record<string, unknown>).image).toEqual({ id: 5, src: '/u/5.jpg' })
    expect((content[1].props.$media as Record<string, unknown>).image).toBeNull()
  })

  it('resolves media nested inside a REPEATER — top-level and inside block props (the closed gap)', () => {
    registerBlock(defineBlock({ name: 'gallery', fields: { items: { type: 'repeater', options: { fields: { pic: { type: 'media' } } } } } }))
    const def = defineCollection({
      name: 'pages', mode: 'multi', translatable: false, blocks: { enabled: true },
      fields: { logos: { type: 'repeater', options: { fields: { logo: { type: 'media' } } } } },
    })
    const out = populate({
      id: 1,
      logos: [{ logo: 4 }, { logo: 6 }],
      content: [{ id: 'a', type: 'gallery', props: { items: [{ pic: 8 }] } }],
    }, { depth: 1, locale: 'en', def })
    const logos = out.logos as Array<Record<string, unknown>>
    expect((logos[0].$media as Record<string, unknown>).logo).toEqual({ id: 4, src: '/u/4.jpg' })
    expect((logos[1].$media as Record<string, unknown>).logo).toEqual({ id: 6, src: '/u/6.jpg' })
    const items = ((out.content as Array<{ props: Record<string, unknown> }>)[0].props.items) as Array<Record<string, unknown>>
    expect((items[0].$media as Record<string, unknown>).pic).toEqual({ id: 8, src: '/u/8.jpg' })
  })

  it('captures a media:<id> read dep for every embedded media so the publisher re-renders on a media change', async () => {
    registerBlock(defineBlock({ name: 'hero', fields: { image: { type: 'media' } } }))
    const def = defineCollection({
      name: 'posts', mode: 'multi', translatable: false, blocks: { enabled: true },
      fields: { cover: { type: 'media' }, gallery: { type: 'media', options: { multiple: true } } },
    })
    const { tags } = await withReadCapture(async () => {
      populate({ id: 1, coverId: 7, gallery: [2, 3], content: [{ id: 'a', type: 'hero', props: { image: 8 } }] }, { depth: 1, locale: 'en', def })
    })
    expect(new Set(tags)).toEqual(new Set(['media:7', 'media:2', 'media:3', 'media:8']))
  })

  it('resolves the seo social image (seo.image) under seo.$media — non-destructively, with a read dep', async () => {
    const def = defineCollection({
      name: 'pages', mode: 'multi', translatable: false, pageLike: true, seo: true, fields: {},
    })
    const seo = { title: 'T', image: 7 }
    const row = { id: 1, seo }
    const { tags, result } = await withReadCapture(async () => populate(row, { depth: 1, locale: 'en', def }))
    const out = result as Record<string, unknown>
    const outSeo = out.seo as Record<string, unknown>
    expect((outSeo.$media as Record<string, unknown>).image).toEqual({ id: 7, src: '/u/7.jpg' })
    expect(outSeo.image).toBe(7) // raw id untouched
    expect(tags).toContain('media:7')
    expect((seo as Record<string, unknown>).$media).toBeUndefined() // original seo bag untouched
    // a dangling id resolves to null; a seo-less row and a seo:false collection stay untouched
    const dangling = populate({ id: 2, seo: { image: 999 } }, { depth: 1, locale: 'en', def }) as Record<string, unknown>
    expect(((dangling.seo as Record<string, unknown>).$media as Record<string, unknown>).image).toBeNull()
    expect((populate({ id: 3 }, { depth: 1, locale: 'en', def }) as Record<string, unknown>).seo).toBeUndefined()
    const noSeo = defineCollection({ name: 'plain', mode: 'multi', translatable: false, fields: {} })
    const untouched = populate({ id: 4, seo: { image: 5 } }, { depth: 1, locale: 'en', def: noSeo }) as Record<string, unknown>
    expect((untouched.seo as Record<string, unknown>).$media).toBeUndefined()
  })

  it('does not mutate the original input row, content nodes, or repeater entries', () => {
    registerBlock(defineBlock({ name: 'hero', fields: { image: { type: 'media' } } }))
    const def = defineCollection({
      name: 'pages', mode: 'multi', translatable: false, blocks: { enabled: true },
      fields: { logos: { type: 'repeater', options: { fields: { logo: { type: 'media' } } } } },
    })
    const node = { id: 'a', type: 'hero', props: { image: 5 } }
    const entry = { logo: 4 }
    const row = { id: 1, logos: [entry], content: [node] }
    populate(row, { depth: 1, locale: 'en', def })
    expect((node.props as Record<string, unknown>).$media).toBeUndefined()
    expect((entry as Record<string, unknown>).$media).toBeUndefined()
    expect((row as Record<string, unknown>).$media).toBeUndefined()
  })
})
