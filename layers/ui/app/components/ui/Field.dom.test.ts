import { describe, it, expect } from 'vitest'
import { h } from 'vue'
import { mount } from '@vue/test-utils'
import Field from './Field.vue'

// Render a bare input that spreads all slot props (mirrors `<input v-bind="s">`).
const inputSlot = (s: Record<string, unknown>) => h('input', s)

describe('UiField', () => {
  it('links the label to the control id from the slot', () => {
    const w = mount(Field, { props: { label: 'Email' }, slots: { default: inputSlot } })
    const label = w.get('label')
    const input = w.get('input')
    expect(label.attributes('for')).toBe(input.attributes('id'))
    expect(label.text()).toContain('Email')
  })

  it('renders a required marker', () => {
    const w = mount(Field, { props: { label: 'Email', required: true } })
    expect(w.find('.ui-field__required').exists()).toBe(true)
  })

  it('exposes error with role=alert and wires aria to the control', () => {
    const w = mount(Field, { props: { label: 'Email', error: 'Required' }, slots: { default: inputSlot } })
    const input = w.get('input')
    const alert = w.get('p[role="alert"]')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(input.attributes('aria-describedby')).toBe(alert.attributes('id'))
  })

  it('includes the hint id in aria-describedby', () => {
    const w = mount(Field, { props: { label: 'Email', hint: 'Never shared' }, slots: { default: inputSlot } })
    const input = w.get('input')
    const hint = w.get('.ui-field__hint')
    expect(input.attributes('aria-describedby')).toBe(hint.attributes('id'))
  })

  it('joins hint and error ids in aria-describedby', () => {
    const w = mount(Field, {
      props: { label: 'Email', hint: 'Never shared', error: 'Required' },
      slots: { default: inputSlot },
    })
    const input = w.get('input')
    const hint = w.get('.ui-field__hint')
    const err = w.get('p[role="alert"]')
    expect(input.attributes('aria-describedby')).toBe(`${hint.attributes('id')} ${err.attributes('id')}`)
  })
})
