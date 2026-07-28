import { describe, it, expect } from 'vitest'
import { h } from 'vue'
import { mount } from '@vue/test-utils'
import Fieldset from './Fieldset.vue'

// A bare group element that spreads the fieldset's slot props.
const groupSlot = (s: Record<string, unknown>) => h('div', { role: 'group', ...s })

describe('UiFieldset', () => {
  it('renders the legend label', () => {
    const w = mount(Fieldset, { props: { label: 'Tags' }, slots: { default: groupSlot } })
    expect(w.get('legend').text()).toContain('Tags')
  })

  it('renders a required marker', () => {
    const w = mount(Fieldset, { props: { label: 'Tags', required: true }, slots: { default: groupSlot } })
    expect(w.find('.ui-fieldset__required').exists()).toBe(true)
  })

  it('wires error role=alert into the group aria-describedby and sets aria-invalid', () => {
    const w = mount(Fieldset, { props: { label: 'Tags', error: 'Required' }, slots: { default: groupSlot } })
    const group = w.get('[role="group"]')
    const alert = w.get('p[role="alert"]')
    expect(group.attributes('aria-invalid')).toBe('true')
    expect(group.attributes('aria-describedby')).toBe(alert.attributes('id'))
  })

  it('includes the hint id in aria-describedby', () => {
    const w = mount(Fieldset, { props: { label: 'Tags', hint: 'Pick some' }, slots: { default: groupSlot } })
    const group = w.get('[role="group"]')
    const hint = w.get('.ui-fieldset__hint')
    expect(group.attributes('aria-describedby')).toBe(hint.attributes('id'))
  })

  it('conveys required to AT via aria-required on the group (the asterisk is aria-hidden)', () => {
    const req = mount(Fieldset, { props: { label: 'Tags', required: true }, slots: { default: groupSlot } })
    expect(req.get('[role="group"]').attributes('aria-required')).toBe('true')
    const opt = mount(Fieldset, { props: { label: 'Tags' }, slots: { default: groupSlot } })
    expect(opt.get('[role="group"]').attributes('aria-required')).toBeUndefined()
  })
})
