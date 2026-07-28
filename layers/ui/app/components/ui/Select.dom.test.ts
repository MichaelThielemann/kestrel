import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Select from './Select.vue'

const options = [{ label: 'Apple', value: 'a' }, { label: 'Banana', value: 'b' }]

describe('UiSelect', () => {
  it('renders options and round-trips v-model', async () => {
    const w = mount(Select, { props: { modelValue: 'a', options } })
    const sel = w.get('select')
    expect((sel.element as HTMLSelectElement).value).toBe('a')
    expect(w.findAll('option').length).toBe(2)
    await sel.setValue('b')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['b'])
  })

  it('renders a disabled placeholder option when given', () => {
    const w = mount(Select, { props: { modelValue: null, options, placeholder: 'Pick one' } })
    const ph = w.get('option[value=""]')
    expect(ph.text()).toBe('Pick one')
    expect(ph.attributes('disabled')).toBeDefined()
  })

  it('passes id and aria-* through to the select (not the wrapper)', () => {
    const w = mount(Select, {
      props: { modelValue: 'a', options },
      attrs: { id: 'fruit', 'aria-invalid': 'true' },
    })
    const sel = w.get('select')
    expect(sel.attributes('id')).toBe('fruit')
    expect(sel.attributes('aria-invalid')).toBe('true')
  })

  it('renders a chevron indicator so it matches the combobox (one consistent arrow)', () => {
    const w = mount(Select, { props: { modelValue: 'a', options } })
    // native select arrow is suppressed; a shared lucide chevron is overlaid like UiCombobox
    expect(w.find('.ui-select__icon').exists()).toBe(true)
  })
})
