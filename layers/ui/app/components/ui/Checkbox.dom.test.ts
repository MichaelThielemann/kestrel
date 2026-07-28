import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Checkbox from './Checkbox.vue'

describe('UiCheckbox', () => {
  it('reflects the boolean model and emits on toggle', async () => {
    const w = mount(Checkbox, { props: { modelValue: false } })
    const box = w.get('input')
    expect((box.element as HTMLInputElement).checked).toBe(false)
    await box.setValue(true)
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([true])
  })

  it('renders checked when the model is true', () => {
    const w = mount(Checkbox, { props: { modelValue: true } })
    expect((w.get('input').element as HTMLInputElement).checked).toBe(true)
  })

  it('passes id through and reflects disabled', () => {
    const w = mount(Checkbox, {
      props: { modelValue: false, disabled: true },
      attrs: { id: 'pub' },
    })
    const box = w.get('input')
    expect(box.attributes('id')).toBe('pub')
    expect(box.attributes('disabled')).toBeDefined()
  })

  it('drives the element indeterminate DOM property from the prop, both ways', async () => {
    const w = mount(Checkbox, { props: { modelValue: false, indeterminate: true } })
    const el = w.get('input').element as HTMLInputElement
    expect(el.indeterminate).toBe(true)
    await w.setProps({ indeterminate: false })
    expect(el.indeterminate).toBe(false)
  })

  it('defaults indeterminate to false', () => {
    const w = mount(Checkbox, { props: { modelValue: false } })
    expect((w.get('input').element as HTMLInputElement).indeterminate).toBe(false)
  })
})
