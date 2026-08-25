<script setup lang="ts">
// Chrome (flex: 0 0 auto) that appears when ≥1 row is selected, shrinking the one scroll region rather
// than overlaying it. Publish/Unpublish are schema-driven (only when the collection has a status).
// NOT a live region: the selection count is announced through the list's permanent .list__sr-status
// region; a v-if-toggled role="status" here would double up and stay silent on first show.
import { resolveLocalized } from '../../../ui/app/utils/localized'
import type { SerializedAction } from '@kestrel/core'

const props = defineProps<{ count: number; hasStatus: boolean; busy: boolean; actions?: SerializedAction[] }>()
const emit = defineEmits<{ setStatus: [status: 'published' | 'draft']; delete: []; runAction: [action: SerializedAction]; clear: [] }>()

const { t, lang } = useT()
const actionLabel = (action: SerializedAction) => resolveLocalized(action.label, lang.value) ?? action.name
</script>

<template>
  <div class="list__bulkbar">
    <span class="list__bulk-count">{{ t('list.selected', { n: count }) }}</span>
    <div class="list__bulk-actions">
      <template v-if="hasStatus">
        <KestrelUiButton type="button" size="sm" variant="secondary" :disabled="busy" @click="emit('setStatus', 'published')">{{ t('list.bulkPublish') }}</KestrelUiButton>
        <KestrelUiButton type="button" size="sm" variant="secondary" :disabled="busy" @click="emit('setStatus', 'draft')">{{ t('list.bulkUnpublish') }}</KestrelUiButton>
      </template>
      <KestrelUiButton
        v-for="action in props.actions"
        :key="action.name"
        type="button"
        size="sm"
        variant="secondary"
        :disabled="busy"
        :data-action="action.name"
        @click="emit('runAction', action)"
      >{{ actionLabel(action) }}</KestrelUiButton>
      <KestrelUiButton type="button" size="sm" variant="danger" :disabled="busy" @click="emit('delete')">{{ t('list.bulkDelete') }}</KestrelUiButton>
      <KestrelUiButton type="button" size="sm" variant="ghost" @click="emit('clear')">{{ t('list.clearSelection') }}</KestrelUiButton>
    </div>
  </div>
</template>

<style lang="scss">
.list {
  &__bulkbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  &__bulk-count {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
  &__bulk-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-inline-start: auto;
  }
}
</style>
