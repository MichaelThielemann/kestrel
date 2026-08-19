<script setup lang="ts">
import { computed } from 'vue'
import UiIcon from './Icon.vue'
import {
  DateRangePickerRoot, DateRangePickerField, DateRangePickerInput, DateRangePickerTrigger,
  DateRangePickerContent, DateRangePickerArrow, DateRangePickerCalendar,
  DateRangePickerHeader, DateRangePickerPrev, DateRangePickerHeading, DateRangePickerNext,
  DateRangePickerGrid, DateRangePickerGridHead, DateRangePickerGridBody, DateRangePickerGridRow,
  DateRangePickerHeadCell, DateRangePickerCell, DateRangePickerCellTrigger,
} from 'reka-ui'
import type { DateValue } from '@internationalized/date'
import { isoToDate, dateToIso, type IsoPrecision } from '../../utils/iso-date'

const { t } = useT()
const props = withDefaults(
  defineProps<{
    precision?: IsoPrecision
    disabled?: boolean
    locale?: string
    // a11y: see DatePicker — the field name rides as an aria-label on the role=group field.
    ariaLabel?: string
    describedby?: string
    invalid?: boolean
    required?: boolean
  }>(),
  { precision: 'datetime', disabled: false },
)
const model = defineModel<{ start: string; end: string } | null>()

const displayLocale = computed(() => props.locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en'))
const granularity = computed(() => (props.precision === 'date' ? 'day' : 'minute'))
const value = computed<{ start: DateValue | undefined; end: DateValue | undefined }>({
  get: () => ({
    start: isoToDate(model.value?.start, props.precision),
    end: isoToDate(model.value?.end, props.precision),
  }),
  set: (v) => {
    const start = dateToIso(v.start)
    const end = dateToIso(v.end)
    // Preserve a partial selection (Reka commits start before end) as empty strings.
    model.value = start || end ? { start: start ?? '', end: end ?? '' } : null
  },
})
</script>

<template>
  <DateRangePickerRoot v-model="value" :granularity="granularity" :disabled="disabled" :locale="displayLocale">
    <DateRangePickerField
      v-slot="{ segments }"
      class="ui-datepicker__field"
      role="group"
      :aria-label="ariaLabel"
      :aria-describedby="describedby"
      :aria-invalid="invalid || undefined"
      :aria-required="required || undefined"
    >
      <template v-for="item in segments.start" :key="`s-${item.part}`">
        <DateRangePickerInput :part="item.part" type="start" class="ui-datepicker__segment">{{ item.value }}</DateRangePickerInput>
      </template>
      <span class="ui-datepicker__sep" aria-hidden="true">–</span>
      <template v-for="item in segments.end" :key="`e-${item.part}`">
        <DateRangePickerInput :part="item.part" type="end" class="ui-datepicker__segment">{{ item.value }}</DateRangePickerInput>
      </template>
      <DateRangePickerTrigger class="ui-datepicker__trigger" :aria-label="t('dateRange.openCalendar')"><UiIcon name="calendar" :size="16" /></DateRangePickerTrigger>
    </DateRangePickerField>

    <DateRangePickerContent class="ui-datepicker__content" :side-offset="6">
      <DateRangePickerArrow class="ui-datepicker__arrow" />
      <DateRangePickerCalendar v-slot="{ weekDays, grid }" class="ui-datepicker__calendar">
        <DateRangePickerHeader class="ui-datepicker__header">
          <DateRangePickerPrev class="ui-datepicker__nav" :aria-label="t('dateRange.previousMonth')">‹</DateRangePickerPrev>
          <DateRangePickerHeading class="ui-datepicker__heading" />
          <DateRangePickerNext class="ui-datepicker__nav" :aria-label="t('dateRange.nextMonth')">›</DateRangePickerNext>
        </DateRangePickerHeader>
        <DateRangePickerGrid v-for="month in grid" :key="month.value.toString()" class="ui-datepicker__grid">
          <DateRangePickerGridHead>
            <DateRangePickerGridRow class="ui-datepicker__row">
              <DateRangePickerHeadCell v-for="day in weekDays" :key="day" class="ui-datepicker__weekday">{{ day }}</DateRangePickerHeadCell>
            </DateRangePickerGridRow>
          </DateRangePickerGridHead>
          <DateRangePickerGridBody>
            <DateRangePickerGridRow v-for="(weekDates, i) in month.rows" :key="`w${i}`" class="ui-datepicker__row">
              <DateRangePickerCell v-for="weekDate in weekDates" :key="weekDate.toString()" :date="weekDate">
                <DateRangePickerCellTrigger :day="weekDate" :month="month.value" class="ui-datepicker__cell" />
              </DateRangePickerCell>
            </DateRangePickerGridRow>
          </DateRangePickerGridBody>
        </DateRangePickerGrid>
      </DateRangePickerCalendar>
    </DateRangePickerContent>
  </DateRangePickerRoot>
</template>

<style lang="scss">
// Shares the global (non-scoped) datepicker chrome — the calendar is teleported to <body>, so a
// `scoped` block would silently drop these styles. Included explicitly rather than borrowing them
// from DatePicker being present on the page.
@use '../../assets/scss/datepicker';
@include datepicker.ui-datepicker;
</style>
