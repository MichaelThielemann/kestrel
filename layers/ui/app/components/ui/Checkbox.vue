<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'

const props = withDefaults(
  defineProps<{
    disabled?: boolean
    /** Tri-state marker for a "some but not all" selection (e.g. a select-all header). */
    indeterminate?: boolean
  }>(),
  { disabled: false, indeterminate: false },
)

// Defaulted so the emitted value is a plain `boolean`: an undefined-able model would force every
// handler to coerce, and an unbound checkbox is unchecked anyway.
const model = defineModel<boolean>({ default: false })

// `indeterminate` is a DOM PROPERTY with no HTML attribute, so it can't be bound in the template and must
// be assigned imperatively: once on mount (the element now exists) and again whenever the prop changes.
const input = ref<HTMLInputElement | null>(null)
function syncIndeterminate() {
  if (input.value) input.value.indeterminate = props.indeterminate
}
onMounted(syncIndeterminate)
watch(() => props.indeterminate, syncIndeterminate)
</script>

<template>
  <!-- eslint-disable-next-line vuejs-accessibility/form-control-has-label -- id/label land via UiField's attrs fallthrough (single root element), invisible to static analysis -->
  <input
    ref="input"
    v-model="model"
    type="checkbox"
    :disabled="disabled"
    class="ui-checkbox"
  >
</template>

<style lang="scss">
@use '../../assets/scss/mixins';

.ui-checkbox {
  @include mixins.focus-ring;
  width: 1.25rem;
  height: 1.25rem;
  accent-color: var(--color-primary);
  cursor: pointer;

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}
</style>
