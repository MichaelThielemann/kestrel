import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FieldSlug from './Slug.vue'
import UiField from '../ui/Field.vue'

const base = { name: 'Slug', locale: 'en', field: { type: 'slug' as const, options: { from: 'title' } } }
const opts = { global: { components: { KestrelUiField: UiField } } }

describe('FieldSlug', () => {
  it('blur on an untouched null slug leaves the model untouched (no spurious dirty state)', async () => {
    const w = mount(FieldSlug, { props: { ...base, modelValue: null }, ...opts })
    await w.get('input').trigger('blur')
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })

  it('blur normalizes typed text into a slug', async () => {
    const w = mount(FieldSlug, { props: { ...base, modelValue: null }, ...opts })
    const input = w.get('input')
    await input.setValue('Hello World')
    await input.trigger('blur')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['hello-world'])
  })

  it('blur on an already-normalized slug does not re-emit', async () => {
    const w = mount(FieldSlug, { props: { ...base, modelValue: 'hello-world' }, ...opts })
    await w.get('input').trigger('blur')
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })
})
