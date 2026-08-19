<script setup lang="ts">
import { sortDirection } from '../utils/list-query'
import { cellDisplay, columnLabel, rowLabel as labelForRow } from '../utils/list-cell'
import type { ListColumn } from '../utils/list-columns'

const props = defineProps<{
  rows: Record<string, unknown>[]
  columns: ListColumn[]
  collection: string
  localeQuery: string
  sort: string
  busy: boolean
  selected: Set<number>
  allSelected: boolean
  headerIndeterminate: boolean
}>()
const emit = defineEmits<{
  sort: [key: string]
  toggleRow: [id: number, on: boolean]
  toggleAll: [on: boolean]
  duplicate: [id: number]
  delete: [ids: number[]]
}>()

const { t } = useT()
const { locales } = useContentLocales()

const colLabel = (col: ListColumn) => columnLabel(col, t)
const rowLabel = (row: Record<string, unknown>) => labelForRow(props.columns, row)

function arrow(field: string) {
  const dir = sortDirection(props.sort, field)
  return dir === 'asc' ? ' ▲' : dir === 'desc' ? ' ▼' : ''
}
// Programmatic sort state for AT (the visual arrow is aria-hidden) — WCAG 1.3.1 / 4.1.2.
function ariaSort(field: string): 'ascending' | 'descending' | 'none' {
  const dir = sortDirection(props.sort, field)
  return dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'
}

// Per-row translation status (the list query attaches `$translations`: locale → sibling id, or null).
// Present locales link to their sibling; missing ones offer create-and-link, carrying the translation group.
function rowTranslations(row: Record<string, unknown>) {
  const map = (row.$translations ?? {}) as Record<string, number | null>
  const group = row.translationGroup as string | undefined
  return locales.map((loc) => {
    const id = map[loc]
    return id != null
      ? { loc, present: true, to: `/admin/${props.collection}/${id}?locale=${loc}` }
      : { loc, present: false, to: `/admin/${props.collection}/new?locale=${loc}${group ? `&group=${group}` : ''}` }
  })
}
</script>

<template>
  <table class="list__table">
    <thead>
      <tr>
        <th class="list__select-th" scope="col">
          <KestrelUiCheckbox
            :model-value="allSelected"
            :indeterminate="headerIndeterminate"
            :aria-label="t('list.selectAll')"
            @update:model-value="(v) => emit('toggleAll', v)"
          />
        </th>
        <!-- Row actions: an always-visible, left-frozen chrome column placed right after Select. Its
             accessible name is real visually-hidden text, not aria-label on a static <th> (which several
             screen-reader / browser pairs ignore on non-interactive table cells). -->
        <th class="list__actions-th" scope="col">
          <span class="list__vh">{{ t('a11y.rowActions') }}</span>
        </th>
        <th
          v-for="c in columns"
          :key="c.key"
          scope="col"
          :aria-sort="c.sortable ? ariaSort(c.key) : undefined"
          :class="{ 'list__th-narrow': c.type === 'translations' || c.type === 'deadRefs' }"
        >
          <button v-if="c.sortable" type="button" class="list__sort" @click="emit('sort', c.key)">{{ colLabel(c) }}<span aria-hidden="true">{{ arrow(c.key) }}</span></button>
          <span v-else>{{ colLabel(c) }}</span>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="String(row.id)" class="list__row">
        <td class="list__select-cell">
          <KestrelUiCheckbox
            :model-value="selected.has(Number(row.id))"
            :aria-label="t('list.selectRow', { name: rowLabel(row) })"
            @update:model-value="(v) => emit('toggleRow', Number(row.id), v)"
          />
        </td>
        <td class="list__actions-cell">
          <div class="list__row-actions">
            <NuxtLink :to="`/admin/${collection}/${row.id}${localeQuery}`" class="list__action-btn" :aria-label="t('list.rowEdit', { name: rowLabel(row) })">
              <KestrelUiIcon name="pencil" :size="15" />
            </NuxtLink>
            <button type="button" class="list__action-btn" :disabled="busy" :aria-label="t('list.rowDuplicate', { name: rowLabel(row) })" @click="emit('duplicate', Number(row.id))">
              <KestrelUiIcon name="copy" :size="15" />
            </button>
            <button type="button" class="list__action-btn list__action-btn--danger" :disabled="busy" :aria-label="t('list.rowDelete', { name: rowLabel(row) })" @click="emit('delete', [Number(row.id)])">
              <KestrelUiIcon name="trash" :size="15" />
            </button>
          </div>
        </td>
        <td v-for="c in columns" :key="c.key" :class="{ 'list__narrow-cell': c.type === 'translations' || c.type === 'deadRefs' }">
          <span v-if="c.type === 'deadRefs'" class="list__deadrefs">
            <KestrelUiIcon
              v-if="row.$hasDeadRefs"
              name="triangle-alert"
              :size="15"
              class="list__deadref-icon"
              role="img"
              :aria-label="t('deadRefs.listWarning')"
              :title="t('deadRefs.listWarning')"
            />
          </span>
          <span v-else-if="c.type === 'translations'" class="list__transl">
            <NuxtLink
              v-for="tr in rowTranslations(row)"
              :key="tr.loc"
              :to="tr.to"
              :data-loc="tr.loc"
              class="list__badge"
              :class="tr.present ? 'list__badge--present' : 'list__badge--missing'"
              :title="tr.present ? t('list.editLocale', { loc: tr.loc.toUpperCase() }) : t('list.createLocale', { loc: tr.loc.toUpperCase() })"
              :aria-label="tr.present ? t('list.editLocale', { loc: tr.loc.toUpperCase() }) : t('list.createLocale', { loc: tr.loc.toUpperCase() })"
            >{{ tr.loc.toUpperCase() }}</NuxtLink>
          </span>
          <template v-else>{{ cellDisplay(c, row) }}</template>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style lang="scss">
