<script setup lang="ts">
import type { IconName } from '../../utils/icons'

withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md' | 'lg'
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
    loading?: boolean
    icon?: IconName
  }>(),
  { variant: 'secondary', size: 'md', type: 'button', disabled: false, loading: false },
)
</script>

<template>
  <button
    :type="type"
    class="ui-button"
    :class="[`ui-button--${variant}`, `ui-button--${size}`]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="ui-button__spinner" aria-hidden="true" />
    <KestrelUiIcon v-else-if="icon" :name="icon" class="ui-button__icon" />
    <span v-if="$slots.default" class="ui-button__label"><slot /></span>
  </button>
</template>

<style lang="scss">
@use '../../assets/scss/mixins';

.ui-button {
  @include mixins.focus-ring;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-weight: var(--weight-medium);
  line-height: 1;
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard);

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  &--sm {
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-sm);
  }
  &--md {
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-base);
  }
  &--lg {
    padding: var(--space-3) var(--space-5);
    font-size: var(--text-lg);
  }

  &--primary {
    background: var(--color-primary);
    color: var(--color-on-primary);

    &:hover:not(:disabled) {
      background: var(--color-primary-hover);
    }
  }
  &--secondary {
    background: var(--color-surface);
    color: var(--color-text);
    border-color: var(--color-border);

    &:hover:not(:disabled) {
      background: var(--color-surface-2);
      border-color: var(--color-border-strong);
    }
  }
  &--ghost {
    background: transparent;
    color: var(--color-text);

    &:hover:not(:disabled) {
      background: var(--color-hover);
    }
  }
  &--danger {
    background: var(--color-danger-solid);
    color: var(--color-on-danger);

    &:hover:not(:disabled) {
      filter: brightness(0.93);
    }
  }

  &__spinner {
    width: 1em;
    height: 1em;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: var(--radius-full);
    animation: ui-button-spin var(--motion-base) linear infinite;
  }
}

@keyframes ui-button-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
