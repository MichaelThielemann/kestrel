import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DatePicker from './DatePicker.vue'
import DateRangePicker from './DateRangePicker.vue'

// Smoke tests only: the calendar popover is teleported/floating and not rendered
// reliably under happy-dom, so the date logic lives in (and is tested via) iso-date.ts.
// Here we just assert the inline segment field mounts without throwing.

describe('UiDatePicker', () => {
  it('mounts a date field for precision=date', () => {
    const w = mount(DatePicker, { props: { modelValue: '2024-01-15', precision: 'date' } })
    expect(w.find('.ui-datepicker__field').exists()).toBe(true)
  })

  it('mounts a datetime field for precision=datetime with no value', () => {
    const w = mount(DatePicker, { props: { modelValue: null, precision: 'datetime' } })
    expect(w.find('.ui-datepicker__field').exists()).toBe(true)
  })
})

describe('UiDateRangePicker', () => {
  it('mounts a range field with a start/end value', () => {
    const w = mount(DateRangePicker, {
      props: { modelValue: { start: '2024-01-01', end: '2024-01-31' }, precision: 'date' },
    })
    expect(w.find('.ui-datepicker__field').exists()).toBe(true)
    expect(w.find('.ui-datepicker__sep').exists()).toBe(true)
  })
})
