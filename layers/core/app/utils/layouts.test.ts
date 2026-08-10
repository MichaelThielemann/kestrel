import { describe, it, expect } from 'vitest'
import { offerableLayouts, layoutSelectOptions, renderLayoutRegistry, ADMIN_LAYOUT } from './layouts'

// Shape of Nuxt's resolved `app.layouts` (name → { name, file }).
const map = (...entries: [string, string][]) =>
  Object.fromEntries(entries.map(([name, file]) => [name, { name, file }]))

describe('offerableLayouts', () => {
  it('offers the consumer layouts plus default, sorted', () => {
    expect(offerableLayouts(map(
      ['marketing', '/p/app/layouts/marketing.vue'],
      ['default', '/p/app/layouts/default.vue'],
      ['bare', '/p/app/layouts/bare.vue'],
    ))).toEqual(['bare', 'default', 'marketing'])
  })

  it('never offers the admin shell — a public page rendered in it would be nonsense', () => {
    expect(offerableLayouts(map(
      ['default', '/e/layers/public/app/layouts/default.vue'],
      [ADMIN_LAYOUT, '/e/layers/admin/app/layouts/admin.vue'],
    ))).toEqual(['default'])
  })

  it('keeps only .vue files', () => {
    expect(offerableLayouts(map(
      ['default', '/p/app/layouts/default.vue'],
      ['helper', '/p/app/layouts/helper.ts'],
    ))).toEqual(['default'])
  })

  it('returns [] for an empty map rather than inventing a name', () => {
    expect(offerableLayouts({})).toEqual([])
  })

  it('tolerates a malformed entry instead of throwing during a build', () => {
    const dirty = { default: { name: 'default', file: '/p/app/layouts/default.vue' }, broken: undefined }
    expect(offerableLayouts(dirty as never)).toEqual(['default'])
  })
})

describe('renderLayoutRegistry', () => {
  it('renders a module body the client bundle can import', () => {
    expect(renderLayoutRegistry(['bare', 'default'])).toBe('export const kestrelLayouts = ["bare","default"]\n')
  })
  it('renders an empty list without emitting `undefined`', () => {
    expect(renderLayoutRegistry([])).toBe('export const kestrelLayouts = []\n')
  })
})

describe('layoutSelectOptions', () => {
  const label = 'Standard (default)'

  it('offers the fallback as one empty-valued entry, and never a duplicate `default`', () => {
    // An unset column already means `default`, so listing `default` as its own value would give the editor
    // two controls for one outcome — and pin the row to a name a consumer may later rename.
    expect(layoutSelectOptions(['bare', 'default', 'marketing'], label)).toEqual([
      { label, value: '' },
      { label: 'bare', value: 'bare' },
      { label: 'marketing', value: 'marketing' },
    ])
  })

  it('collapses to the single fallback entry when `default` is all there is', () => {
    expect(layoutSelectOptions(['default'], label)).toEqual([{ label, value: '' }])
  })

  it('yields only the fallback entry for an empty list', () => {
    expect(layoutSelectOptions([], label)).toEqual([{ label, value: '' }])
  })
})
