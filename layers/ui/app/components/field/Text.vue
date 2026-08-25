<script setup lang="ts">
import { computed } from 'vue'
import UiField from '../ui/Field.vue'
import UiTextInput from '../ui/TextInput.vue'
import UiTextarea from '../ui/Textarea.vue'
import { fieldConstraints } from '@kestrel/fields/client'
import type { FieldComponentProps } from '../../utils/field-component'

const props = defineProps<FieldComponentProps>()
const model = defineModel<string | null>()
const c = computed(() => fieldConstraints(props.field))
</script>

<template>
  <UiField :id="id" :label="name" :error="error" :required="c.required">
    <template #default="f">
      <UiTextarea
        v-if="c.multiline"
        v-model="model"
        :disabled="disabled"
        :maxlength="c.maxlength"
        :minlength="c.minlength"
        v-bind="f"
      />
      <UiTextInput
        v-else
        v-model="model"
        :disabled="disabled"
        :maxlength="c.maxlength"
        :minlength="c.minlength"
        v-bind="f"
      />
    </template>
  </UiField>
</template>
