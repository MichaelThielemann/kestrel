<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import UiField from '../ui/Field.vue'
import UiTextarea from '../ui/Textarea.vue'
import { fieldConstraints, tryParseJson } from '@kestrel/fields/client'
import type { FieldComponentProps } from '../../utils/field-component'

const props = defineProps<FieldComponentProps>()
const model = defineModel<unknown>()
const c = computed(() => fieldConstraints(props.field))

const serialize = (v: unknown) => (v == null ? '' : JSON.stringify(v, null, 2))
const raw = ref(serialize(model.value))
const localError = ref<string | null>(null)

// Reseed only when the model genuinely differs from what the textarea holds, so our own valid edits
// never clobber the user's in-progress text. The watch only fires on a model CHANGE, and onInput never
// writes `model` while the text is invalid — so a fire while the textarea holds invalid JSON is always
// an EXTERNAL change (applyFrom / reset). That invalid text is not an edit worth protecting: take the
// external value and clear the stale error, rather than silently dropping the update.
watch(model, (v) => {
  const current = tryParseJson(raw.value)
  if (!current.ok) {
    raw.value = serialize(v)
    localError.value = null
    return
  }
  if (JSON.stringify(v) !== JSON.stringify(current.value)) raw.value = serialize(v)
})

function onInput(value: string | null | undefined) {
  raw.value = value ?? ''
  if (raw.value.trim() === '') {
    localError.value = null
    model.value = null
    return
  }
  const parsed = tryParseJson(raw.value)
  if (parsed.ok) {
    localError.value = null
    model.value = parsed.value
  } else {
    localError.value = 'Invalid JSON.'
  }
}

const shownError = computed(() => localError.value ?? props.error ?? null)
</script>

<template>
  <UiField :id="id" :label="name" :error="shownError" :required="c.required">
    <template #default="f">
      <UiTextarea
        :model-value="raw"
        :rows="6"
        :disabled="disabled"
        v-bind="f"
        @update:model-value="onInput"
      />
    </template>
  </UiField>
</template>
