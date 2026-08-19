<script setup lang="ts">
import type { FilterOp } from '../../../core/app/utils/filter-ops'
import type { ListFilterDraft } from '../composables/useListFilterDraft'
import { columnLabel } from '../utils/list-cell'
import type { ListColumn } from '../utils/list-columns'

// The whole draft controller arrives as ONE prop: its ten members are a single cohesive thing, and the
// panel must share the parent's draft state (the chip row renders off the same clauses).
const props = defineProps<{ columns: ListColumn[]; filter: ListFilterDraft; hasActive: boolean }>()

const { t } = useT()
const colLabel = (col: ListColumn) => columnLabel(col, t)
const draft = computed(() => props.filter.draft)
</script>

<template>
  <div id="list-filter-panel" class="list__panel list__panel--filter">
    <p v-if="!columns.length" class="list__panel-empty">{{ t('list.noFilters') }}</p>
    <div v-for="c in columns" :key="c.key" class="list__filter-row">
      <span class="list__filter-label">{{ colLabel(c) }}</span>
      <div class="list__filter-controls">
        <select
          v-if="filter.opsFor(c).length > 1"
          class="list__filter-op"
          :data-filter-op="c.key"
          :aria-label="`${t('filter.operator')} — ${colLabel(c)}`"
          :value="draft[c.key]?.op"
          @change="filter.setOp(c.key, ($event.target as HTMLSelectElement).value as FilterOp)"
        >
          <option v-for="op in filter.opsFor(c)" :key="op" :value="op">{{ filter.opLabel(c.filterKind ?? 'text', op) }}</option>
        </select>

        <input
          v-if="c.filterKind === 'datetime'"
          type="date"
          class="list__filter"
          :data-filter="c.key"
          :aria-label="colLabel(c)"
          :value="draft[c.key]?.value ?? ''"
          @input="filter.setValue(c.key, ($event.target as HTMLInputElement).value)"
        >
        <input
          v-else-if="c.filterKind === 'number' || c.filterKind === 'ref' || c.filterKind === 'idSet'"
          type="number"
          class="list__filter"
          :data-filter="c.key"
          :aria-label="colLabel(c)"
          :value="draft[c.key]?.value ?? ''"
          @input="filter.setValue(c.key, ($event.target as HTMLInputElement).value)"
        >
        <select
          v-else-if="c.filterKind === 'boolean'"
          class="list__filter"
          :data-filter="c.key"
          :aria-label="colLabel(c)"
          :value="draft[c.key]?.value ?? ''"
          @change="filter.setValue(c.key, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">—</option>
          <option value="true">{{ t('filter.bool.true') }}</option>
          <option value="false">{{ t('filter.bool.false') }}</option>
        </select>
        <!-- Single choice (`enum`) and multi choice (`stringSet`) both pick a stored VALUE from the
             field's choices; a free-text box would let the user type the visible LABEL and match nothing. -->
        <select
          v-else-if="c.filterKind === 'enum' || c.filterKind === 'stringSet'"
          class="list__filter"
          :data-filter="c.key"
          :aria-label="colLabel(c)"
          :value="draft[c.key]?.value ?? ''"
          @change="filter.setValue(c.key, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">—</option>
          <option v-for="o in filter.enumOptions(c)" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <input
          v-else
          type="text"
          class="list__filter"
          :data-filter="c.key"
          :aria-label="colLabel(c)"
          :value="draft[c.key]?.value ?? ''"
          :placeholder="t('list.filterPlaceholder', { name: colLabel(c) })"
          @input="filter.setValue(c.key, ($event.target as HTMLInputElement).value)"
        >
      </div>
    </div>
    <button v-if="hasActive" type="button" class="list__panel-action" @click="filter.clearAll">{{ t('list.filterClearAll') }}</button>
  </div>
</template>

<style lang="scss">
.list {
  // The inline filter rows need room for name + operator + value; the columns panel stays compact.
  &__panel--filter {
    min-width: 30rem;
  }
  // Name, operator and value on ONE line: a stacked label doubled the panel's height for no information.
  &__filter-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }
  // Fixed basis so the names form an aligned column and the controls all start at the same x.
  &__filter-label {
    flex: 0 0 6.5rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-muted);
  }
  // Operator select + value control; the value control takes the remaining width.
  &__filter-controls {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    gap: var(--space-1);
    align-items: center;
  }
  &__filter-op {
    flex: 0 0 auto;
    max-width: 45%;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text-muted);
    font: inherit;
    font-size: var(--text-sm);
  }
  &__filter {
    width: 100%;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font: inherit;
  }
  &__filter-controls .list__filter {
    flex: 1 1 auto;
    min-width: 0;
  }
}
</style>
