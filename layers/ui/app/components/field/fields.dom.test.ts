import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FieldText from './Text.vue'
import FieldNumber from './Number.vue'
import FieldBoolean from './Boolean.vue'
import FieldJson from './Json.vue'
import FieldChoice from './Choice.vue'
import FieldDatetime from './Datetime.vue'
import FieldRichtext from './Richtext.vue'
import FieldUnsupported from './Unsupported.vue'

const base = { name: 'Title', locale: 'en' }

describe('FieldText', () => {
  it('renders a single-line input by default and round-trips v-model', async () => {
    const w = mount(FieldText, { props: { ...base, field: { type: 'text' }, modelValue: 'hi' } })
    expect(w.find('textarea').exists()).toBe(false)
    const input = w.get('input')
    expect((input.element as HTMLInputElement).value).toBe('hi')
    await input.setValue('bye')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['bye'])
  })

  it('renders a textarea when the field is multiline', () => {
    const w = mount(FieldText, {
      props: { ...base, field: { type: 'text', options: { multiline: true } }, modelValue: '' },
    })
    expect(w.find('textarea').exists()).toBe(true)
  })

  it('shows the label and links it to the control', () => {
    const w = mount(FieldText, { props: { ...base, field: { type: 'text' }, modelValue: '' } })
    expect(w.get('label').text()).toContain('Title')
    expect(w.get('label').attributes('for')).toBe(w.get('input').attributes('id'))
  })

  it('renders the error with role=alert and marks the control invalid', () => {
    const w = mount(FieldText, { props: { ...base, field: { type: 'text' }, modelValue: '', error: 'Nope' } })
    expect(w.get('p[role="alert"]').text()).toContain('Nope')
    expect(w.get('input').attributes('aria-invalid')).toBe('true')
  })
})

describe('FieldNumber', () => {
  it('renders a number input and emits numbers', async () => {
    const w = mount(FieldNumber, { props: { ...base, field: { type: 'number' }, modelValue: 3 } })
    const input = w.get('input')
    expect(input.attributes('type')).toBe('number')
    await input.setValue('8')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([8])
  })

  it('sets step=1 for integers and applies min/max', () => {
    const w = mount(FieldNumber, {
      props: { ...base, field: { type: 'number', options: { min: 0, max: 10 } }, modelValue: null },
    })
    const input = w.get('input')
    expect(input.attributes('step')).toBe('1')
    expect(input.attributes('min')).toBe('0')
    expect(input.attributes('max')).toBe('10')
  })

  it('renders a unit suffix when options.unit is set, still emitting a bare number', async () => {
    const w = mount(FieldNumber, {
      props: { ...base, field: { type: 'number', options: { unit: 'rem' } }, modelValue: 0 },
    })
    expect(w.get('.ui-number-wrap__suffix').text()).toBe('rem')
    await w.get('input').setValue('4')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([4])
  })

  it('renders no suffix and keeps the bare input when options.unit is absent', () => {
    const w = mount(FieldNumber, { props: { ...base, field: { type: 'number' }, modelValue: 3 } })
    expect(w.find('.ui-number-wrap').exists()).toBe(false)
    expect(w.get('input').classes()).toContain('ui-number')
  })
})

describe('FieldBoolean', () => {
  it('renders a 2-option button group reflecting the boolean', () => {
    const w = mount(FieldBoolean, { props: { ...base, field: { type: 'boolean' }, modelValue: true } })
    const buttons = w.findAll('button')
    expect(buttons.length).toBe(2)
    expect(buttons.find((b) => b.attributes('data-state') === 'on')?.text()).toBe('Yes')
  })

  it('emits a boolean on click', async () => {
    const w = mount(FieldBoolean, { props: { ...base, field: { type: 'boolean' }, modelValue: false } })
    await w.findAll('button').find((b) => b.text() === 'Yes')!.trigger('click')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([true])
  })
})

describe('FieldChoice', () => {
  const choices = [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]

  it('renders a native select for single (default display)', () => {
    const w = mount(FieldChoice, { props: { ...base, field: { type: 'choice', options: { choices } }, modelValue: 'a' } })
    expect(w.find('select').exists()).toBe(true)
    expect((w.get('select').element as HTMLSelectElement).value).toBe('a')
  })

  it('renders a button group for single display=buttons', async () => {
    const w = mount(FieldChoice, {
      props: { ...base, field: { type: 'choice', options: { choices, display: 'buttons' } }, modelValue: null },
    })
    expect(w.find('select').exists()).toBe(false)
    const buttons = w.findAll('button')
    expect(buttons.length).toBe(2)
    await buttons[0]!.trigger('click')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['a'])
  })

  it('renders checkboxes for multiple (default display) and toggles', async () => {
    const w = mount(FieldChoice, {
      props: { ...base, field: { type: 'choice', options: { multiple: true, choices } }, modelValue: ['a'] },
    })
    const boxes = w.findAll('input[type="checkbox"]')
    expect(boxes.length).toBe(2)
    await boxes[1]!.setValue(true)
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([['a', 'b']])
  })

  it('renders a multi button group for multiple display=buttons', async () => {
    const w = mount(FieldChoice, {
      props: { ...base, field: { type: 'choice', options: { multiple: true, display: 'buttons', choices } }, modelValue: [] },
    })
    const buttons = w.findAll('button')
    expect(buttons.length).toBe(2)
    await buttons[0]!.trigger('click')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([['a']])
  })
})

