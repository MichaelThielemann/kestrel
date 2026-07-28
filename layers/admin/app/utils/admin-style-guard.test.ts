import { describe, it, expect } from 'vitest'
import { isProtectedStyle } from './admin-style-guard'

const p = (devId = '', href = '', dc = false) => isProtectedStyle(devId, href, dc)

describe('isProtectedStyle', () => {
  it('protects Kestrel core layer sheets (source repo or node_modules)', () => {
    expect(p('/app/node_modules/kestrel/layers/admin/app/components/Rail.vue?vue&type=style')).toBe(true)
    expect(p('/home/me/kestrel/layers/ui/app/components/ui/Dialog.vue?vue&type=style')).toBe(true)
  })
  it('protects Kestrel EXTENSION admin widgets (kestrel-* packages) — the regression this fixes', () => {
    expect(p('/app/node_modules/kestrel-galleries-secure/app/components/field/SecureGallery.vue?vue&type=style&scoped=abc123&lang.css')).toBe(true)
  })
  it('protects any component-scoped Vue style, incl. a CONSUMER custom field widget', () => {
    expect(p('/my-site/app/components/fields/StarRating.vue?vue&type=style&index=0&scoped=deadbe&lang.css')).toBe(true)
  })
  it('protects a node explicitly tagged data-kestrel', () => {
    expect(p('/anything.css', '', true)).toBe(true)
  })
  it('still disables a consumer’s foreign global CSS (unscoped public reset / plain stylesheet)', () => {
    expect(p('/my-site/app/assets/reset.css')).toBe(false)
    expect(p('/my-site/app/layouts/default.vue?vue&type=style&index=0&lang.css')).toBe(false) // unscoped
    expect(p('', 'https://cdn.example.com/normalize.css')).toBe(false)
  })
})
