import { describe, it, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import FieldRenderer from './Renderer.vue'
import FieldRepeater from './Repeater.vue'
import type { FieldType } from '../../../core/server/utils/defineCollection'

const base = { name: 'X', locale: 'en' }

describe('FieldRenderer', () => {
  it('renders the text widget for a text field', () => {
    const w = mount(FieldRenderer, { props: { ...base, field: { type: 'text' }, modelValue: 'hi' } })
    expect(w.get('input').attributes('type')).toBe('text')
    expect((w.get('input').element as HTMLInputElement).value).toBe('hi')
  })

  it('renders the number widget for a number field', () => {
    const w = mount(FieldRenderer, { props: { ...base, field: { type: 'number' }, modelValue: 2 } })
    expect(w.get('input').attributes('type')).toBe('number')
  })

  it('humanizes the field key into the label (siteName → Site Name)', () => {
    const w = mount(FieldRenderer, { props: { ...base, name: 'siteName', field: { type: 'text' }, modelValue: '' } })
    expect(w.get('.ui-field__label').text()).toBe('Site Name')
  })

  it('prefers an explicit (localized) field label over the humanized key', () => {
    const w = mount(FieldRenderer, { props: { ...base, name: 'siteName', field: { type: 'text', label: { en: 'Website name', de: 'Webseitenname' } }, modelValue: '' } })
    expect(w.get('.ui-field__label').text()).toBe('Website name') // default admin language is en in the dom setup
  })

  it('falls back to the unsupported placeholder for an unimplemented type', () => {
    const w = mount(FieldRenderer, { props: { ...base, field: { type: 'bogus' as FieldType }, modelValue: null } })
    expect(w.text()).toContain('not yet available')
    expect(w.find('input').exists()).toBe(false)
  })

  it('renders the link widget for a link field', () => {
    const w = mount(FieldRenderer, { props: { ...base, field: { type: 'link' }, modelValue: null } })
    expect(w.find('[role="group"]').exists()).toBe(true)
    expect(w.find('input').exists()).toBe(true)
  })

  it('propagates v-model updates from the chosen widget', async () => {
    const w = mount(FieldRenderer, { props: { ...base, field: { type: 'text' }, modelValue: 'a' } })
    await w.get('input').setValue('b')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['b'])
  })

  it('renders the repeater widget and an Add item button', async () => {
    // The registry resolves repeater to an async wrapper (cycle break); happy-dom won't settle it without a
    // Suspense ancestor, so swap in the real sync component to verify the routing. Async resolution itself is
    // exercised by the nested-repeater case in Repeater.dom.test.ts.
    const w = mount(FieldRenderer, {
      props: {
        ...base,
        field: { type: 'repeater', options: { fields: { label: { type: 'text' } } } },
        modelValue: [],
      },
      global: { stubs: { FieldRepeater } },
    })
    await flushPromises()
    expect(w.text()).toContain('Add item')
  })
})