// Visually-hidden text for a static cell that must be announced but not shown (the Actions column header).
// Chosen over aria-label, which is unreliably announced on non-interactive table cells.
.list__vh {
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

.list {
  &__table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);

    th,
    td {
      text-align: start;
      padding: var(--space-2) var(--space-3);
      border-bottom: 1px solid var(--color-border);
      vertical-align: top;
    }
    // Keep the column headers visible while the rows scroll inside .list__scroll. A solid background is
    // required so scrolling rows don't show through. Part of the frozen-column z-index stack (see the
    // &__select-* / &__actions-* rules): scrolling body td 0 < frozen body td 1 < scrolling header th 2 <
    // frozen corner th 3, so nothing bleeds through on either scroll axis.
    thead th {
      position: sticky;
      top: 0;
      z-index: 2; // scrolling header: above scrolling body cells (0) and the frozen body columns (1)
      background: var(--color-bg);
    }
    // Frozen corner: the select + actions headers are sticky on BOTH axes, so they must sit above every
    // scrolling header AND every frozen body column where the two frozen edges cross.
    thead th.list__select-th,
    thead th.list__actions-th {
      z-index: 3;
    }
  }
  &__sort {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-weight: var(--weight-medium);
    cursor: pointer;
    color: var(--color-text);
  }
  // Compact, de-emphasised info columns (translations · dead-reference warning).
  &__th-narrow,
  &__narrow-cell {
    width: 1%;
    white-space: nowrap;
  }

  // Dead-reference warning: an amber triangle, shown only on rows holding a stale reference.
  &__deadrefs {
    display: inline-flex;
  }
  &__deadref-icon {
    color: var(--color-warning);
  }
  &__transl {
    display: inline-flex;
    gap: 2px;
    flex-wrap: wrap;
  }
  &__badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.4rem;
    padding: 0 3px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-size: 0.625rem;
    font-weight: var(--weight-medium);
    line-height: 1.5;
    letter-spacing: 0.02em;
    text-decoration: none;

    &--present {
      background: var(--color-primary-soft);
      color: var(--color-primary);
    }
    &--missing {
      color: var(--color-text-muted);
      border-color: var(--color-border);
      border-style: dashed;
    }
    &:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: -2px;
    }
  }

  // Selection column — the first frozen chrome column, pinned to the left with `position: sticky` inside
  // the existing .list__scroll (no new scroll container). Opaque `var(--color-bg)` so horizontally-scrolled
  // data can't bleed through; z-index 1 lifts the frozen body cell above the scrolling body cells.
  &__select-th,
  &__select-cell {
    position: sticky;
    left: 0;
    z-index: 1;
    width: var(--list-col-select);
    white-space: nowrap;
    vertical-align: middle;
    background: var(--color-bg);
  }
  // Row-actions column — the second frozen column, sitting immediately after Select (its `left` offset is
  // exactly the select column's width). Always visible; snug `width: 1%` so the three icon buttons never
  // steal width from the Title column.
  &__actions-th,
  &__actions-cell {
    position: sticky;
    left: var(--list-col-select);
    z-index: 1;
    width: 1%;
    white-space: nowrap;
    vertical-align: middle;
    background: var(--color-bg);
  }
  // A plain, always-visible inline row of icon buttons (Edit → Duplicate → Delete; destructive last, never
  // default focus). BlockTree.vue deliberately keeps its own absolute overlay: a tree row is a single flex
  // row with no column grid — there is no cell to place actions in.
  &__row-actions {
    display: inline-flex;
    align-items: center;
    gap: 1px;
  }
  &__action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-muted); /* meaningful icon control at rest → ≥3:1 (SC 1.4.11) */
    text-decoration: none;
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--ease-standard),
      color var(--motion-fast) var(--ease-standard);

    &:hover {
      background: var(--color-hover);
      color: var(--color-text);
    }
    &:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: -2px;
    }
    &--danger:hover {
      color: var(--color-danger);
    }
    &:disabled {
      opacity: 0.5;
      cursor: default;
      pointer-events: none;
    }
  }
}
</style>
