<script setup lang="ts">
import { computed } from 'vue'
import UiField from '../ui/Field.vue'
import UiNumberInput from '../ui/NumberInput.vue'
import { fieldConstraints } from '../../../../fields/app/utils/field-meta'
import type { FieldComponentProps } from '../../utils/field-component'
import type { FieldOf } from '../../../../core/server/utils/defineCollection'

const props = defineProps<FieldComponentProps>()
const model = defineModel<number | null>()
const c = computed(() => fieldConstraints(props.field))
// Display-only unit suffix (e.g. 'rem'); the stored value stays a bare number.
const unit = computed(() => (props.field.type === 'number' ? (props.field as FieldOf<'number'>).options?.unit : undefined))
</script>

<template>
  <UiField :id="id" :label="name" :error="error" :required="c.required">
    <template #default="f">
      <UiNumberInput
        v-model="model"
        :min="c.min"
        :max="c.max"
        :step="c.step"
        :suffix="unit"
        :disabled="disabled"
        v-bind="f"
      />
    </template>
  </UiField>
</template>
