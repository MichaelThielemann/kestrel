import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Alert from './Alert.vue'

describe('UiAlert', () => {
  it('uses role=status for info and success (polite)', () => {
    expect(mount(Alert, { props: { variant: 'info' } }).get('.ui-alert').attributes('role')).toBe('status')
    expect(mount(Alert, { props: { variant: 'success' } }).get('.ui-alert').attributes('role')).toBe('status')
  })

  it('uses role=alert for warning and error (assertive)', () => {
    expect(mount(Alert, { props: { variant: 'warning' } }).get('.ui-alert').attributes('role')).toBe('alert')
    expect(mount(Alert, { props: { variant: 'error' } }).get('.ui-alert').attributes('role')).toBe('alert')
  })

  it('applies the variant class and renders slot content', () => {
    const w = mount(Alert, { props: { variant: 'error' }, slots: { default: 'Invalid credentials' } })
    expect(w.get('.ui-alert').classes()).toContain('ui-alert--error')
    expect(w.text()).toContain('Invalid credentials')
  })

  it('defaults to info/status', () => {
    expect(mount(Alert).get('.ui-alert').attributes('role')).toBe('status')
  })

  it('renders the title slot alongside the body', () => {
    const w = mount(Alert, { slots: { title: 'Heads up', default: 'Body text' } })
    expect(w.find('.ui-alert__title').text()).toBe('Heads up')
    expect(w.find('.ui-alert__body').text()).toBe('Body text')
  })
})
