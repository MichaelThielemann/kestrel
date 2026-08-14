import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SeoFields from './SeoFields.vue'

describe('SeoFields', () => {
  it('renders a Google-style preview using the meta title/description, with the page title as fallback', async () => {
    const w = await mountSuspended(SeoFields, {
      props: { value: {}, pageTitle: 'Home', path: '/about', locale: 'en' },
    })
    const preview = w.find('.seo-preview')
    expect(preview.exists()).toBe(true)
    // No meta title yet → falls back to the page title
    expect(w.find('.seo-preview__title').text()).toBe('Home')
    // The preview URL reflects the page path
    expect(w.find('.seo-preview__url').text()).toContain('/about')
  })

  it('prefers the meta title/description over the fallbacks in the preview', async () => {
    const w = await mountSuspended(SeoFields, {
      props: { value: { title: 'Meta Title', description: 'Meta description here' }, pageTitle: 'Home', path: '/about', locale: 'en' },
    })
    expect(w.find('.seo-preview__title').text()).toBe('Meta Title')
    expect(w.find('.seo-preview__desc').text()).toContain('Meta description here')
  })

  it('emits a merged seo object when the meta title changes', async () => {
    const w = await mountSuspended(SeoFields, {
      props: { value: { description: 'keep me' }, pageTitle: 'Home', path: '/', locale: 'en' },
    })
    const input = w.find('.seo-fields__title input')
    expect(input.exists()).toBe(true)
    await input.setValue('New meta title')
    const emitted = w.emitted('update')
    expect(emitted).toBeTruthy()
    expect(emitted!.at(-1)![0]).toEqual({ description: 'keep me', title: 'New meta title' })
  })

  // Article metadata is opt-in (`kestrel.seo.articleMeta`): some installations must not attribute content
  // at all, so the fields are not even offered until the consumer turns the flag on.
  it('offers no article metadata fields by default', async () => {
    const w = await mountSuspended(SeoFields, {
      props: { value: { author: 'Ada' }, pageTitle: 'Home', path: '/', locale: 'en' },
    })
    expect(w.find('.seo-fields__author').exists()).toBe(false)
    expect(w.find('.seo-fields__published').exists()).toBe(false)
    expect(w.find('.seo-fields__keywords').exists()).toBe(false)
    // a value already stored stays stored — it is only hidden, never cleared
    expect(w.emitted('update')).toBeUndefined()
  })

  it('offers author, publication date and keywords when articleMeta is on', async () => {
    const w = await mountSuspended(SeoFields, {
      props: { value: {}, pageTitle: 'Home', path: '/', locale: 'en', articleMeta: true },
    })
    expect(w.find('.seo-fields__author input').exists()).toBe(true)
    expect(w.find('.seo-fields__keywords input').exists()).toBe(true)
    // the date picker is a teleported widget — happy-dom renders no teleport, so smoke-test its presence
    expect(w.find('.seo-fields__published').exists()).toBe(true)
  })

  it('emits the merged object when an article field changes', async () => {
    const w = await mountSuspended(SeoFields, {
      props: { value: { title: 'keep me' }, pageTitle: 'Home', path: '/', locale: 'en', articleMeta: true },
    })
    await w.find('.seo-fields__author input').setValue('Ada Lovelace')
    expect(w.emitted('update')!.at(-1)![0]).toEqual({ title: 'keep me', author: 'Ada Lovelace' })
    await w.find('.seo-fields__keywords input').setValue('math, notes')
    expect(w.emitted('update')!.at(-1)![0]).toMatchObject({ keywords: 'math, notes' })
  })

  it('toggles noindex through the merged object', async () => {
    const w = await mountSuspended(SeoFields, {
      props: { value: {}, pageTitle: 'Home', path: '/', locale: 'en' },
    })
    const box = w.find('.seo-fields__noindex input[type=checkbox]')
    expect(box.exists()).toBe(true)
    await box.setValue(true)
    expect(w.emitted('update')!.at(-1)![0]).toMatchObject({ noindex: true })
  })
})
