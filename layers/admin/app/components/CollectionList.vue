<script setup lang="ts">
import type { SerializedCollection } from '@kestrel/core'
import { resolveLocalized } from '../../../ui/app/utils/localized'
import { bulkCustomActions, recordCustomActions } from '../utils/collection-ops'

// `locale` is set only for a translatable collection: it filters the list to that content locale and
// shows a locale switcher. New records / row links carry it so they open in the same locale.
const props = defineProps<{ schema: SerializedCollection; locale?: string }>()

const { t, lang } = useT()
const { locales } = useContentLocales()

const collection = computed(() => props.schema.name)
const label = computed(() => resolveLocalized(props.schema.label?.singular, lang.value) ?? props.schema.name)
// Prefer the collection's complete per-locale "create" phrase; fall back to the generic template.
const newLabel = computed(() => resolveLocalized(props.schema.label?.new, lang.value) ?? t('common.new', { label: label.value }))
const localeQuery = computed(() => (props.locale ? `?locale=${props.locale}` : ''))

// Configurable columns (persisted per-collection). The select + row-action columns are CHROME — fixed
// cells rendered outside this model, never sortable/filterable/hideable/persisted.
const { available, visibleColumns, visibleKeys, toggle: toggleColumn, reset: resetColumns, isDefault: columnsAreDefault } =
  useListColumns(toRef(props, 'schema'))
const filterableColumns = computed(() => available.value.filter((c) => c.filterable))

// The URL is the single source of truth for committed list state. `sort`/`page`/`perPage`/`filter` are
// derived (read-only) computeds off `route.query`; `effectiveQuery` is the sanitized `$fetch` query; the
// setters navigate (page → push so Back walks pages, the rest → replace). The composable also owns the
// per-page cookie (a density DEFAULT that seeds perPage when the URL omits it).
const { sort, page, perPage, filter, effectiveQuery, setSort, setPage, clampPage, setPerPage, setFilter } =
  useListUrlState(available)

// `filter` (above, from the URL) = the committed clauses that drive the query; the panel's pending edits
// live in `draft` inside the composable, which also owns the debounce and the chip model.
const filterDraft = useListFilterDraft({ available, filterableColumns, filter, setFilter })
const activeFilters = filterDraft.activeFilters

const { rows, total, quarantinedCount, error, totalPages, fetchRows } = useListRows({
  collection,
  effectiveQuery,
  locale: () => props.locale,
  page,
  perPage,
  clampPage,
  // Selection is PAGE-SCOPED: any (re)fetch — page, filter, sort, per-page — replaces the visible rows, so
  // the previous selection no longer maps to what's on screen. (A locale switch remounts the whole
  // component, so that case clears too.)
  onLoaded: () => clearSelection(),
})

const { selected, allSelected, headerIndeterminate, toggleRow, toggleAll, clear: clearSelection } =
  useListSelection(rows)

// Row action = 1 id, bulk bar = N ids; the server does the batching.
const { busy: opsBusy, error: opsError, deleteOpen, deleteReport, askDelete, confirmDelete, duplicate: onDuplicate, setStatus, runAction } =
  useListBatchActions(collection, fetchRows)

// Schema-driven actions beyond the built-in delete/duplicate/publish: a consumer's `definePipeline` shows
// up here without any UI code.
const bulkActions = computed(() => bulkCustomActions(props.schema.actions ?? []))
const rowActions = computed(() => recordCustomActions(props.schema.actions ?? []))

// Toolbar popovers (filter / columns), including the outside-click and Escape-restores-focus behaviour.
const { container: toolsRef, open: openPanel, toggle: togglePanel } = useToolbarPanel<'filter' | 'columns'>()

// Polite status announced after every (re)fetch so filter/sort/page changes report their result count
// to screen readers — WCAG 4.1.3 Status Messages.
const resultsLabel = computed(() => t(total.value === 1 ? 'list.result' : 'list.results', { total: total.value }))
// Quarantined rows failed their select schema and would otherwise be silent data loss — a chip in
// the header surfaces the count whenever it's non-zero.
const quarantinedLabel = computed(() => t(quarantinedCount.value === 1 ? 'list.quarantinedOne' : 'list.quarantinedCount', { n: quarantinedCount.value }))
// The ONE permanent live region. A live region only announces MUTATIONS to a node already in the tree, so
// the selection count is folded in here (mutating this region's text) rather than toggling a second
// role="status" node into the DOM — inserting an already-populated live node is typically not announced,
// which would silence the first selection. Selection takes precedence; with none, it reports the count.
const srStatus = computed(() => (selected.size ? t('list.selected', { n: selected.size }) : resultsLabel.value))

