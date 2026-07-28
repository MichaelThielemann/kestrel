<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    variant?: 'info' | 'success' | 'warning' | 'error'
  }>(),
  { variant: 'info' },
)

const role = computed(() =>
  props.variant === 'error' || props.variant === 'warning' ? 'alert' : 'status',
)
</script>

<template>
  <div class="ui-alert" :class="`ui-alert--${variant}`" :role="role">
    <p v-if="$slots.title?.()?.[0]" class="ui-alert__title"><slot name="title" /></p>
    <div class="ui-alert__body"><slot /></div>
  </div>
</template>

<style lang="scss">
.ui-alert {
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-inline-start-width: 4px;
  border-radius: var(--radius-md);
  background: var(--color-surface);
  font-size: var(--text-sm);

  &__title {
    font-weight: var(--weight-bold);
    margin-bottom: var(--space-1);
  }

  &--info {
    border-inline-start-color: var(--color-primary);
  }
  &--success {
    border-inline-start-color: var(--color-success);
  }
  &--warning {
    border-inline-start-color: var(--color-warning);
  }
  &--error {
    border-inline-start-color: var(--color-danger);
  }
}
</style>
