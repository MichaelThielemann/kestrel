import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import Combobox from './Combobox.vue'

const options = [{ value: 1, label: 'Apple' }, { value: 2, label: 'Banana' }]
const threeOptions = [
  { value: 1, label: 'Apple' },
  { value: 2, label: 'Banana' },
  { value: 3, label: 'Cherry' },
]

describe('UiCombobox', () => {
  it('renders the input with placeholder and emits search on typing', async () => {
    const w = mount(Combobox, { props: { options: [], selected: [], placeholder: 'Search…' } })
    const input = w.get('input')
    expect(input.attributes('placeholder')).toBe('Search…')
    await input.setValue('app')
    expect(w.emitted('search')?.at(-1)).toEqual(['app'])
  })

  it('shows the selected label in the input (single)', async () => {
    const w = mount(Combobox, { props: { options, selected: [{ value: 1, label: 'Apple' }], modelValue: 1 } })
    await w.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 0))
    expect((w.get('input').element as HTMLInputElement).value).toBe('Apple')
  })

  it('renders removable chips for multiple and emits the trimmed model', async () => {
    const w = mount(Combobox, {
      props: { options, selected: [{ value: 1, label: 'Apple' }, { value: 2, label: 'Banana' }], modelValue: [1, 2], multiple: true },
    })
    expect(w.findAll('.ui-combobox__chip').length).toBe(2)
    await w.get('[aria-label="Remove Apple"]').trigger('click')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([[2]])
  })

  it('forwards id and aria wiring onto the input', () => {
    const w = mount(Combobox, {
      props: { options: [], selected: [], inputId: 'rel-1', invalid: true, describedby: 'rel-1-error', required: true },
    })
    const input = w.get('input')
    expect(input.attributes('id')).toBe('rel-1')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(input.attributes('aria-describedby')).toBe('rel-1-error')
    expect(input.attributes('required')).toBeDefined()
  })

  it('selects an option and emits its id (single)', async () => {
    const w = mount(Combobox, { props: { options, selected: [], modelValue: null } })
    await w.get('input').trigger('focus')
    await w.vm.$nextTick()
    const items = w.findAll('.ui-combobox__item')
    expect(items.length).toBe(2)
    await items[0]!.trigger('click')
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual([1])
  })

  it('emits search("") on focus when the query is empty so the list can load', async () => {
    const w = mount(Combobox, { props: { options: [], selected: [], modelValue: null } })
    await w.get('input').trigger('focus')
    expect(w.emitted('search')?.some((e) => e[0] === '')).toBe(true)
  })

  it('does not list-search on focus when a value is already selected', async () => {
    const w = mount(Combobox, { props: { options, selected: [{ value: 1, label: 'Apple' }], modelValue: 1 } })
    await w.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 0))
    await w.get('input').trigger('focus')
    expect(w.emitted('search')?.some((e) => e[0] === '')).toBeFalsy()
  })

  describe('chip reordering (multiple mode)', () => {
    function mountMultiple() {
      return mount(Combobox, {
        props: {
          options: threeOptions,
          selected: threeOptions,
          modelValue: [1, 2, 3],
          multiple: true,
        },
      })
    }

    it('renders move-earlier and move-later buttons with correct aria-labels', () => {
      const w = mountMultiple()
      expect(w.find('[aria-label="Move Apple earlier"]').exists()).toBe(true)
      expect(w.find('[aria-label="Move Apple later"]').exists()).toBe(true)
      expect(w.find('[aria-label="Move Banana earlier"]').exists()).toBe(true)
      expect(w.find('[aria-label="Move Banana later"]').exists()).toBe(true)
      expect(w.find('[aria-label="Move Cherry earlier"]').exists()).toBe(true)
      expect(w.find('[aria-label="Move Cherry later"]').exists()).toBe(true)
    })

    it('clicking › on the first chip emits update:modelValue with swapped order', async () => {
      const w = mountMultiple()
      await w.get('[aria-label="Move Apple later"]').trigger('click')
      expect(w.emitted('update:modelValue')?.at(-1)).toEqual([[2, 1, 3]])
    })

    it('clicking ‹ on the first chip is disabled (no emit)', async () => {
      const w = mountMultiple()
      const btn = w.get('[aria-label="Move Apple earlier"]')
      expect((btn.element as HTMLButtonElement).disabled).toBe(true)
      await btn.trigger('click')
      expect(w.emitted('update:modelValue')).toBeUndefined()
    })

    it('clicking › on the last chip is disabled (no emit)', async () => {
      const w = mountMultiple()
      const btn = w.get('[aria-label="Move Cherry later"]')
      expect((btn.element as HTMLButtonElement).disabled).toBe(true)
      await btn.trigger('click')
      expect(w.emitted('update:modelValue')).toBeUndefined()
    })

    it('clicking ‹ on a middle chip emits reordered model', async () => {
      const w = mountMultiple()
      await w.get('[aria-label="Move Banana earlier"]').trigger('click')
      expect(w.emitted('update:modelValue')?.at(-1)).toEqual([[2, 1, 3]])
    })

    it('dragstart on chip 0 then drop on chip 1 emits reordered model', async () => {
      const w = mountMultiple()
      const chips = w.findAll('.ui-combobox__chip')
      expect(chips.length).toBe(3)

      const dt = { setData: () => {}, effectAllowed: '' }
      await chips[0]!.trigger('dragstart', { dataTransfer: dt })
      await chips[1]!.trigger('drop', { dataTransfer: dt })

      expect(w.emitted('update:modelValue')?.at(-1)).toEqual([[2, 1, 3]])
    })

    it('dropping a chip on itself does not emit', async () => {
      const w = mountMultiple()
      const chips = w.findAll('.ui-combobox__chip')
      const dt = { setData: () => {}, effectAllowed: '' }
      await chips[1]!.trigger('dragstart', { dataTransfer: dt })
      await chips[1]!.trigger('drop', { dataTransfer: dt })
      expect(w.emitted('update:modelValue')).toBeUndefined()
    })

    it('does not reorder via drag when disabled', async () => {
      const w = mount(Combobox, {
        props: { options: threeOptions, selected: threeOptions, modelValue: [1, 2, 3], multiple: true, disabled: true },
      })
      const chips = w.findAll('.ui-combobox__chip')
      const dt = { setData: () => {}, effectAllowed: '' }
      await chips[0]!.trigger('dragstart', { dataTransfer: dt })
      await chips[1]!.trigger('drop', { dataTransfer: dt })
      expect(w.emitted('update:modelValue')).toBeUndefined()
    })

    it('marks the chip list with role="list" (WebKit list-semantics fix)', () => {
      const w = mountMultiple()
      expect(w.find('ul.ui-combobox__chips').attributes('role')).toBe('list')
    })

    it('announces the new position via an aria-live region after a move', async () => {
      const w = mountMultiple()
      await w.get('[aria-label="Move Apple later"]').trigger('click')
      await nextTick()
      const live = w.find('.ui-combobox__live')
      expect(live.attributes('aria-live')).toBe('polite')
      expect(live.text()).toBe('Moved Apple to position 2 of 3')
    })
  })
})
