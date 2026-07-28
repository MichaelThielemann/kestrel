import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import FieldLink from './Link.vue'

const base = { name: 'Target', locale: 'en' }

describe('FieldLink', () => {
  it('renders the type switcher with all four allowed types by default', () => {
    const w = mount(FieldLink, { props: { ...base, field: { type: 'link' }, modelValue: null } })
    const buttons = w.findAll('button')
    expect(buttons.length).toBe(4)
    expect(buttons.some((b) => b.text() === 'URL')).toBe(true)
    expect(buttons.some((b) => b.text() === 'Email')).toBe(true)
    expect(buttons.some((b) => b.text() === 'Phone')).toBe(true)
    expect(buttons.some((b) => b.text() === 'Internal')).toBe(true)
  })

  it('hides the switcher when only one type is allowed', () => {
    const w = mount(FieldLink, {
      props: { ...base, field: { type: 'link', options: { types: ['external'] } }, modelValue: null },
    })
    expect(w.find('button').exists()).toBe(false)
  })

  it('typing in the URL input emits update:modelValue with { type: external, url }', async () => {
    const w = mount(FieldLink, {
      props: { ...base, field: { type: 'link', options: { types: ['external'] } }, modelValue: null },
    })
    await w.get('input[type="url"]').setValue('https://example.com')
    await nextTick()
    const emitted = w.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted!.at(-1)).toEqual([{ type: 'external', url: 'https://example.com' }])
  })

  it('shows the label input below the primary input', () => {
    const w = mount(FieldLink, {
      props: { ...base, field: { type: 'link', options: { types: ['external'] } }, modelValue: null },
    })
    const inputs = w.findAll('input')
    expect(inputs.length).toBe(2)
  })

  it('gives the optional label input an accessible name matching its placeholder', () => {
    const w = mount(FieldLink, {
      props: { ...base, field: { type: 'link', options: { types: ['external'] } }, modelValue: null },
    })
    const labelInput = w.findAll('input').at(-1)
    expect(labelInput!.attributes('aria-label')).toBe('Link text (optional)')
  })

  it('labels the type switcher for screen readers', () => {
    const w = mount(FieldLink, { props: { ...base, field: { type: 'link' }, modelValue: null } })
    expect(w.find('.ui-btngroup').attributes('aria-label')).toBe('Link type')
  })

  it('does not emit update:modelValue on mount with an initial value', () => {
    const w = mount(FieldLink, {
      props: { ...base, field: { type: 'link', options: { types: ['external'] } }, modelValue: { type: 'external', url: 'https://x.com' } },
    })
    expect(w.emitted('update:modelValue')).toBeFalsy()
  })

})
