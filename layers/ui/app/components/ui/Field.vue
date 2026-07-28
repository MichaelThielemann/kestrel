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

const { fieldId, hintId, errId, describedby, ariaInvalid } = useFieldA11y(props)

const slotProps = computed(() => ({
  id: fieldId.value,
  'aria-invalid': ariaInvalid.value,
  'aria-describedby': describedby.value,
  required: props.required,
}))
</script>

<template>
  <div class="ui-field" :data-invalid="error ? 'true' : undefined">
    <label v-if="label" :for="fieldId" class="ui-field__label">
      {{ label }}<span v-if="required" class="ui-field__required" aria-hidden="true">*</span>
    </label>
    <slot v-bind="slotProps" />
    <p v-if="hint" :id="hintId" class="ui-field__hint">{{ hint }}</p>
    <p v-if="error" :id="errId" class="ui-field__error" role="alert">{{ error }}</p>
  </div>
</template>

<style lang="scss">
.ui-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);

  &__label {
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
