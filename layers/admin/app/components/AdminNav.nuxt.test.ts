import { describe, it, expect, beforeEach } from 'vitest'
import { useState } from '#imports'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import AdminNav from './AdminNav.vue'

registerEndpoint('/api/collections', () => ({
  data: [
    { name: 'posts', mode: 'multi', translatable: true, pageLike: false, seo: false, status: true, blocks: { enabled: false }, label: { singular: 'Post', plural: 'Posts' }, icon: 'newspaper', fields: {} },
    { name: 'settings', mode: 'single', translatable: true, pageLike: false, seo: false, status: false, blocks: { enabled: false }, icon: 'settings', fields: {} },
    { name: 'things', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false, blocks: { enabled: false }, fields: {} },
    { name: 'media_settings', mode: 'single', translatable: false, pageLike: false, seo: false, status: false, blocks: { enabled: false }, nav: false, icon: 'sliders', fields: {} },
  ],
}))

beforeEach(() => {
  useState('kestrel-collections').value = null
})

describe('AdminNav', () => {
  it('renders one link per collection using label.plural ?? name', async () => {
    const w = await mountSuspended(AdminNav)
    const links = w.findAll('a.admin-nav__link')
    expect(links).toHaveLength(3)
    expect(links[0]!.text()).toBe('Posts')
    expect(links[0]!.attributes('href')).toBe('/admin/posts')
    expect(links[1]!.text()).toBe('settings')
    expect(links[1]!.attributes('href')).toBe('/admin/settings')
  })

  it('renders each collection icon, falling back to file-text when none is set', async () => {
    const w = await mountSuspended(AdminNav)
    const links = w.findAll('a.admin-nav__link')
    expect(links[0]!.find('svg').attributes('data-icon')).toBe('newspaper')
    expect(links[1]!.find('svg').attributes('data-icon')).toBe('settings')
    expect(links[2]!.find('svg').attributes('data-icon')).toBe('file-text')
  })

  it('hides a collection flagged nav:false (system/config singletons stay out of the content rail)', async () => {
    const w = await mountSuspended(AdminNav)
    const hrefs = w.findAll('a.admin-nav__link').map((l) => l.attributes('href'))
    expect(hrefs).not.toContain('/admin/media_settings')
    expect(hrefs).toHaveLength(3) // media_settings is filtered out, the other three remain
  })
})
