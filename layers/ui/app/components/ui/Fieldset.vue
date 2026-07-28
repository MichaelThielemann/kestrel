<script setup lang="ts">
import { computed } from 'vue'
import { useFieldA11y } from '../../utils/useFieldA11y'

const props = defineProps<{
  label?: string
  hint?: string
  error?: string | null
  required?: boolean
  id?: string
}>()

const { fieldId, hintId, errId, describedby, ariaInvalid, ariaRequired } = useFieldA11y(props)

// No `id` — a group has no single control to point a label `for` at; the
// <legend> labels the group natively. Consumers spread these onto the group root.
const slotProps = computed(() => ({
  'aria-invalid': ariaInvalid.value,
  'aria-describedby': describedby.value,
  'aria-required': ariaRequired.value,
  required: props.required,
}))
</script>

<template>
  <fieldset class="ui-fieldset" :data-invalid="error ? 'true' : undefined">
    <legend v-if="label" class="ui-fieldset__legend">
      {{ label }}<span v-if="required" class="ui-fieldset__required" aria-hidden="true">*</span>
    </legend>
    <slot v-bind="slotProps" />
    <p v-if="hint" :id="hintId" class="ui-fieldset__hint">{{ hint }}</p>
    <p v-if="error" :id="errId" class="ui-fieldset__error" role="alert">{{ error }}</p>
  </fieldset>
</template>

<style lang="scss">
.ui-fieldset {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-inline-size: 0;
  margin: 0;
  padding: 0;
  border: 0;

  &__legend {
    padding: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
  &__required {
    color: var(--color-danger);
    margin-inline-start: var(--space-1);
  }
  &__hint {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }
  &__error {
    font-size: var(--text-sm);
    color: var(--color-danger);
  }
}
</style>
