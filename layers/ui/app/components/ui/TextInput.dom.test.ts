import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import TextInput from './TextInput.vue'

describe('UiTextInput', () => {
  it('binds value via v-model and emits updates', async () => {
    const w = mount(TextInput, { props: { modelValue: 'hi' } })
    const input = w.get('input')
    expect((input.element as HTMLInputElement).value).toBe('hi')
    await input.setValue('there')
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['there'])
  })

  it('applies the type prop', () => {
    const w = mount(TextInput, { props: { type: 'password' } })
    expect(w.get('input').attributes('type')).toBe('password')
  })

  it('passes id and aria-* attrs through to the input', () => {
    const w = mount(TextInput, {
      props: { modelValue: '' },
      attrs: { id: 'email-1', 'aria-invalid': 'true', 'aria-describedby': 'email-1-error' },
    })
    const input = w.get('input')
    expect(input.attributes('id')).toBe('email-1')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(input.attributes('aria-describedby')).toBe('email-1-error')
  })

  it('renders no reveal toggle for non-password inputs', () => {
    expect(mount(TextInput, { props: { type: 'text' } }).find('.ui-input__reveal').exists()).toBe(false)
  })

  it('renders a reveal toggle for password inputs and switches the input type on click', async () => {
    const w = mount(TextInput, { props: { type: 'password', modelValue: 'secret' } })
    expect(w.get('input').attributes('type')).toBe('password')
    const toggle = w.get('.ui-input__reveal')
    expect(toggle.attributes('type')).toBe('button')
    const labelHidden = toggle.attributes('aria-label')
    expect(labelHidden).toBeTruthy()

    await toggle.trigger('click')
    expect(w.get('input').attributes('type')).toBe('text')
    // the action label reflects the new (revealed) state
    expect(toggle.attributes('aria-label')).not.toBe(labelHidden)

    await toggle.trigger('click')
    expect(w.get('input').attributes('type')).toBe('password')
    expect(toggle.attributes('aria-label')).toBe(labelHidden)
  })

  it('still forwards id and aria-* to the inner input when the reveal toggle is present', () => {
    const w = mount(TextInput, {
      props: { type: 'password', modelValue: '' },
      attrs: { id: 'pw-1', 'aria-invalid': 'true', 'aria-describedby': 'pw-1-error' },
    })
    const input = w.get('input')
    expect(input.attributes('id')).toBe('pw-1')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(input.attributes('aria-describedby')).toBe('pw-1-error')
  })

  it('opts a non-password input into the reveal toggle via reveal', () => {
    const w = mount(TextInput, { props: { type: 'text', reveal: true } })
    expect(w.find('.ui-input__reveal').exists()).toBe(true)
  })

  it('renders the reveal icon and switches it with the revealed state', async () => {
    const w = mount(TextInput, { props: { type: 'password', modelValue: 'secret' } })
    const toggle = w.get('.ui-input__reveal')
    expect(toggle.get('svg.ui-icon').attributes('data-icon')).toBe('eye')
    await toggle.trigger('click')
    expect(toggle.get('svg.ui-icon').attributes('data-icon')).toBe('eye-off')
  })
})
