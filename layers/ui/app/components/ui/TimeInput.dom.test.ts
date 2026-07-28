import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import TimeInput from './TimeInput.vue'

describe('UiTimeInput', () => {
  it('binds value via v-model and emits updates', async () => {
    const w = mount(TimeInput, { props: { modelValue: '10:30' } })
    const input = w.get('input')
    expect(input.attributes('type')).toBe('time')
    expect((input.element as HTMLInputElement).value).toBe('10:30')
    await input.setValue('14:45')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['14:45'])
  })

  it('passes id and aria-* through to the input', () => {
    const w = mount(TimeInput, {
      props: { modelValue: null },
      attrs: { id: 't', 'aria-invalid': 'true' },
    })
    const input = w.get('input')
    expect(input.attributes('id')).toBe('t')
    expect(input.attributes('aria-invalid')).toBe('true')
  })
})
