<script setup lang="ts">
import { computed } from 'vue'
import { ToggleGroupRoot, ToggleGroupItem } from 'reka-ui'
import UiIcon from './Icon.vue'
import type { IconName } from '../../utils/icons'

const props = withDefaults(
  defineProps<{
    options: { label: string; value: string; icon?: IconName }[]
    multiple?: boolean
    disabled?: boolean
  }>(),
  { multiple: false, disabled: false },
)

const model = defineModel<string | string[] | null>()

const current = computed(() =>
  props.multiple ? (Array.isArray(model.value) ? model.value : []) : (model.value ?? undefined),
)

// reka's ToggleGroupRoot emits the broad `AcceptableValue`; an `unknown` param satisfies that contract and
// we coerce back to our `string | string[]` model here.
function onUpdate(v: unknown) {
  if (props.multiple) model.value = Array.isArray(v) ? (v as string[]) : []
  else model.value = v ? (v as string) : null
}
</script>

<template>
  <ToggleGroupRoot
    :model-value="current"
    :type="multiple ? 'multiple' : 'single'"
    :disabled="disabled"
    class="ui-btngroup"
    @update:model-value="onUpdate"
  >
    <ToggleGroupItem
      v-for="o in options"
      :key="o.value"
      :value="o.value"
      :disabled="disabled"
      class="ui-btngroup__item"
    >
      <UiIcon v-if="o.icon" :name="o.icon" :size="15" />
      {{ o.label }}
    </ToggleGroupItem>
  </ToggleGroupRoot>
</template>

<style lang="scss">
@use '../../assets/scss/mixins';

.ui-btngroup {
  display: inline-flex;
  // Wrap is required: this is a shared primitive (field/Choice renders it with arbitrary options), so a
  // long set must break onto multiple rows rather than overflow/clip. A 2-item toggle never wraps anyway.
  flex-wrap: wrap;
  border: 1px solid var(--color-control-border, var(--color-border));
  border-radius: var(--radius-md);
  overflow: hidden;
  width: fit-content;

  &__item {
    @include mixins.focus-ring;
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border: 0;
    border-inline-start: 1px solid var(--color-control-border, var(--color-border));
    background: var(--color-surface);
    color: var(--color-text);
    font-size: var(--text-sm);
    cursor: pointer;

    &:first-child {
      border-inline-start: 0;
    }
    &:hover {
      background: var(--color-hover);
    }
    // Neutral fill + an indigo label so the active segment reads at a glance (the fill alone is too
    // close to the hover wash to rely on). Fallback for use outside the themed admin shell.
    &[data-state='on'] {
      background: var(--color-active, var(--color-surface-2));
      color: var(--color-primary-on-fill, var(--color-primary));
      font-weight: var(--weight-medium);
    }
    &[data-disabled] {
      opacity: 0.6;
      cursor: not-allowed;
    }
  }
}
</style>