describe('FieldJson', () => {
  it('serializes the model into the textarea', () => {
    const w = mount(FieldJson, { props: { ...base, field: { type: 'json' }, modelValue: { a: 1 } } })
    expect((w.get('textarea').element as HTMLTextAreaElement).value).toContain('"a": 1')
  })

  it('emits the parsed value for valid JSON', async () => {
    const w = mount(FieldJson, { props: { ...base, field: { type: 'json' }, modelValue: {} } })
    await w.get('textarea').setValue('{"b":2}')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([{ b: 2 }])
  })

  it('shows an error and does not emit a value for invalid JSON', async () => {
    const w = mount(FieldJson, { props: { ...base, field: { type: 'json' }, modelValue: {} } })
    await w.get('textarea').setValue('{bad')
    expect(w.get('p[role="alert"]').text()).toContain('Invalid JSON')
    expect(w.emitted('update:modelValue')).toBeFalsy()
  })
})

describe('FieldDatetime', () => {
  it('renders a date picker (with label) for single date', () => {
    const w = mount(FieldDatetime, {
      props: { ...base, field: { type: 'datetime', options: { precision: 'date' } }, modelValue: '2024-01-15' },
    })
    expect(w.find('.ui-datepicker__field').exists()).toBe(true)
    expect(w.get('label').text()).toContain('Title')
  })

  it('renders a native time input for single time and emits a string', async () => {
    const w = mount(FieldDatetime, {
      props: { ...base, field: { type: 'datetime', options: { precision: 'time' } }, modelValue: null },
    })
    await w.get('input[type="time"]').setValue('09:15')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['09:15'])
  })

  it('renders a range picker (fieldset + separator) for a date range', () => {
    const w = mount(FieldDatetime, {
      props: { ...base, field: { type: 'datetime', options: { precision: 'date', range: true } }, modelValue: { start: '2024-01-01', end: '2024-01-31' } },
    })
    expect(w.find('legend').exists()).toBe(true)
    expect(w.find('.ui-datepicker__sep').exists()).toBe(true)
  })

  it('renders two time inputs for a time range and emits {start,end}', async () => {
    const w = mount(FieldDatetime, {
      props: { ...base, field: { type: 'datetime', options: { precision: 'time', range: true } }, modelValue: { start: '', end: '' } },
    })
    const inputs = w.findAll('input[type="time"]')
    expect(inputs.length).toBe(2)
    await inputs[0]!.setValue('08:00')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([{ start: '08:00', end: '' }])
  })

  it('forwards aria-invalid / aria-describedby to the range time inputs when there is an error', () => {
    const w = mount(FieldDatetime, {
      props: { ...base, field: { type: 'datetime', required: true, options: { precision: 'time', range: true } }, modelValue: { start: '', end: '' }, error: 'Required' },
    })
    const errId = w.get('[role="alert"]').attributes('id')
    for (const input of w.findAll('input[type="time"]')) {
      expect(input.attributes('aria-invalid')).toBe('true')
      expect(input.attributes('aria-describedby')).toBe(errId)
    }
  })

  it('gives the date picker a programmatic name (role=group + aria-label) — WCAG 1.3.1/4.1.2', () => {
    const w = mount(FieldDatetime, {
      props: { ...base, field: { type: 'datetime', options: { precision: 'date' } }, modelValue: '2024-01-15' },
    })
    const field = w.get('.ui-datepicker__field')
    expect(field.attributes('role')).toBe('group')
    expect(field.attributes('aria-label')).toBe('Title')
  })

  it('wires the date picker invalid/required/describedby from the field error', () => {
    const w = mount(FieldDatetime, {
      props: { ...base, field: { type: 'datetime', required: true, options: { precision: 'date' } }, modelValue: null, error: 'Required' },
    })
    const errId = w.get('[role="alert"]').attributes('id')
    const field = w.get('.ui-datepicker__field')
    expect(field.attributes('aria-invalid')).toBe('true')
    expect(field.attributes('aria-required')).toBe('true')
    expect(field.attributes('aria-describedby')).toBe(errId)
  })

  it('names the range date picker too', () => {
    const w = mount(FieldDatetime, {
      props: { ...base, field: { type: 'datetime', options: { precision: 'date', range: true } }, modelValue: { start: '', end: '' } },
    })
    expect(w.get('.ui-datepicker__field').attributes('aria-label')).toBe('Title')
  })
})

describe('FieldRichtext', () => {
  it('renders the editor (toolbar) inside a labelled field', async () => {
    const w = mount(FieldRichtext, { props: { ...base, field: { type: 'richtext' }, modelValue: '<p>Hi</p>' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(w.get('label').text()).toContain('Title')
    expect(w.find('.ui-rt-toolbar').exists()).toBe(true)
    w.unmount()
  })

  it('exposes the editing surface as a named multiline textbox with error state — WCAG 1.3.1/4.1.2', async () => {
    const w = mount(FieldRichtext, {
      props: { ...base, field: { type: 'richtext', required: true }, modelValue: '<p>Hi</p>', error: 'Required' },
    })
    await new Promise((r) => setTimeout(r, 0))
    const box = w.find('.tiptap') // editor.view.dom — the contenteditable surface
    expect(box.exists()).toBe(true)
    expect(box.attributes('role')).toBe('textbox')
    expect(box.attributes('aria-multiline')).toBe('true')
    expect(box.attributes('aria-label')).toBe('Title')
    expect(box.attributes('aria-invalid')).toBe('true')
    expect(box.attributes('aria-required')).toBe('true')
    w.unmount()
  })
})

describe('FieldUnsupported', () => {
  it('names the unsupported field type', () => {
    const w = mount(FieldUnsupported, {
      props: { ...base, field: { type: 'relation', relation: { collection: 'pages' } }, modelValue: null },
    })
    expect(w.text()).toContain('relation')
    expect(w.text()).toContain('not yet available')
  })
})
