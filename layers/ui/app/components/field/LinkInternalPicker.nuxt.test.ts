import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { getQuery } from 'h3'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import LinkInternalPicker from './LinkInternalPicker.vue'
import UiCombobox from '../ui/Combobox.vue'

registerEndpoint('/api/collections', () => ({
  data: [
    { name: 'posts', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false, blocks: { enabled: false }, label: { singular: 'Post', plural: 'Posts' }, fields: {} },
    { name: 'pages', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false, blocks: { enabled: false }, label: { singular: 'Page', plural: 'Pages' }, fields: {} },
  ],
}))

registerEndpoint('/api/posts/options', (event) => {
  const q = getQuery(event)
  if (q.ids) return { data: [{ id: 1, label: 'First Post' }], total: 1 }
  if (q.search) return { data: [{ id: 2, label: 'Second Post' }], total: 1 }
  return { data: [], total: 0 }
})

registerEndpoint('/api/pages/options', (event) => {
  const q = getQuery(event)
  if (q.ids) return { data: [{ id: 5, label: 'Home' }], total: 1 }
  return { data: [], total: 0 }
})

describe('LinkInternalPicker', () => {
  it('loads collection options from /api/collections', async () => {
    const w = await mountSuspended(LinkInternalPicker, {
      props: { locale: 'en', collection: null, recordId: null },
    })
    await flushPromises()
    expect(w.html()).toContain('Posts')
    expect(w.html()).toContain('Pages')
  })

  it('filters collections to only those in the collections prop', async () => {
    const w = await mountSuspended(LinkInternalPicker, {
      props: { locale: 'en', collection: null, recordId: null, collections: ['posts'] },
    })
    await flushPromises()
    // select is hidden when only one allowed, but check the label
    expect(w.html()).not.toContain('Pages')
  })

  it('auto-selects and hides the select when only one collection is allowed', async () => {
    const w = await mountSuspended(LinkInternalPicker, {
      props: { locale: 'en', collection: null, recordId: null, collections: ['posts'] },
    })
    await flushPromises()
    expect(w.find('select').exists()).toBe(false)
    expect(w.emitted('update:collection')?.at(-1)).toEqual(['posts'])
  })

  it('wraps the collection select + record combobox in the .ui-link-internal stacking container', async () => {
    // The internal arm stacks two block controls; the .ui-link-internal wrapper carries the gap that keeps
    // them from touching. Nuxt/happy-dom applies no CSS layout, so assert the structural
    // contract: the gap-bearing wrapper exists and is the shared parent of both controls.
    const w = await mountSuspended(LinkInternalPicker, {
      props: { locale: 'en', collection: null, recordId: null }, // two collections → the select renders
    })
    await flushPromises()
    const wrap = w.find('.ui-link-internal')
    expect(wrap.exists()).toBe(true)
    expect(wrap.find('select').exists()).toBe(true)
    expect(wrap.find('.ui-combobox').exists()).toBe(true)
  })

  it('forwards the field error state to the collection select', async () => {
    const w = await mountSuspended(LinkInternalPicker, {
      props: { locale: 'en', collection: null, recordId: null, invalid: true, describedby: 'err-1' },
    })
    await flushPromises()
    const select = w.find('select')
    expect(select.attributes('aria-invalid')).toBe('true')
    expect(select.attributes('aria-describedby')).toBe('err-1')
  })

  it('emits update:recordId when a record is picked via search', async () => {
    const w = await mountSuspended(LinkInternalPicker, {
      props: { locale: 'en', collection: 'posts', recordId: null },
    })
    await flushPromises()
    await w.get('.ui-combobox__input').trigger('focus')
    await w.get('.ui-combobox__input').setValue('sec')
    await new Promise((r) => setTimeout(r, 300))
    await flushPromises()
    const items = w.findAll('.ui-combobox__item')
    expect(items.length).toBeGreaterThan(0)
    await items[0]!.trigger('click')
    expect(w.emitted('update:recordId')?.at(-1)).toEqual([2])
  })

  it('resets recordId when the user picks a different collection', async () => {
    const w = await mountSuspended(LinkInternalPicker, {
      props: { locale: 'en', collection: 'posts', recordId: 1 },
    })
    await flushPromises()
    await w.find('select').setValue('pages')
    expect(w.emitted('update:collection')?.at(-1)).toEqual(['pages'])
    expect(w.emitted('update:recordId')?.at(-1)).toEqual([null])
  })

  it('does NOT reset recordId when collection+record are updated programmatically as a pair', async () => {
    // A record loader (the editor) reseeds {collection, id} together — the picker must not
    // clobber the freshly-set id, or the link would be wiped to null.
    const w = await mountSuspended(LinkInternalPicker, {
      props: { locale: 'en', collection: 'posts', recordId: 1 },
    })
    await flushPromises()
    const before = (w.emitted('update:recordId') ?? []).length
    await w.setProps({ collection: 'pages', recordId: 7 })
    await flushPromises()
    expect((w.emitted('update:recordId') ?? []).length).toBe(before) // no auto-reset emit
  })

  it('prefills the combobox with the current record on re-edit (collection+recordId set on mount)', async () => {
    // Re-editing an existing internal link re-opens the picker with the link's {collection,id}; the
    // picker must resolve that id to its option so the combobox shows the record, not a blank field.
    // Guards the prefill end-to-end (the toolbar dom test only checks the stubbed picker gets the props).
    const w = await mountSuspended(LinkInternalPicker, {
      props: { locale: 'en', collection: 'posts', recordId: 1 },
    })
    await flushPromises()
    const selected = w.findComponent(UiCombobox).props('selected') as { value: number; label: string }[]
    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({ value: 1, label: 'First Post' })
  })
})
