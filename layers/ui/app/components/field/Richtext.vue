<script setup lang="ts">
import { computed } from 'vue'
import UiField from '../ui/Field.vue'
import UiRichtext from '../ui/Richtext.vue'
import type { FieldComponentProps } from '../../utils/field-component'

const props = defineProps<FieldComponentProps>()
const model = defineModel<string | null>()
const required = computed(() => !!props.field.required)
</script>

<template>
  <UiField :id="id" :label="name" :error="error" :required="required">
    <template #default="f">
      <UiRichtext
        v-model="model"
        :disabled="disabled"
        :locale="locale"
        :aria-label="name"
        :describedby="f['aria-describedby']"
        :invalid="f['aria-invalid'] === 'true'"
        :required="!!f.required"
      />
    </template>
  </UiField>
</template>
