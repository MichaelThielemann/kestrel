import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CheckboxGroup from './CheckboxGroup.vue'

const options = [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'C', value: 'c' }]

describe('UiCheckboxGroup', () => {
  it('renders a checkbox per option and reflects the selection', () => {
    const w = mount(CheckboxGroup, { props: { modelValue: ['a'], options } })
    const boxes = w.findAll('input[type="checkbox"]')
    expect(boxes.length).toBe(3)
    expect((boxes[0]!.element as HTMLInputElement).checked).toBe(true)
    expect((boxes[1]!.element as HTMLInputElement).checked).toBe(false)
  })

  it('adds a value on check without mutating the original array', async () => {
    const original = ['a']
    const w = mount(CheckboxGroup, { props: { modelValue: original, options } })
    await w.findAll('input[type="checkbox"]')[1]!.setValue(true)
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([['a', 'b']])
    expect(original).toEqual(['a'])
  })

  it('removes a value on uncheck', async () => {
    const w = mount(CheckboxGroup, { props: { modelValue: ['a', 'b'], options } })
    await w.findAll('input[type="checkbox"]')[0]!.setValue(false)
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([['b']])
  })

  it('treats a nullish model as empty', () => {
    const w = mount(CheckboxGroup, { props: { modelValue: undefined, options } })
    const boxes = w.findAll('input[type="checkbox"]')
    expect(boxes.every((b) => !(b.element as HTMLInputElement).checked)).toBe(true)
  })
})
