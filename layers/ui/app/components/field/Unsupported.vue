<script setup lang="ts">
import type { FieldComponentProps } from '../../utils/field-component'

defineProps<FieldComponentProps>()
defineModel<unknown>()
</script>

<template>
  <div class="field-unsupported">
    <span class="field-unsupported__label">{{ name }}</span>
    <p class="field-unsupported__note">Field type "{{ field.type }}" is not yet available.</p>
  </div>
</template>

<style lang="scss">
.field-unsupported {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);

  &__label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
  &__note {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
  }
}
</style>
