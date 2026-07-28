<script setup lang="ts">
import { computed } from 'vue'
import UiFieldset from '../ui/Fieldset.vue'
import UiButtonGroup from '../ui/ButtonGroup.vue'
import { nextBooleanValue } from '../../utils/boolean-field'
import type { FieldComponentProps } from '../../utils/field-component'

const props = defineProps<FieldComponentProps>()
const model = defineModel<boolean>()

const { t } = useT()
const boolOptions = computed(() => [
  { label: t('field.boolean.no'), value: 'false' },
  { label: t('field.boolean.yes'), value: 'true' },
])

const proxy = computed<string | string[] | null>({
  get: () => (model.value === true ? 'true' : model.value === false ? 'false' : null),
  set: (v) => { model.value = nextBooleanValue(model.value, v) },
})
const required = computed(() => !!props.field.required)
</script>

<template>
  <UiFieldset :id="id" :label="name" :error="error" :required="required">
    <template #default="f">
      <UiButtonGroup v-model="proxy" :options="boolOptions" :disabled="disabled" v-bind="f" />
    </template>
  </UiFieldset>
</template>
