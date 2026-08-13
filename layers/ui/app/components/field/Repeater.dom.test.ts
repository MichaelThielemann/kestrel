import { describe, it, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import FieldRepeater from './Repeater.vue'

const base = { name: 'Links', locale: 'en' }

const textRepeaterField = {
  type: 'repeater' as const,
  options: { fields: { label: { type: 'text' as const } } },
}

describe('FieldRepeater', () => {
  it('renders one row per model row with sub-field inputs', () => {
    const w = mount(FieldRepeater, {
      props: { ...base, field: textRepeaterField },
      attrs: { modelValue: [{ label: 'A' }, { label: 'B' }] },
    })
    const rows = w.findAll('.ui-repeater__row')
    expect(rows.length).toBe(2)
    expect(w.findAll('input').length).toBe(2)
  })

  it('shows empty-state text when no rows', () => {
    const w = mount(FieldRepeater, {
      props: { ...base, field: textRepeaterField },
      attrs: { modelValue: [] },
    })
    expect(w.text()).toContain('No items yet.')
    expect(w.findAll('.ui-repeater__row').length).toBe(0)
  })

  it('Add item appends a row and emits updated array', async () => {
    const w = mount(FieldRepeater, {
      props: { ...base, field: textRepeaterField, modelValue: [] },
    })
    await w.find('.ui-repeater__add').trigger('click')
    const emitted = w.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    const last = emitted!.at(-1)![0] as unknown[]
    expect(last.length).toBe(1)
    expect(w.findAll('.ui-repeater__row').length).toBe(1)
  })

  it('hides condition-unmet sub-fields per row (like the page/block panes)', async () => {
    const conditionalRepeater = {
      type: 'repeater' as const,
      options: {
        fields: {
          kind: { type: 'text' as const },
          caption: { type: 'text' as const, required: true, condition: { field: 'kind', is: 'image' } },
        },
      },
    }
    const w = mount(FieldRepeater, {
      props: { ...base, field: conditionalRepeater },
      attrs: { modelValue: [{ kind: 'video' }, { kind: 'image' }] },
    })
    const rows = w.findAll('.ui-repeater__row')
    expect(rows[0]!.findAll('input').length).toBe(1) // caption hidden: condition unmet
    expect(rows[1]!.findAll('input').length).toBe(2) // caption shown: condition met

    // Reactivity: flipping row 0's controlling cell to 'image' must re-mount its caption sub-field
    // (setCell replaces the row object → the per-row v-if re-evaluates), not stay frozen at first render.
    await w.findAll('.ui-repeater__row')[0]!.findAll('input')[0]!.setValue('image')
    expect(w.findAll('.ui-repeater__row')[0]!.findAll('input').length).toBe(2)
  })

  it('Remove drops the correct row and emits trimmed array', async () => {
    const w = mount(FieldRepeater, {
      props: {
        ...base,
        field: textRepeaterField,
        modelValue: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      },
    })
    const removeBtns = w.findAll('.ui-repeater__remove')
    await removeBtns[1]!.trigger('click')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0] as Record<string, unknown>[]
    expect(emitted.length).toBe(2)
    expect(emitted[0]!.label).toBe('A')
    expect(emitted[1]!.label).toBe('C')
  })

  it('move-up button reorders rows and emits swapped array', async () => {
    const w = mount(FieldRepeater, {
      props: {
        ...base,
        field: textRepeaterField,
        modelValue: [{ label: 'A' }, { label: 'B' }],
      },
    })
    const row1Btns = w.findAll('.ui-repeater__row')[1]!.findAll('.ui-repeater__move')
    await row1Btns[0]!.trigger('click')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0] as Record<string, unknown>[]
    expect(emitted[0]!.label).toBe('B')
    expect(emitted[1]!.label).toBe('A')
  })

  it('move-down button reorders rows and emits swapped array', async () => {
    const w = mount(FieldRepeater, {
      props: {
        ...base,
        field: textRepeaterField,
        modelValue: [{ label: 'A' }, { label: 'B' }],
      },
    })
    const row0Btns = w.findAll('.ui-repeater__row')[0]!.findAll('.ui-repeater__move')
    await row0Btns[1]!.trigger('click')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0] as Record<string, unknown>[]
    expect(emitted[0]!.label).toBe('B')
    expect(emitted[1]!.label).toBe('A')
  })

  it('first row move-up is disabled; last row move-down is disabled', () => {
    const w = mount(FieldRepeater, {
      props: {
        ...base,
        field: textRepeaterField,
        modelValue: [{ label: 'A' }, { label: 'B' }],
      },
    })
    const rows = w.findAll('.ui-repeater__row')
    const row0Btns = rows[0]!.findAll('.ui-repeater__move')
    const row1Btns = rows[1]!.findAll('.ui-repeater__move')
    expect((row0Btns[0]!.element as HTMLButtonElement).disabled).toBe(true)
    expect((row1Btns[1]!.element as HTMLButtonElement).disabled).toBe(true)
    expect((row0Btns[1]!.element as HTMLButtonElement).disabled).toBe(false)
    expect((row1Btns[0]!.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('editing a sub-field in row 1 emits correct value without affecting row 0', async () => {
    const w = mount(FieldRepeater, {
      props: {
        ...base,
        field: textRepeaterField,
        modelValue: [{ label: 'A' }, { label: 'B' }],
      },
    })
    const inputs = w.findAll('input')
    await inputs[1]!.setValue('Updated')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0] as Record<string, unknown>[]
    expect(emitted[1]!.label).toBe('Updated')
    expect(emitted[0]!.label).toBe('A')
  })

  it('disabled prop disables Add, Remove, move, duplicate buttons and inner inputs', () => {
    const w = mount(FieldRepeater, {
      props: {
        ...base,
        field: textRepeaterField,
        modelValue: [{ label: 'A' }],
        disabled: true,
      },
    })
    expect((w.find('.ui-repeater__add').element as HTMLButtonElement).disabled).toBe(true)
    expect((w.find('.ui-repeater__remove').element as HTMLButtonElement).disabled).toBe(true)
    expect((w.find('.ui-repeater__duplicate').element as HTMLButtonElement).disabled).toBe(true)
    w.findAll('.ui-repeater__move').forEach((btn) => {
      expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    })
    expect((w.find('input').element as HTMLInputElement).disabled).toBe(true)
  })

  it('each Remove button carries a per-row accessible name', () => {
    const w = mount(FieldRepeater, {
      props: { ...base, field: textRepeaterField, modelValue: [{ label: 'A' }, { label: 'B' }] },
    })
    const removeBtns = w.findAll('.ui-repeater__remove')
    expect(removeBtns[0]!.attributes('aria-label')).toBe('Remove item 1')
    expect(removeBtns[1]!.attributes('aria-label')).toBe('Remove item 2')
  })

  it('each row has role=group with a per-row aria-label', () => {
    const w = mount(FieldRepeater, {
      props: { ...base, field: textRepeaterField, modelValue: [{ label: 'A' }, { label: 'B' }] },
    })
    const rows = w.findAll('.ui-repeater__row')
    expect(rows[0]!.attributes('role')).toBe('group')
    expect(rows[0]!.attributes('aria-label')).toBe('Item 1')
    expect(rows[1]!.attributes('aria-label')).toBe('Item 2')
  })

  it('announces the new position in the live region after a button move', async () => {
    const w = mount(FieldRepeater, {
      props: { ...base, field: textRepeaterField, modelValue: [{ label: 'A' }, { label: 'B' }] },
    })
    await w.findAll('.ui-repeater__row')[1]!.findAll('.ui-repeater__move')[0]!.trigger('click')
    await flushPromises()
    expect(w.find('.ui-repeater__live').text()).toContain('Moved item to position 1 of 2')
  })

  it('nested repeater sub-field renders an inner Add item button', async () => {
    const nestedField = {
      type: 'repeater' as const,
      options: {
        fields: {
          title: { type: 'text' as const },
          items: {
            type: 'repeater' as const,
            options: { fields: { name: { type: 'text' as const } } },
          },
        },
      },
    }
    const w = mount(FieldRepeater, {
      props: { ...base, field: nestedField, modelValue: [{ title: 'Section', items: [] }] },
    })
    // The inner repeater resolves via the registry's async wrapper
    await flushPromises()
    const addBtns = w.findAll('.ui-repeater__add')
    // At least two: outer + inner
    expect(addBtns.length).toBeGreaterThanOrEqual(2)
  })

  it('focus selectors are scoped to the outer row actions, not a nested repeater', async () => {
    const nestedField = {
      type: 'repeater' as const,
      options: {
        fields: {
          label: { type: 'text' as const },
          items: { type: 'repeater' as const, options: { fields: { name: { type: 'text' as const } } } },
        },
      },
    }
    const w = mount(FieldRepeater, {
      props: { ...base, field: nestedField, modelValue: [{ label: 'A', items: [{ name: 'x' }] }] },
    })
    await flushPromises() // resolve the async inner repeater so it renders its own row + remove button
    const outerRow = w.find('.ui-repeater__rows').element
      .querySelector(':scope > .ui-repeater__row-wrap > .ui-repeater__row') as HTMLElement
    // The populated inner repeater contributes its own remove button inside the outer row's fields,
    // so an UNSCOPED query would match a nested button first.
    expect(outerRow.querySelectorAll('.ui-repeater__remove').length).toBeGreaterThan(1)
    expect(outerRow.querySelector('.ui-repeater__remove')!.closest('.ui-repeater__fields')).not.toBeNull()
    // The scoped selector used by moveRow/removeRowAt returns the OUTER row's own button.
    const scoped = outerRow.querySelector(':scope > .ui-repeater__actions > .ui-repeater__remove')
    expect(scoped).not.toBeNull()
    expect(scoped!.closest('.ui-repeater__fields')).toBeNull()
  })

  it('announces removal in the live region', async () => {
    const w = mount(FieldRepeater, {
      props: { ...base, field: textRepeaterField, modelValue: [{ label: 'A' }, { label: 'B' }] },
    })
    await w.findAll('.ui-repeater__remove')[0]!.trigger('click')
    expect(w.find('.ui-repeater__live').text()).toContain('removed')
  })

  it('duplicate button emits a model with the row cloned right after', async () => {
    const w = mount(FieldRepeater, {
      props: {
        ...base,
        field: textRepeaterField,
        modelValue: [{ label: 'A' }, { label: 'B' }],
      },
    })
    await w.findAll('.ui-repeater__duplicate')[0]!.trigger('click')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0] as Record<string, unknown>[]
    expect(emitted.length).toBe(3)
    expect(emitted[0]!.label).toBe('A')
    expect(emitted[1]!.label).toBe('A')
    expect(emitted[2]!.label).toBe('B')
  })

  it('insert zone button emits a model with a blank row at that position', async () => {
    const w = mount(FieldRepeater, {
      props: {
        ...base,
        field: textRepeaterField,
        modelValue: [{ label: 'A' }, { label: 'B' }],
      },
    })
    // [0] = before row 0, [1] = before row 1, [2] = after last
    const insertBtns = w.findAll('.ui-repeater__insert')
    await insertBtns[1]!.trigger('click')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0] as Record<string, unknown>[]
    expect(emitted.length).toBe(3)
    expect(emitted[0]!.label).toBe('A')
    expect(emitted[1]!.label).toBeNull()
    expect(emitted[2]!.label).toBe('B')
  })

  it('gutter has draggable=true and aria-hidden=true', () => {
    const w = mount(FieldRepeater, {
      props: {
        ...base,
        field: textRepeaterField,
        modelValue: [{ label: 'A' }],
      },
    })
    const gutter = w.find('.ui-repeater__gutter')
    expect(gutter.attributes('draggable')).toBe('true')
    expect(gutter.attributes('aria-hidden')).toBe('true')
  })

  it('action buttons contain UiIcon svg elements', () => {
    const w = mount(FieldRepeater, {
      props: {
        ...base,
        field: textRepeaterField,
        modelValue: [{ label: 'A' }],
      },
    })
    const row = w.find('.ui-repeater__row')
    expect(row.find('.ui-repeater__remove svg.ui-icon').exists()).toBe(true)
    expect(row.find('.ui-repeater__duplicate svg.ui-icon').exists()).toBe(true)
    expect(row.find('.ui-repeater__move svg.ui-icon').exists()).toBe(true)
  })
})
