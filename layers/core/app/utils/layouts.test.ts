import { describe, it, expect } from 'vitest'
import { offerableLayouts, ADMIN_LAYOUT } from './layouts'

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
