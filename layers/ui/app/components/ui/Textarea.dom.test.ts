import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Textarea from './Textarea.vue'

describe('UiTextarea', () => {
  it('binds value via v-model and emits updates', async () => {
    const w = mount(Textarea, { props: { modelValue: 'hi' } })
    const ta = w.get('textarea')
    expect((ta.element as HTMLTextAreaElement).value).toBe('hi')
    await ta.setValue('there')
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['there'])
  })

  it('applies the rows prop', () => {
    const w = mount(Textarea, { props: { rows: 8 } })
    expect(w.get('textarea').attributes('rows')).toBe('8')
  })

  it('passes id and aria-* through to the textarea', () => {
    const w = mount(Textarea, {
      props: { modelValue: '' },
      attrs: { id: 'bio', 'aria-invalid': 'true', 'aria-describedby': 'bio-error' },
    })
    const ta = w.get('textarea')
    expect(ta.attributes('id')).toBe('bio')
    expect(ta.attributes('aria-invalid')).toBe('true')
    expect(ta.attributes('aria-describedby')).toBe('bio-error')
  })
})
