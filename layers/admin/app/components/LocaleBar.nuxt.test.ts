import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import LocaleBar from './LocaleBar.vue'

describe('LocaleBar', () => {
  it('multi: marks the active locale and offers a "+" create link for a missing translation', async () => {
    const w = await mountSuspended(LocaleBar, {
      props: { collection: 'posts', id: '5', mode: 'multi', current: 'en', translations: { en: 5, de: null }, group: 'grp1' },
    })
    expect(w.find('.locale-bar__item--active').text()).toContain('EN')
    const add = w.find('.locale-bar__btn--add')
    expect(add.exists()).toBe(true)
    expect(add.attributes('href')).toBe('/admin/posts/new?locale=de&group=grp1')
  })

  it('multi: an existing sibling gets an edit link plus a copy button that emits copyFrom', async () => {
    const w = await mountSuspended(LocaleBar, {
      props: { collection: 'posts', id: '5', mode: 'multi', current: 'en', translations: { en: 5, de: 12 }, group: 'grp1' },
    })
    expect(w.findAll('a').some((a) => a.attributes('href') === '/admin/posts/12?locale=de')).toBe(true)
    expect(w.find('.locale-bar__btn--add').exists()).toBe(false)
    const copy = w.find('.locale-bar__btn--copy')
    expect(copy.exists()).toBe(true)
    await copy.trigger('click')
    expect(w.emitted('copyFrom')![0]).toEqual(['de'])
  })

  it('single: other locales switch via the ?locale query', async () => {
    const w = await mountSuspended(LocaleBar, {
      props: { collection: 'settings', id: 'single', mode: 'single', current: 'en', translations: {} },
    })
    expect(w.findAll('a').some((a) => a.attributes('href') === '/admin/settings?locale=de')).toBe(true)
    expect(w.find('.locale-bar__btn--copy').exists()).toBe(false)
  })
})
