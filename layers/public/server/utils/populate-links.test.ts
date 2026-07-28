import { describe, it, expect, beforeEach } from 'vitest'
import { buildLinkFieldPopulators } from './populate-links'
import { buildFieldTreePopulator } from '../../../fields/server/utils/field-populate'
import type { FieldPopulator } from '../../../core/server/utils/populate'
import { pageRowHref } from '../../../core/server/utils/page-route'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { defineBlock, registerBlock, clearBlocks } from '../../../fields/server/utils/defineBlock'
import { withReadCaptureSync } from '../../../core/server/utils/read-capture'
import { withResolveScope } from '../../../core/server/utils/resolve-scope'

beforeEach(() => clearBlocks())

// pageRowHref is the pure route builder — it is NOT where the status gate lives (that is
// `isPubliclyLinkable`/`resolveInternalHref`, which never calls this for a draft target).
describe('pageRowHref — localized route of a page-like row (unconditional; only missing/path-less rows are unresolvable)', () => {
  it('returns the localized path for a target (primary unprefixed, other-locale prefixed)', () => {
    expect(pageRowHref({ path: '/about', locale: 'en', status: 'published' }, 'en')).toBe('/about')
    expect(pageRowHref({ path: '/ueber-uns', locale: 'de', status: 'published' }, 'en')).toBe('/de/ueber-uns')
  })
  it('builds the route from a DRAFT row too — the status gate sits above it, in resolveInternalHref', () => {
    expect(pageRowHref({ path: '/about', locale: 'en', status: 'draft' }, 'en')).toBe('/about')
    expect(pageRowHref({ path: '/ueber-uns', locale: 'de', status: 'draft' }, 'en')).toBe('/de/ueber-uns')
  })
  it('returns null only for a missing row or a row with no path (→ "#")', () => {
    expect(pageRowHref(null, 'en')).toBeNull()
    expect(pageRowHref(undefined, 'en')).toBeNull()
    expect(pageRowHref({ path: null, status: 'published' }, 'en')).toBeNull()
    expect(pageRowHref({ status: 'draft' }, 'en')).toBeNull()
  })
  it('resolves a target whose table has no status column', () => {
    expect(pageRowHref({ path: '/x', locale: 'en' }, 'en')).toBe('/x')
  })
  it('falls back to the primary locale when the target row has no locale', () => {
    expect(pageRowHref({ path: '/x', status: 'published' }, 'en')).toBe('/x')
    expect(pageRowHref({ path: '/x', locale: null, status: 'draft' }, 'en')).toBe('/x')
  })
})

// Fake href resolver: the localized path is the resolver's job (it reads the target row's own locale),
// so the builder is tested purely on carrying through whatever the resolver returns.
const fakeResolve = (collection: string, id: number): string | null => {
  if (collection !== 'pages') return null
  if (id === 5) return '/about' // primary-locale target → unprefixed
  if (id === 6) return '/de/ueber-uns' // other-locale target → prefixed
  return null // dangling / unknown
}

// The link + richtext field populators run under the shared field-tree walker (repeater/block descent for
// free), exactly as the public plugin wires them via the global registry.
const { link: linkPop, richtext: richtextPop } = buildLinkFieldPopulators(fakeResolve)
const lookup = (type: string): FieldPopulator | undefined =>
  type === 'link' ? linkPop : type === 'richtext' ? richtextPop : undefined
const populate = buildFieldTreePopulator(lookup)

