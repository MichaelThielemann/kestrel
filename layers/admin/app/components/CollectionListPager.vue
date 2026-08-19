<script setup lang="ts">
import { PER_PAGE_OPTIONS } from '../../../core/app/utils/list-limits'

const props = defineProps<{ page: number; totalPages: number; total: number; perPage: number }>()
const emit = defineEmits<{ 'update:page': [page: number]; 'update:perPage': [perPage: number] }>()

const { t } = useT()
// The per-page `<select>` is hand-rolled here (no UiField wrapper), so the label↔control association needs
// an explicit id pair for static a11y analysis to see it.
const perPageId = useId()

function prev() {
  if (props.page > 1) emit('update:page', props.page - 1)
}
function next() {
  if (props.page < props.totalPages) emit('update:page', props.page + 1)
}
</script>

<template>
  <div class="list__pager">
    <KestrelUiButton type="button" size="sm" :disabled="page <= 1" @click="prev">{{ t('list.prev') }}</KestrelUiButton>
    <span class="list__page">{{ t('list.page', { page, totalPages, total }) }}</span>
    <KestrelUiButton type="button" size="sm" :disabled="page >= totalPages" @click="next">{{ t('list.next') }}</KestrelUiButton>
    <label class="list__perpage" :for="perPageId">
      <span class="list__perpage-label">{{ t('list.perPage') }}</span>
      <select
        :id="perPageId"
        class="list__perpage-select"
        :value="perPage"
        :aria-label="t('list.perPage')"
        @change="emit('update:perPage', Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="n in PER_PAGE_OPTIONS" :key="n" :value="n">{{ n }}</option>
      </select>
    </label>
  </div>
</template>

<style lang="scss">
.list {
  &__pager {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  &__page {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }
  // Per-page size selector sits at the far end of the pager.
  &__perpage {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin-inline-start: auto;
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }
  &__perpage-select {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-sm);
  }
}
</style>
