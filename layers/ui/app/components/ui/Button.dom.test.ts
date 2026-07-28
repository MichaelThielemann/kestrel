import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Button from './Button.vue'

describe('UiButton', () => {
  it('renders a button with default type and secondary/md classes', () => {
    const w = mount(Button, { slots: { default: 'Save' } })
    const b = w.get('button')
    expect(b.attributes('type')).toBe('button')
    expect(b.classes()).toContain('ui-button--secondary')
    expect(b.classes()).toContain('ui-button--md')
    expect(b.text()).toContain('Save')
  })

  it('applies variant, size and type props', () => {
    const w = mount(Button, { props: { variant: 'primary', size: 'lg', type: 'submit' } })
    const b = w.get('button')
    expect(b.attributes('type')).toBe('submit')
    expect(b.classes()).toContain('ui-button--primary')
    expect(b.classes()).toContain('ui-button--lg')
  })

  it('loading sets aria-busy, disables, and shows a spinner', () => {
    const w = mount(Button, { props: { loading: true } })
    const b = w.get('button')
    expect(b.attributes('aria-busy')).toBe('true')
    expect(b.attributes('disabled')).toBeDefined()
    expect(w.find('.ui-button__spinner').exists()).toBe(true)
  })

  it('disabled disables the button', () => {
    const w = mount(Button, { props: { disabled: true } })
    expect(w.get('button').attributes('disabled')).toBeDefined()
  })
})
