import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import FieldLayout from './Layout.vue'
import type { FieldDef, LayoutNode } from '@kestrel/core'
const fields = {
  a: { type: 'text' },
  b: { type: 'text' },
  c: { type: 'text' },
} as unknown as Record<string, FieldDef>

const base = { fields, locale: 'en', errors: {} as Record<string, string> }

describe('FieldLayout', () => {
  it('renders a multi-column row with the grid template as a custom property', async () => {
    const layout: LayoutNode[] = [{ kind: 'row', fields: ['a', 'b'], tracks: [2, 1] }]
    const w = await mountSuspended(FieldLayout, { props: { ...base, layout, values: {} } })
    await flushPromises()
    const row = w.find('.ui-field-row')
    expect(row.exists()).toBe(true)
    expect(row.attributes('style')).toContain('--ui-field-cols: 2fr 1fr')
    expect(w.findAll('.ui-field-cell').length).toBe(2)
  })

  it('renders a named group as a fieldset + legend (localized label resolved for the active lang)', async () => {
    const layout: LayoutNode[] = [
      { kind: 'group', label: { en: 'Meta', de: 'Metadaten' }, rows: [{ kind: 'row', fields: ['a'], tracks: [1] }] },
    ]
    const w = await mountSuspended(FieldLayout, { props: { ...base, layout, values: {} } })
    await flushPromises()
    expect(w.find('fieldset.ui-field-group').exists()).toBe(true)
    expect(w.find('.ui-field-group__legend').text()).toBe('Meta')
  })

  it('renders every field a resolved layout lists, including an appended full-width row', async () => {
    // The shape resolveFieldLayout emits for `[['a','b']]` over {a,b,c}: the two-col row + c appended.
    const layout: LayoutNode[] = [
      { kind: 'row', fields: ['a', 'b'], tracks: [1, 1] },
      { kind: 'row', fields: ['c'], tracks: [1] },
    ]
    const w = await mountSuspended(FieldLayout, { props: { ...base, layout, values: {} } })
    await flushPromises()
    expect(w.findAll('.ui-field-cell').length).toBe(3)
    expect(w.findAll('input').length).toBe(3)
  })

  it('falls back to one full-width row per field when no layout is given (parity with the old flat form)', async () => {
    const w = await mountSuspended(FieldLayout, { props: { ...base, values: {} } })
    await flushPromises()
    expect(w.find('fieldset.ui-field-group').exists()).toBe(false)
    expect(w.findAll('.ui-field-row').length).toBe(3)
    expect(w.findAll('.ui-field-cell').length).toBe(3)
  })

  it('omits the cell of a field whose condition is unmet, and shows it when met', async () => {
    const conditional = {
      a: { type: 'text' },
      b: { type: 'text', condition: { field: 'a', is: 'x' } },
    } as unknown as Record<string, FieldDef>

    const hidden = await mountSuspended(FieldLayout, { props: { fields: conditional, locale: 'en', values: { a: 'y' } } })
    await flushPromises()
    expect(hidden.findAll('.ui-field-cell').length).toBe(1)

    const shown = await mountSuspended(FieldLayout, { props: { fields: conditional, locale: 'en', values: { a: 'x' } } })
    await flushPromises()
    expect(shown.findAll('.ui-field-cell').length).toBe(2)
  })

  it('collapses a hidden field\'s grid track so surviving cells keep their authored column (F2 regression)', async () => {
    // Row [a|2, b|1]: hiding a field must drop ITS track, never leave an empty trailing column that
    // shifts the survivor out of its authored place.
    const layout: LayoutNode[] = [{ kind: 'row', fields: ['a', 'b'], tracks: [2, 1] }]

    const leadHidden = {
      a: { type: 'text', condition: { field: 'gate', is: 'on' } },
      b: { type: 'text' },
    } as unknown as Record<string, FieldDef>

    // a hidden → only b's authored 1fr track survives (not the stale '2fr 1fr').
    const hidden = await mountSuspended(FieldLayout, { props: { fields: leadHidden, locale: 'en', layout, values: { gate: 'off' } } })
    await flushPromises()
    expect(hidden.findAll('.ui-field-cell').length).toBe(1)
    expect(hidden.find('.ui-field-row').attributes('style')).toContain('--ui-field-cols: 1fr')

    // a visible → both authored tracks, in order.
    const shown = await mountSuspended(FieldLayout, { props: { fields: leadHidden, locale: 'en', layout, values: { gate: 'on' } } })
    await flushPromises()
    expect(shown.findAll('.ui-field-cell').length).toBe(2)
    expect(shown.find('.ui-field-row').attributes('style')).toContain('--ui-field-cols: 2fr 1fr')

    // Trailing field hidden → the survivor keeps its authored 2fr (proves widths track the surviving cell).
    const trailHidden = {
      a: { type: 'text' },
      b: { type: 'text', condition: { field: 'gate', is: 'on' } },
    } as unknown as Record<string, FieldDef>
    const trail = await mountSuspended(FieldLayout, { props: { fields: trailHidden, locale: 'en', layout, values: { gate: 'off' } } })
    await flushPromises()
    expect(trail.findAll('.ui-field-cell').length).toBe(1)
    expect(trail.find('.ui-field-row').attributes('style')).toContain('--ui-field-cols: 2fr')
  })

  it('forwards a non-empty error to the field, and treats an empty-string error as no error', async () => {
    const withError = await mountSuspended(FieldLayout, { props: { ...base, values: {}, errors: { a: 'Required' } } })
    await flushPromises()
    expect(withError.find('.ui-field__error').exists()).toBe(true)
    expect(withError.find('.ui-field__error').text()).toBe('Required')

    // An empty string is not a real error — `|| null` must coalesce it so no error UI shows for field a.
    const emptyError = await mountSuspended(FieldLayout, { props: { ...base, values: {}, errors: { a: '' } } })
    await flushPromises()
    expect(emptyError.find('.ui-field__error').exists()).toBe(false)
  })

  it('shows a stale-reference note only for a field in deadFields', async () => {
    const w = await mountSuspended(FieldLayout, { props: { ...base, values: {}, deadFields: new Set(['a']) } })
    await flushPromises()
    expect(w.findAll('.field-dead-ref').length).toBe(1)

    const clean = await mountSuspended(FieldLayout, { props: { ...base, values: {} } })
    await flushPromises()
    expect(clean.find('.field-dead-ref').exists()).toBe(false)
  })

  it('emits (name, value) when a field is edited', async () => {
    const w = await mountSuspended(FieldLayout, { props: { ...base, values: { a: '', b: '', c: '' } } })
    await flushPromises()
    await w.findAll('input')[0]!.setValue('hi')
    expect(w.emitted('update')?.at(-1)).toEqual(['a', 'hi'])
  })
})
