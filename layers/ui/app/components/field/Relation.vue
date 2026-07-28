<script setup lang="ts">
import { computed } from 'vue'
import UiField from '../ui/Field.vue'
import UiCombobox from '../ui/Combobox.vue'
import { useRecordOptions } from '../../composables/useRecordOptions'
import type { FieldComponentProps } from '../../utils/field-component'
import type { FieldOf } from '../../../../core/server/utils/defineCollection'

const props = defineProps<FieldComponentProps>()
const model = defineModel<number | number[] | null>()

const cfg = computed(() => {
  if (props.field.type !== 'relation') return { collection: '', many: false, label: undefined as string | undefined }
  const r = (props.field as FieldOf<'relation'>).relation
  return { collection: r.collection, many: !!r.many, label: r.labelField }
})
const required = computed(() => !!props.field.required)

const ids = computed<number[]>(() =>
  cfg.value.many ? (Array.isArray(model.value) ? model.value : []) : (typeof model.value === 'number' ? [model.value] : []))

const collection = computed(() => cfg.value.collection)
const locale = computed(() => props.locale)
const labelField = computed(() => cfg.value.label)

const { options, selected, loading, onSearch } = useRecordOptions(collection, ids, locale, labelField)
const { t } = useT()
</script>

<template>
  <UiField :id="id" :label="name" :error="error" :required="required">
    <template #default="f">
      <UiCombobox
        v-model="model"
        :options="options"
        :selected="selected"
        :multiple="cfg.many"
        :loading="loading"
        :disabled="disabled"
        :placeholder="t('field.relation.placeholder')"
        :input-id="f.id"
        :invalid="f['aria-invalid'] === 'true'"
        :describedby="f['aria-describedby']"
        :required="f.required"
        @search="onSearch"
      />
    </template>
  </UiField>
</template>
