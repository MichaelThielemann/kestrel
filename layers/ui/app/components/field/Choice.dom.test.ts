import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FieldChoice from './Choice.vue'

const choices = [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]
const base = { name: 'C', locale: 'en' }
const optionValues = (w: ReturnType<typeof mount>) =>
  w.get('select').findAll('option').map((o) => (o.element as HTMLOptionElement).value)

describe('FieldChoice — optional single select', () => {
  it('renders a selectable empty option and shows it (not option A) when the value is null', () => {
    const w = mount(FieldChoice, { props: { ...base, field: { type: 'choice', options: { choices } }, modelValue: null } })
    expect(optionValues(w)).toContain('') // an empty option exists to represent "no value"
    expect((w.get('select').element as HTMLSelectElement).value).toBe('') // null shows empty, not the first choice
  })

  it('can clear a picked value back to null through the widget', async () => {
    const w = mount(FieldChoice, { props: { ...base, field: { type: 'choice', options: { choices } }, modelValue: 'a' } })
    const select = w.get('select')
    await select.setValue('') // pick the empty option
    expect(w.emitted('update:modelValue')!.at(-1)).toEqual([null])
  })

  it('a REQUIRED single choice keeps no empty option (validation enforces a pick)', () => {
    const w = mount(FieldChoice, { props: { ...base, field: { type: 'choice', required: true, options: { choices } }, modelValue: null } })
    expect(optionValues(w)).not.toContain('')
  })
})

describe('FieldChoice — localized choice labels', () => {
  const localized = [
    { label: { en: '301 - permanent', de: '301 - dauerhaft' }, value: '301' },
    { label: { en: '302 - temporary', de: '302 - voruebergehend' }, value: '302' },
  ]
  const optionTexts = (w: ReturnType<typeof mount>) => w.get('select').findAll('option').map((o) => o.text())

  it('resolves a per-language label instead of rendering the raw map', () => {
    const w = mount(FieldChoice, { props: { ...base, field: { type: 'choice', required: true, options: { choices: localized } }, modelValue: '301' } })
    expect(optionTexts(w)).toEqual(['301 - permanent', '302 - temporary'])
  })

  it('resolves them in the button display too', () => {
    const w = mount(FieldChoice, { props: { ...base, field: { type: 'choice', required: true, options: { choices: localized, display: 'buttons' } }, modelValue: '301' } })
    expect(w.text()).toContain('301 - permanent')
    expect(w.text()).not.toContain('{')
  })

  it('leaves a plain-string label alone', () => {
    const w = mount(FieldChoice, { props: { ...base, field: { type: 'choice', required: true, options: { choices } }, modelValue: 'a' } })
    expect(optionTexts(w)).toEqual(['A', 'B'])
  })
})
