import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ButtonGroup from './ButtonGroup.vue'

const options = [{ label: 'Left', value: 'l' }, { label: 'Center', value: 'c' }, { label: 'Right', value: 'r' }]

describe('UiButtonGroup (single)', () => {
  it('renders a button per option', () => {
    const w = mount(ButtonGroup, { props: { modelValue: null, options } })
    expect(w.findAll('button').length).toBe(3)
  })

  it('marks the active option per the model', () => {
    const w = mount(ButtonGroup, { props: { modelValue: 'c', options } })
    const active = w.findAll('button').find((b) => b.attributes('data-state') === 'on')
    expect(active?.text()).toBe('Center')
  })

  it('emits the clicked value', async () => {
    const w = mount(ButtonGroup, { props: { modelValue: null, options } })
    await w.findAll('button')[2]!.trigger('click')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['r'])
  })
})

describe('UiButtonGroup (multiple)', () => {
  it('toggles values in and out of the array', async () => {
    const w = mount(ButtonGroup, { props: { modelValue: ['l'], options, multiple: true } })
    await w.findAll('button')[1]!.trigger('click')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([['l', 'c']])
  })
})