describe('link + richtext field populators (under the field-tree walker)', () => {
  it('attaches href to an internal link on a top-level field (primary + prefixed paths)', () => {
    const def = defineCollection({
      name: 'pages', mode: 'multi', translatable: false,
      fields: { cta: { type: 'link' }, alt: { type: 'link' } },
    })
    const out = populate({
      id: 1,
      cta: { type: 'internal', collection: 'pages', id: 5, label: 'About' },
      alt: { type: 'internal', collection: 'pages', id: 6 },
    }, { depth: 1, locale: 'en', def })
    expect(out.cta).toEqual({ type: 'internal', collection: 'pages', id: 5, label: 'About', href: '/about' })
    expect(out.alt).toEqual({ type: 'internal', collection: 'pages', id: 6, href: '/de/ueber-uns' })
  })

  it('passes external / email / tel links through untouched (no href)', () => {
    const def = defineCollection({
      name: 'pages', mode: 'multi', translatable: false,
      fields: { ext: { type: 'link' }, mail: { type: 'link' }, phone: { type: 'link' } },
    })
    const out = populate({
      id: 1,
      ext: { type: 'external', url: 'https://example.com' },
      mail: { type: 'email', email: 'a@b.c' },
      phone: { type: 'tel', tel: '+49123' },
    }, { depth: 1, locale: 'en', def })
    expect(out.ext).toEqual({ type: 'external', url: 'https://example.com' })
    expect(out.mail).toEqual({ type: 'email', email: 'a@b.c' })
    expect(out.phone).toEqual({ type: 'tel', tel: '+49123' })
  })

  it('leaves an unresolvable internal link without an href (renders "#")', () => {
    const def = defineCollection({
      name: 'pages', mode: 'multi', translatable: false,
      fields: { cta: { type: 'link' } },
    })
    const out = populate({ id: 1, cta: { type: 'internal', collection: 'posts', id: 999 } }, { depth: 1, locale: 'en', def })
    expect(out.cta).toEqual({ type: 'internal', collection: 'posts', id: 999 })
  })

  it('resolves an internal link inside block props', () => {
    registerBlock(defineBlock({ name: 'hero', fields: { heading: { type: 'text' }, cta: { type: 'link' } } }))
    const def = defineCollection({ name: 'pages', mode: 'multi', translatable: false, blocks: { enabled: true }, fields: {} })
    const out = populate({
      id: 1,
      content: [{ id: 'a', type: 'hero', props: { heading: 'H', cta: { type: 'internal', collection: 'pages', id: 5 } } }],
    }, { depth: 1, locale: 'en', def })
    const node = (out.content as Array<{ props: Record<string, unknown> }>)[0]
    expect(node.props.cta).toEqual({ type: 'internal', collection: 'pages', id: 5, href: '/about' })
  })

  it('resolves an internal link inside a nested slot block', () => {
    registerBlock(defineBlock({ name: 'cta', fields: { link: { type: 'link' } } }))
    const def = defineCollection({ name: 'pages', mode: 'multi', translatable: false, blocks: { enabled: true }, fields: {} })
    const out = populate({
      id: 1,
      content: [{
        id: 'sec', type: 'section',
        slots: { default: [{ id: 'a', type: 'cta', props: { link: { type: 'internal', collection: 'pages', id: 6 } } }] },
      }],
    }, { depth: 1, locale: 'en', def })
    const nested = (out.content as Array<{ slots: { default: Array<{ props: Record<string, unknown> }> } }>)[0].slots.default[0]
    expect(nested.props.link).toEqual({ type: 'internal', collection: 'pages', id: 6, href: '/de/ueber-uns' })
  })

  it('resolves an internal link + richtext marker inside a REPEATER (top-level and block props) — the closed gap', () => {
    registerBlock(defineBlock({ name: 'grid', fields: { cells: { type: 'repeater', options: { fields: { cta: { type: 'link' } } } } } }))
    const def = defineCollection({
      name: 'pages', mode: 'multi', translatable: false, blocks: { enabled: true },
      fields: { rows: { type: 'repeater', options: { fields: { cta: { type: 'link' }, body: { type: 'richtext' } } } } },
    })
    const out = populate({
      id: 1,
      rows: [{ cta: { type: 'internal', collection: 'pages', id: 5 }, body: '<a href="kestrel:pages:6">x</a>' }],
      content: [{ id: 'g', type: 'grid', props: { cells: [{ cta: { type: 'internal', collection: 'pages', id: 6 } }] } }],
    }, { depth: 1, locale: 'en', def })
    const rows = out.rows as Array<Record<string, unknown>>
    expect(rows[0].cta).toEqual({ type: 'internal', collection: 'pages', id: 5, href: '/about' })
    expect(rows[0].body).toBe('<a href="/de/ueber-uns">x</a>')
    const cells = ((out.content as Array<{ props: Record<string, unknown> }>)[0].props.cells) as Array<Record<string, unknown>>
    expect(cells[0].cta).toEqual({ type: 'internal', collection: 'pages', id: 6, href: '/de/ueber-uns' })
  })

  it('does not mutate the original input row or content nodes', () => {
    registerBlock(defineBlock({ name: 'hero', fields: { cta: { type: 'link' } } }))
    const def = defineCollection({ name: 'pages', mode: 'multi', translatable: false, blocks: { enabled: true }, fields: { cta: { type: 'link' } } })
    const node = { id: 'a', type: 'hero', props: { cta: { type: 'internal', collection: 'pages', id: 5 } } }
    const row = { id: 1, cta: { type: 'internal', collection: 'pages', id: 5 }, content: [node] }
    populate(row, { depth: 1, locale: 'en', def })
    expect((row.cta as Record<string, unknown>).href).toBeUndefined()
    expect((node.props.cta as Record<string, unknown>).href).toBeUndefined()
  })

  it('resolves internal-link markers inside a richtext field', () => {
    const def = defineCollection({
      name: 'pages', mode: 'multi', translatable: false,
      fields: { body: { type: 'richtext' } },
    })
    const out = populate(
      { id: 1, body: '<p>See <a href="kestrel:pages:5">About</a> and <a href="kestrel:posts:99">gone</a>.</p>' },
      { depth: 1, locale: 'en', def },
    )
    expect(out.body).toBe('<p>See <a href="/about">About</a> and <a href="#">gone</a>.</p>')
  })

  it('captures every internal link target as a read dep (link + richtext), so a slug change re-renders the referrer', () => {
    registerBlock(defineBlock({ name: 'prose', fields: { body: { type: 'richtext' } } }))
    const def = defineCollection({
      name: 'pages', mode: 'multi', translatable: false, blocks: { enabled: true },
      fields: { cta: { type: 'link' }, body: { type: 'richtext' } },
    })
    const { tags } = withReadCaptureSync(() => populate({
      id: 1,
      cta: { type: 'internal', collection: 'pages', id: 5 },
      body: '<a href="kestrel:pages:6">x</a>',
      content: [{ id: 'p', type: 'prose', props: { body: '<a href="kestrel:pages:5">y</a>' } }],
    }, { depth: 1, locale: 'en', def }))
    expect(tags.sort()).toEqual(['pages:5', 'pages:6'])
  })

  it('captures the dep on a memo HIT too (a second page embedding the same link)', () => {
    const def = defineCollection({
      name: 'pages', mode: 'multi', translatable: false,
      fields: { cta: { type: 'link' }, body: { type: 'richtext' } },
    })
    withResolveScope(() => {
      const first = withReadCaptureSync(() => populate({ id: 1, cta: { type: 'internal', collection: 'pages', id: 5 } }, { depth: 1, locale: 'en', def }))
      expect(first.tags).toEqual(['pages:5'])
      // The resolver is memoized per scope; the second page never calls it, yet must record the same dep.
      const second = withReadCaptureSync(() => populate({ id: 2, cta: { type: 'internal', collection: 'pages', id: 5 }, body: '<a href="kestrel:pages:5">y</a>' }, { depth: 1, locale: 'en', def }))
      expect(second.tags).toEqual(['pages:5'])
    })
  })

  it('captures a DANGLING/draft internal target too, so the `<coll>:<id>` tag a publish emits re-renders the referrer that baked "#"', () => {
    const def = defineCollection({ name: 'pages', mode: 'multi', translatable: false, fields: { cta: { type: 'link' } } })
    const { tags } = withReadCaptureSync(() => populate({ id: 1, cta: { type: 'internal', collection: 'posts', id: 999 } }, { depth: 1, locale: 'en', def }))
    expect(tags).toEqual(['posts:999'])
  })

  it('captures nothing for external / email / tel links and plain richtext', () => {
    const def = defineCollection({
      name: 'pages', mode: 'multi', translatable: false,
      fields: { ext: { type: 'link' }, body: { type: 'richtext' } },
    })
    const { tags } = withReadCaptureSync(() => populate(
      { id: 1, ext: { type: 'external', url: 'https://example.com' }, body: '<p>plain <a href="/x">y</a></p>' },
      { depth: 1, locale: 'en', def },
    ))
    expect(tags).toEqual([])
  })

  it('resolves richtext markers inside block props', () => {
    registerBlock(defineBlock({ name: 'prose', fields: { body: { type: 'richtext' } } }))
    const def = defineCollection({ name: 'pages', mode: 'multi', translatable: false, blocks: { enabled: true }, fields: {} })
    const out = populate(
      { id: 1, content: [{ id: 'p', type: 'prose', props: { body: '<a href="kestrel:pages:6">x</a>' } }] },
      { depth: 1, locale: 'en', def },
    )
    const node = (out.content as Array<{ props: Record<string, unknown> }>)[0]
    expect(node!.props.body).toBe('<a href="/de/ueber-uns">x</a>')
  })
})
