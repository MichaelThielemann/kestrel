import { describe, it, expect } from 'vitest'
import { resolvePageLayout, DEFAULT_LAYOUT } from './page-layout'

describe('resolvePageLayout', () => {
  // The catch-all sets `definePageMeta({ layout: false })`, which makes `route.meta.layout` the literal
  // `false` — and `??` does not treat `false` as nullish. So an unset layout passed through as
  // `undefined`/`null`/`''` makes NuxtLayout render NO layout wrapper at all, and its `fallback` prop does
  // not rescue it (fallback only applies to a truthy name that is missing from the layout map). Every
  // empty form must therefore coalesce to a real name here.
  it('coalesces every empty form to the default layout', () => {
    for (const empty of [null, undefined, '']) expect(resolvePageLayout(empty)).toBe(DEFAULT_LAYOUT)
  })

  it('passes a selected name through', () => {
    expect(resolvePageLayout('marketing')).toBe('marketing')
  })

  it('passes an unknown name through, leaving the miss to NuxtLayout fallback', () => {
    expect(resolvePageLayout('deleted-layout')).toBe('deleted-layout')
  })

  it('ignores a non-string value rather than rendering a broken layout name', () => {
    for (const bad of [42, {}, [], true]) expect(resolvePageLayout(bad as never)).toBe(DEFAULT_LAYOUT)
  })

  it('trims incidental whitespace, which would otherwise never match a layout name', () => {
    expect(resolvePageLayout('  marketing  ')).toBe('marketing')
    expect(resolvePageLayout('   ')).toBe(DEFAULT_LAYOUT)
  })
})
