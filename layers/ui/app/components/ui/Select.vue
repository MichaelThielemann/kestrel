<script setup lang="ts">
import UiIcon from './Icon.vue'

defineOptions({ inheritAttrs: false })

withDefaults(
  defineProps<{
    options: { label: string; value: string }[]
    placeholder?: string
    disabled?: boolean
  }>(),
  { disabled: false },
)

const model = defineModel<string | null>()
</script>

<template>
  <span class="ui-select">
    <!-- eslint-disable-next-line vuejs-accessibility/form-control-has-label -- id/label land via v-bind="$attrs" from the wrapping UiField, invisible to static analysis -->
    <select v-model="model" :disabled="disabled" class="ui-select__field" v-bind="$attrs">
      <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
    <UiIcon name="chevron-down" :size="14" class="ui-select__icon" />
  </span>
</template>

<style lang="scss">
@use '../../assets/scss/mixins';

.ui-select {
  position: relative;
  display: block;
  width: 100%;
}
.ui-select__field {
  @include mixins.input-base;
  width: 100%;
  appearance: none;
  // leave room for the overlaid chevron so long values don't run under it
  padding-right: calc(var(--space-3) + 1.25rem);
}
.ui-select__icon {
  position: absolute;
  top: 50%;
  right: var(--space-3);
  transform: translateY(-50%);
  pointer-events: none; // clicks fall through to the native select
  color: var(--color-text-muted);
}
</style>
