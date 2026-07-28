<script setup lang="ts">
import type { IconName } from '../../utils/icons'

defineProps<{ icon?: IconName; title: string; description?: string }>()
</script>

<template>
  <div class="ui-empty">
    <UiIcon v-if="icon" :name="icon" size="1.5rem" class="ui-empty__icon" />
    <p class="ui-empty__title">{{ title }}</p>
    <p v-if="description" class="ui-empty__desc">{{ description }}</p>
    <div v-if="$slots.action" class="ui-empty__action"><slot name="action" /></div>
  </div>
</template>

<style lang="scss">
.ui-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  text-align: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);

  &__icon {
    margin-bottom: var(--space-1);
    color: var(--color-text-subtle);
  }
  &__title {
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }
  &__desc {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    max-width: 40ch;
  }
  &__action {
    margin-top: var(--space-2);
  }
}
</style>