// Exactly ONE refetch per navigation: the effective (sanitized) query is stringified so an identical or
// junk-only URL change never refetches, and a single change fires a single fetch. Every URL-driven refetch
// clears the page-scoped selection inside `fetchRows`.
watch(() => JSON.stringify(effectiveQuery.value), fetchRows)
// The only host (pages/admin/[collection]/index.vue) keys this component on collection + locale, so a
// collection- or locale-change fully remounts it (resetting committed filter/draft/page/selection from the
// clean target URL) while a sort/page/perPage/filter query change does NOT remount — the derived computeds
// recompute in place, keeping the filter panel open and focus intact. The initial load is the
// `await fetchRows()` below; subsequent loads flow through the effective-query watch above.
await fetchRows()
</script>

<template>
  <div class="list">
    <div class="list__bar">
      <div v-if="locale" class="list__locales" role="group" :aria-label="t('a11y.contentLocale')">
        <NuxtLink
          v-for="loc in locales"
          :key="loc"
          :to="`/admin/${collection}?locale=${loc}`"
          class="list__locale"
          :class="{ 'list__locale--active': loc === locale }"
          :aria-current="loc === locale ? 'true' : undefined"
        >{{ loc.toUpperCase() }}</NuxtLink>
      </div>

      <div ref="toolsRef" class="list__tools">
        <div class="list__tool">
          <KestrelUiButton
            type="button"
            size="sm"
            icon="filter"
            aria-controls="list-filter-panel"
            :aria-expanded="openPanel === 'filter'"
            class="list__tool-btn"
            @click="togglePanel('filter', $event)"
          >
            {{ t('list.filter') }}<span v-if="activeFilters.length" class="list__tool-count">{{ activeFilters.length }}</span>
          </KestrelUiButton>
          <KestrelCollectionListFilterPanel
            v-if="openPanel === 'filter'"
            :columns="filterableColumns"
            :filter="filterDraft"
            :has-active="activeFilters.length > 0"
          />
        </div>

        <div class="list__tool">
          <KestrelUiButton
            type="button"
            size="sm"
            icon="columns"
            aria-controls="list-columns-panel"
            :aria-expanded="openPanel === 'columns'"
            class="list__tool-btn"
            @click="togglePanel('columns', $event)"
          >{{ t('list.columns') }}</KestrelUiButton>
          <KestrelCollectionListColumnsPanel
            v-if="openPanel === 'columns'"
            :columns="available"
            :visible-keys="visibleKeys"
            :is-default="columnsAreDefault"
            @toggle="toggleColumn"
            @reset="resetColumns"
          />
        </div>
      </div>

      <span v-if="quarantinedCount > 0" class="list__quarantine-chip">
        <KestrelUiIcon name="triangle-alert" :size="14" />
        {{ quarantinedLabel }}
      </span>

      <NuxtLink :to="`/admin/${collection}/new${localeQuery}`" class="list__new">{{ newLabel }}</NuxtLink>
    </div>

    <KestrelCollectionListBulkBar
      v-if="selected.size"
      :count="selected.size"
      :has-status="!!schema.status"
      :busy="opsBusy"
      :actions="bulkActions"
      @set-status="(status) => setStatus([...selected], status)"
      @delete="askDelete([...selected])"
      @run-action="(action) => runAction(action, [...selected])"
      @clear="clearSelection"
    />

    <div v-if="activeFilters.length" class="list__chips">
      <span v-for="f in activeFilters" :key="f.key" class="list__chip">
        <span class="list__chip-label">{{ f.label }} {{ f.opLabel }}:</span> {{ f.display }}
        <button type="button" class="list__chip-x" :aria-label="t('list.removeFilter', { name: f.label })" @click="filterDraft.clearFilter(f.key)">
          <KestrelUiIcon name="x" :size="12" />
        </button>
      </span>
    </div>

    <KestrelUiAlert v-if="error" variant="error" class="list__error">
      {{ error }}
      <KestrelUiButton type="button" variant="secondary" size="sm" class="list__retry" @click="fetchRows">{{ t('common.retry') }}</KestrelUiButton>
    </KestrelUiAlert>

    <!-- The one scroll region: the table + its alternate empty-states scroll here while the bar, chips,
         error and pager stay fixed (see the admin layout's scroll-ownership convention). -->
    <div class="list__scroll">
      <KestrelCollectionListTable
        :rows="rows"
        :columns="visibleColumns"
        :collection="collection"
        :locale-query="localeQuery"
        :sort="sort"
        :busy="opsBusy"
        :selected="selected"
        :all-selected="allSelected"
        :header-indeterminate="headerIndeterminate"
        :actions="rowActions"
        @sort="setSort"
        @toggle-row="toggleRow"
        @toggle-all="toggleAll"
        @duplicate="onDuplicate"
        @delete="askDelete"
        @run-action="(action, id) => runAction(action, [id])"
      />

      <KestrelUiEmptyState
        v-if="!rows.length && !error && activeFilters.length"
        icon="filter"
        :title="t('list.noMatch.title')"
        :description="t('list.noMatch.desc', { name: label })"
      >
        <template #action>
          <button type="button" class="list__new" @click="filterDraft.clearAll">{{ t('list.filterClearAll') }}</button>
        </template>
      </KestrelUiEmptyState>
      <KestrelUiEmptyState
        v-else-if="!rows.length && !error"
        icon="file-text"
        :title="t('list.empty.title')"
        :description="t('list.empty.desc', { name: label })"
      >
        <template #action>
          <NuxtLink :to="`/admin/${collection}/new${localeQuery}`" class="list__new">{{ newLabel }}</NuxtLink>
        </template>
      </KestrelUiEmptyState>
    </div>

    <p class="list__sr-status" role="status" aria-live="polite">{{ srStatus }}</p>

    <KestrelCollectionListPager
      :page="page"
      :total-pages="totalPages"
      :total="total"
      :per-page="perPage"
      @update:page="setPage"
      @update:per-page="setPerPage"
    />

    <KestrelCollectionDeleteDialog
      :open="deleteOpen"
      :report="deleteReport"
      :busy="opsBusy"
      :error="opsError"
      @update:open="deleteOpen = $event"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style lang="scss">
.list__retry {
  margin-inline-start: var(--space-3);
}

// Visually-hidden polite status region (mirrors the ui sr-only mixin; admin can't @use a ui-layer scss).
.list__sr-status {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

// Fills the height handed down and stays fixed itself; scroll is delegated to .list__scroll. Overflow is
// left VISIBLE (not a scroll container) so the inline Filter/Columns popovers are never clipped.
.list {
  // Frozen-column token: the actions column's sticky `left` must equal the select column's width
  // (1.25rem checkbox + 2×var(--space-3) cell padding). Read by CollectionListTable's frozen columns —
  // keep in sync if the checkbox size or padding change.
  --list-col-select: 2.75rem;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  flex: 1 1 auto;
  min-height: 0;

  // Fixed chrome around the one scroll region.
  &__bar,
  &__bulkbar,
  &__chips,
  &__error,
  &__pager {
    flex: 0 0 auto;
  }

  // The only scroller: the table (+ its empty-states) scroll here; the bar/chips/error/pager stay put.
  &__scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  &__bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  &__locales {
    display: flex;
    gap: var(--space-1);
  }
  &__locale {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-muted);
    text-decoration: none;

    &--active {
      background: var(--color-surface);
      color: var(--color-text);
    }
  }

  // Filter / Columns toolbar. The panels themselves live in CollectionListFilterPanel /
  // CollectionListColumnsPanel; the shared popover chrome below styles both.
  &__tools {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  &__tool {
    position: relative;
  }
  &__tool-count {
    margin-left: var(--space-1);
    padding: 0 var(--space-1);
    border-radius: var(--radius-sm);
    background: var(--color-primary-soft);
    color: var(--color-primary);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
  }
  &__panel {
    position: absolute;
    z-index: 20;
    top: calc(100% + var(--space-1));
    left: 0;
    min-width: 16rem;
    max-height: 60vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-md, 0 6px 24px rgb(0 0 0 / 12%));
  }
  &__panel-empty {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }
  &__panel-action {
    align-self: flex-start;
    margin-top: var(--space-1);
    padding: 0;
    border: 0;
    background: none;
    color: var(--color-primary);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  // Quarantine count chip — icon + text (not color alone, WCAG 1.4.1) so it reads even without color.
  &__quarantine-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--color-danger-soft, var(--color-surface));
    color: var(--color-danger);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  &__new {
    margin-left: auto;
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--color-primary);
    color: var(--color-on-primary);
    text-decoration: none;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);

    &:hover {
      background: var(--color-primary-hover);
    }
  }

  // Active-filter chips
  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  &__chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    font-size: var(--text-sm);
  }
  &__chip-label {
    color: var(--color-text-muted);
  }
  &__chip-x {
    display: inline-flex;
    padding: 0;
    border: 0;
    background: none;
    color: var(--color-text-muted);
    cursor: pointer;

    &:hover {
      color: var(--color-text);
    }
  }
}
</style>
