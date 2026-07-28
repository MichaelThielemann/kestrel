import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { getQuery } from 'h3'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import FieldLink from './Link.vue'

registerEndpoint('/api/collections', () => ({
  data: [
    { name: 'posts', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false, blocks: { enabled: false }, label: { singular: 'Post', plural: 'Posts' }, fields: {} },
  ],
}))

registerEndpoint('/api/posts/options', (event) => {
  const q = getQuery(event)
  if (q.ids) return { data: [{ id: 1, label: 'First Post' }], total: 1 }
  if (q.search) return { data: [{ id: 2, label: 'Second Post' }], total: 1 }
  return { data: [], total: 0 }
})

describe('FieldLink (nuxt env)', () => {
  it('internal branch: choosing collection + record emits { type, collection, id }', async () => {
    const w = await mountSuspended(FieldLink, {
      props: {
        name: 'Target',
        locale: 'en',
        field: { type: 'link', options: { types: ['internal'], collections: ['posts'] } },
        modelValue: null,
      },
    })
    await flushPromises()
    // Single allowed collection → auto-selected; combobox is active
    await w.get('.ui-combobox__input').trigger('focus')
    await w.get('.ui-combobox__input').setValue('sec')
    await new Promise((r) => setTimeout(r, 300))
    await flushPromises()
    const items = w.findAll('.ui-combobox__item')
    expect(items.length).toBeGreaterThan(0)
    await items[0]!.trigger('click')
    await flushPromises()
    const emitted = w.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted!.at(-1)![0]).toMatchObject({ type: 'internal', collection: 'posts', id: 2 })
  })

  it('loads an existing internal value: resolves the record label and keeps the model', async () => {
    const w = await mountSuspended(FieldLink, {
      props: {
        name: 'Target',
        locale: 'en',
        field: { type: 'link', options: { types: ['internal'], collections: ['posts'] } },
        modelValue: { type: 'internal', collection: 'posts', id: 1 },
      },
    })
    await flushPromises()
    expect(w.html()).toContain('First Post') // resolved via /options?ids, not wiped to null
    // the field label associates with the record combobox input
    const label = w.get('label')
    const input = w.get('.ui-combobox__input')
    expect(label.attributes('for')).toBe(input.attributes('id'))
  })
})
