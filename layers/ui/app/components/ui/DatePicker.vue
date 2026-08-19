<script setup lang="ts">
import { computed } from 'vue'
import UiIcon from './Icon.vue'
import {
  DatePickerRoot, DatePickerField, DatePickerInput, DatePickerTrigger,
  DatePickerContent, DatePickerArrow, DatePickerCalendar,
  DatePickerHeader, DatePickerPrev, DatePickerHeading, DatePickerNext,
  DatePickerGrid, DatePickerGridHead, DatePickerGridBody, DatePickerGridRow,
  DatePickerHeadCell, DatePickerCell, DatePickerCellTrigger,
} from 'reka-ui'
import type { DateValue } from '@internationalized/date'
import { isoToDate, dateToIso, type IsoPrecision } from '../../utils/iso-date'

const { t } = useT()

const props = withDefaults(
  defineProps<{
    precision?: IsoPrecision
    disabled?: boolean
    locale?: string
    // a11y: the segmented control has no single labelable <input>, so the field name is carried as an
    // aria-label on the role=group field, with the error/hint + invalid/required state wired alongside.
    ariaLabel?: string
    describedby?: string
    invalid?: boolean
    required?: boolean
  }>(),
  { precision: 'datetime', disabled: false },
)
const model = defineModel<string | null>()

// Match the native inputs, which format to the browser locale. Overridable for a future admin-locale setting.
const displayLocale = computed(() => props.locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en'))
const granularity = computed(() => (props.precision === 'date' ? 'day' : 'minute'))
const value = computed<DateValue | undefined>({
  get: () => isoToDate(model.value, props.precision),
  set: (v) => { model.value = dateToIso(v) },
})
</script>

<template>
  <DatePickerRoot v-model="value" :granularity="granularity" :disabled="disabled" :locale="displayLocale">
    <DatePickerField
      v-slot="{ segments }"
      class="ui-datepicker__field"
      role="group"
      :aria-label="ariaLabel"
      :aria-describedby="describedby"
      :aria-invalid="invalid || undefined"
      :aria-required="required || undefined"
    >
      <DatePickerInput
        v-for="item in segments"
        :key="item.part"
        :part="item.part"
        class="ui-datepicker__segment"
      >{{ item.value }}</DatePickerInput>
      <DatePickerTrigger class="ui-datepicker__trigger" :aria-label="t('datePicker.openCalendar')"><UiIcon name="calendar" :size="16" /></DatePickerTrigger>
    </DatePickerField>

    <DatePickerContent class="ui-datepicker__content" :side-offset="6">
      <DatePickerArrow class="ui-datepicker__arrow" />
      <DatePickerCalendar v-slot="{ weekDays, grid }" class="ui-datepicker__calendar">
        <DatePickerHeader class="ui-datepicker__header">
          <DatePickerPrev class="ui-datepicker__nav" :aria-label="t('datePicker.previousMonth')">‹</DatePickerPrev>
          <DatePickerHeading class="ui-datepicker__heading" />
          <DatePickerNext class="ui-datepicker__nav" :aria-label="t('datePicker.nextMonth')">›</DatePickerNext>
        </DatePickerHeader>
        <DatePickerGrid v-for="month in grid" :key="month.value.toString()" class="ui-datepicker__grid">
          <DatePickerGridHead>
            <DatePickerGridRow class="ui-datepicker__row">
              <DatePickerHeadCell v-for="day in weekDays" :key="day" class="ui-datepicker__weekday">{{ day }}</DatePickerHeadCell>
            </DatePickerGridRow>
          </DatePickerGridHead>
          <DatePickerGridBody>
            <DatePickerGridRow v-for="(weekDates, i) in month.rows" :key="`w${i}`" class="ui-datepicker__row">
              <DatePickerCell v-for="weekDate in weekDates" :key="weekDate.toString()" :date="weekDate">
                <DatePickerCellTrigger :day="weekDate" :month="month.value" class="ui-datepicker__cell" />
              </DatePickerCell>
            </DatePickerGridRow>
          </DatePickerGridBody>
        </DatePickerGrid>
      </DatePickerCalendar>
    </DatePickerContent>
  </DatePickerRoot>
</template>

<style lang="scss">
// Shared, global (non-scoped) datepicker chrome — the calendar is teleported to <body>.
@use '../../assets/scss/datepicker';
@include datepicker.ui-datepicker;
</style>
