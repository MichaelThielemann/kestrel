<script setup lang="ts">
import type { SerializedCollection } from '../../../core/server/utils/serialize-collection'
import { sortDirection, type FilterCell } from '../utils/list-query'
import { type ListColumn } from '../utils/list-columns'
import { PER_PAGE_OPTIONS } from '../../../core/app/utils/list-limits'
import type { BatchDeleteReport } from '../utils/collection-ops'
import { OPS_BY_KIND, DEFAULT_OP, type FilterKind, type FilterOp } from '../../../core/app/utils/filter-ops'
import { resolveLocalized } from '../../../ui/app/utils/localized'
import { humanizeFieldName } from '../../../ui/app/utils/humanize'

// `locale` is set only for a translatable collection: it filters the list to that content locale and
// shows a locale switcher. New records / row links carry it so they open in the same locale.
const props = defineProps<{ schema: SerializedCollection; locale?: string }>()

const { t, lang } = useT()
const { locales } = useContentLocales()

const collection = computed(() => props.schema.name)
const label = computed(() => resolveLocalized(props.schema.label?.singular, lang.value) ?? props.schema.name)
// Prefer the collection's complete per-locale "create" phrase; fall back to the generic template.
const newLabel = computed(() => resolveLocalized(props.schema.label?.new, lang.value) ?? t('common.new', { label: label.value }))
const translatable = computed(() => !!props.schema.translatable && props.schema.mode === 'multi')
const localeQuery = computed(() => (props.locale ? `?locale=${props.locale}` : ''))

// Configurable columns (persisted per-collection). The select + row-action columns are CHROME — fixed
// cells rendered outside this model, never sortable/filterable/hideable/persisted.
const { available, visibleColumns, visibleKeys, toggle: toggleColumn, reset: resetColumns, isDefault: columnsAreDefault } =
  useListColumns(toRef(props, 'schema'))
const filterableColumns = computed(() => available.value.filter((c) => c.filterable))

function colLabel(col: ListColumn): string {
  return col.type === 'field' ? humanizeFieldName(col.name ?? col.key) : t(col.labelKey ?? col.key)
}

// The URL is the single source of truth for committed list state. `sort`/`page`/`perPage`/`filter` are
// derived (read-only) computeds off `route.query`; `effectiveQuery` is the sanitized `$fetch` query; the
// setters navigate (page → push so Back walks pages, the rest → replace). The composable also owns the
// per-page cookie (a density DEFAULT that seeds perPage when the URL omits it).
const { sort, page, perPage, filter, effectiveQuery, setSort, setPage, clampPage, setPerPage, setFilter } =
  useListUrlState(available)

// `filter` (above, from the URL) = the committed clauses that drive the query. `draft` = the panel's pending
// edits, kept local and seeded per filterable column below (keyed by column key → { op, value }).
const draft = reactive<Record<string, FilterCell>>({})

// Overwrite each draft cell FROM the committed `filter` so deep-link / Back-Forward / chip-removal reflect
// back into the open panel; drop drafts for columns this collection no longer has. We key the watch on the
// committed filter's CONTENT (its JSON), not its object identity: `filter` recomputes to a fresh-but-EQUAL
// object on every `route.query` change (page/sort/perPage navigations too), and resyncing on those identity
// flips would wipe an in-progress panel edit. Clobber-safe on a real filter commit: a commit sends ALL
// drafts at once, so post-commit `filter` equals `draft` (a no-op overwrite) — the content only actually
// changes on external navigation (deep-link/Back-Forward/chip-removal), which is when the panel should resync.
watch([filterableColumns, () => JSON.stringify(filter.value)], () => {
  const cols = filterableColumns.value
  for (const c of cols) {
    const cm = filter.value[c.key]
    draft[c.key] = { op: cm?.op ?? DEFAULT_OP[c.filterKind ?? 'text'], value: cm?.value ?? '' }
  }
  for (const key of Object.keys(draft)) if (!cols.some((c) => c.key === key)) delete draft[key]
}, { immediate: true })

function opsFor(c: ListColumn): readonly FilterOp[] {
  return OPS_BY_KIND[c.filterKind ?? 'text']
}
// Operator labels are kind-aware: a datetime comparison reads "before / on or before / …" instead of the
// generic "less than / less or equal / …".
function opLabel(kind: FilterKind, op: FilterOp): string {
  if (kind === 'datetime' && (op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte')) return t(`filter.opDate.${op}`)
  return t(`filter.op.${op}`)
}
// Choices for an `enum` / `stringSet` value control: a fixed draft/published set for `status`, else the
// choice field's own (single- and multi-choice fields both carry `options.choices`).
function enumOptions(c: ListColumn): { label: string; value: string }[] {
  if (c.key === 'status') return [
    { value: 'draft', label: t('pageSettings.statusDraft') },
    { value: 'published', label: t('pageSettings.statusPublished') },
  ]
  return ((c.field?.options?.choices ?? []) as { label: string; value: string }[])
}
function displayValue(kind: FilterKind, value: string): string {
  if (kind === 'boolean') return value === 'true' ? t('filter.bool.true') : value === 'false' ? t('filter.bool.false') : value
  return value
}

const rows = ref<Record<string, unknown>[]>([])
const total = ref(0)
// Surfaced when a (re)fetch fails — an inline error + Retry, never a silent stale list or a thrown
// error boundary. Distinct from the empty state (which only shows when the fetch SUCCEEDED with no rows).
const error = ref<string | null>(null)

const toast = useToast()

// ── Page-scoped row selection ──────────────────────────────────────────────────────────────────────
// A Set of selected row ids, valid only for the rows currently on screen (cleared on every fetch). The
// header checkbox is select-all-on-this-page with a tri-state (some-but-not-all) indeterminate marker.
// A reactive Set (Vue tracks add/delete/has/size), so a single-row toggle is O(1) — no full-Set copy or
// whole-table re-diff on each click, which mattered at the 500-row page cap.
const selected = reactive(new Set<number>())
const pageIds = computed(() => rows.value.map((r) => Number(r.id)))
const allSelected = computed(() => pageIds.value.length > 0 && pageIds.value.every((id) => selected.has(id)))
const headerIndeterminate = computed(() => pageIds.value.some((id) => selected.has(id)) && !allSelected.value)
function toggleRow(id: number, on: boolean) {
  if (on) selected.add(id)
  else selected.delete(id)
}
function toggleAll(on: boolean) {
  selected.clear()
  if (on) for (const id of pageIds.value) selected.add(id)
}
function clearSelection() {
  selected.clear()
}
// A row's human label: the first visible non-sidecar cell that has a value, else the bare id — used for
// the per-row checkbox / action aria-labels so each control names its row.
function rowLabel(row: Record<string, unknown>): string {
  for (const c of visibleColumns.value) {
    if (c.type === 'translations' || c.type === 'deadRefs') continue
    const d = cellDisplay(c, row)
    if (d) return d
  }
  return `#${row.id}`
}

// ── Batch operations (row action = 1 id, bulk bar = N ids; the server does the batching) ─────────────
const { busy: opsBusy, error: opsError, previewDelete, confirmDelete: runDelete, duplicate: runDuplicate, setStatus: runSetStatus } =
  useCollectionOps(collection, () => fetchRows())

const deleteOpen = ref(false)
const deleteReport = ref<BatchDeleteReport | null>(null)
const deleteIds = ref<number[]>([])

// Destructive → confirm dialog. The referrer preview is best-effort: if it fails we still open the dialog
// with a bare summary (never block a delete on the warning lookup).
async function askDelete(ids: number[]) {
  if (!ids.length) return
  deleteIds.value = ids
  deleteReport.value = null
  deleteOpen.value = true
  try {
    deleteReport.value = await previewDelete(ids)
  } catch {
    // The referrer lookup FAILED — do not fabricate a "no inbound links" report (that would look exactly
    // like a verified-safe delete). Flag `checked: false` so the dialog cautions the check couldn't run.
    deleteReport.value = { count: ids.length, referencedCount: 0, referenced: [], checked: false }
    opsError.value = null
  }
}
async function confirmDelete() {
  try {
    await runDelete(deleteIds.value)
    toast.success(t('toast.deleted'))
    deleteOpen.value = false
  } catch {
    // error stays surfaced in the dialog via opsError
  }
}
// Non-destructive / reversible → no dialog: run, toast, refetch (the composable's onChanged).
async function onDuplicate(id: number) {
  try {
    await runDuplicate([id])
    toast.success(t('toast.duplicated'))
  } catch {
    toast.error(opsError.value ?? t('list.opFailed'))
  }
}
async function onBulkStatus(status: 'published' | 'draft') {
  try {
    await runSetStatus([...selected], status)
    toast.success(status === 'published' ? t('toast.published') : t('toast.unpublished'))
  } catch {
    toast.error(opsError.value ?? t('list.opFailed'))
  }
}

// Monotonic request id: a slow earlier response must not overwrite a newer one.
let seq = 0
async function fetchRows() {
  const mine = ++seq
  try {
    const res = await $fetch<{ data: Record<string, unknown>[]; total: number; page: number; perPage: number }>(
      `/api/${collection.value}`,
      { query: { ...effectiveQuery.value, ...(props.locale ? { locale: props.locale } : {}) } },
    )
    if (mine !== seq) return
    rows.value = res.data
    total.value = res.total
    error.value = null
    // A page that emptied out from under us — e.g. bulk-deleting the last rows of the trailing page —
    // would otherwise strand the user on an out-of-range page showing the "create your first" empty
    // state. Clamp back to the last page that still has rows (REPLACE, so the dead page isn't left as a
    // history entry that Back would bounce off; the query watch refetches).
    if (res.data.length === 0 && res.total > 0 && page.value > 1) {
      clampPage(Math.max(1, Math.ceil(res.total / perPage.value)))
    }
    // Selection is PAGE-SCOPED: any (re)fetch — page, filter, sort, per-page — replaces the visible rows,
    // so the previous selection no longer maps to what's on screen. Clear it. (A locale switch remounts
    // the whole component, so that case clears too.)
    selected.clear()
  } catch (e) {
    if (mine !== seq) return
    // Keep any previously-rendered rows, but surface that this fetch failed (and don't show the
    // "create your first" empty state — that would imply the collection is empty when it isn't).
    error.value = (e as { statusMessage?: string })?.statusMessage ?? t('list.loadError')
  }
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / perPage.value)))

// Filters: edited in the Filter panel (a value change debounces; an operator change commits at once), shown
// as removable chips in the bar. `commitDrafts` builds a fresh clause map from the non-empty draft cells and
// navigates via `setFilter` (which also resets page → 1).
let filterTimer: ReturnType<typeof setTimeout> | undefined
function commitDrafts() {
  const next: Record<string, FilterCell> = {}
  for (const [field, cell] of Object.entries(draft)) {
    if (cell.value !== '' && cell.value != null) next[field] = { op: cell.op, value: cell.value }
  }
  setFilter(next)
}
function setValue(field: string, value: string) {
  if (draft[field]) draft[field].value = value
  clearTimeout(filterTimer)
  filterTimer = setTimeout(commitDrafts, 250)
}
function setOp(field: string, op: FilterOp) {
  if (draft[field]) draft[field].op = op
  // An operator change is deliberate — re-query immediately (no debounce) if the field has a value.
  clearTimeout(filterTimer)
  commitDrafts()
}
function clearFilter(field: string) {
  if (draft[field]) draft[field].value = ''
  commitDrafts() // re-commits the drafts with this one now empty → the clause is dropped (and page → 1)
}
function clearAllFilters() {
  for (const cell of Object.values(draft)) cell.value = ''
  setFilter({}) // clear the committed clauses (and page → 1); the draft-resync watch clears the panel
}
const activeFilters = computed(() => Object.entries(filter.value).map(([key, cell]) => {
  const col = available.value.find((c) => c.key === key)
  const kind = col?.filterKind ?? 'text'
  return { key, op: cell.op, opLabel: opLabel(kind, cell.op), label: col ? colLabel(col) : key, display: displayValue(kind, cell.value) }
}))
onBeforeUnmount(() => clearTimeout(filterTimer))

function prev() {
  if (page.value > 1) setPage(page.value - 1)
}
function next() {
  if (page.value < totalPages.value) setPage(page.value + 1)
}
function arrow(field: string) {
  const dir = sortDirection(sort.value, field)
  return dir === 'asc' ? ' ▲' : dir === 'desc' ? ' ▼' : ''
}
// Programmatic sort state for AT (the visual arrow is aria-hidden) — WCAG 1.3.1 / 4.1.2.
function ariaSort(field: string): 'ascending' | 'descending' | 'none' {
  const dir = sortDirection(sort.value, field)
  return dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'
}
// Polite status announced after every (re)fetch so filter/sort/page changes report their result count
// to screen readers — WCAG 4.1.3 Status Messages.
const resultsLabel = computed(() => t(total.value === 1 ? 'list.result' : 'list.results', { total: total.value }))
// The ONE permanent live region. A live region only announces MUTATIONS to a node already in the tree, so
// the selection count is folded in here (mutating this region's text) rather than toggling a second
// role="status" node into the DOM — inserting an already-populated live node is typically not announced,
// which would silence the first selection. Selection takes precedence; with none, it reports the count.
const srStatus = computed(() => (selected.size ? t('list.selected', { n: selected.size }) : resultsLabel.value))

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' })
// A date-only value ('YYYY-MM-DD', from a datetime field with precision 'date') parses as UTC midnight;
// formatting it in the local zone would shift the calendar day, so pin it to UTC. Full ISO timestamps
// (createdAt/updatedAt carry a 'Z') and local datetimes keep the local-zone formatter.
const dateOnlyFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' })
function isDateColumn(col: ListColumn): boolean {
  return col.key === 'createdAt' || col.key === 'updatedAt' || col.field?.type === 'datetime'
}
function cellDisplay(col: ListColumn, row: Record<string, unknown>): string {
  const value = row[col.key]
  if (isDateColumn(col) && value != null) {
    const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    const d = new Date(value as string)
    if (!Number.isNaN(d.getTime())) return (dateOnly ? dateOnlyFmt : dateFmt).format(d)
  }
  return cellText(value)
}
function cellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.replace(/<[^>]*>/g, '').slice(0, 80)
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 80)
  return String(value)
}

// Per-row translation status (A4 attaches `$translations`: locale → sibling id, or null). Present
// locales link to their sibling; missing ones offer create-and-link, carrying the translation group.
function rowTranslations(row: Record<string, unknown>) {
  const map = (row.$translations ?? {}) as Record<string, number | null>
  const group = row.translationGroup as string | undefined
  return locales.map((loc) => {
    const id = map[loc]
    return id != null
      ? { loc, present: true, to: `/admin/${collection.value}/${id}?locale=${loc}` }
      : { loc, present: false, to: `/admin/${collection.value}/new?locale=${loc}${group ? `&group=${group}` : ''}` }
  })
}

// Toolbar popovers (filter / columns). Plain inline panels (not teleported) so they stay testable and
// keep their scoped styles; a document listener closes them on an outside click.
const toolsRef = ref<HTMLElement | null>(null)
const openPanel = ref<'filter' | 'columns' | null>(null)
// The element that opened the current panel — Escape restores focus to it (otherwise closing the panel
// from inside drops keyboard focus onto <body>, stranding the keyboard user at the top of the document).
let panelTrigger: HTMLElement | null = null
function togglePanel(which: 'filter' | 'columns', e: MouseEvent) {
  if (openPanel.value === which) { openPanel.value = null; return }
  panelTrigger = e.currentTarget as HTMLElement
  openPanel.value = which
}
function onDocPointer(e: PointerEvent) {
  // Outside click: close but do NOT steal focus — it belongs wherever the user just clicked.
  if (toolsRef.value && !toolsRef.value.contains(e.target as Node)) openPanel.value = null
}
function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && openPanel.value) {
    openPanel.value = null
    panelTrigger?.focus() // return focus to the trigger, per the disclosure/APG pattern
  }
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer)
  document.addEventListener('keydown', onDocKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer)
  document.removeEventListener('keydown', onDocKeydown)
})

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
          <UiButton
            type="button"
            size="sm"
            icon="filter"
            aria-controls="list-filter-panel"
            :aria-expanded="openPanel === 'filter'"
            class="list__tool-btn"
            @click="togglePanel('filter', $event)"
          >
            {{ t('list.filter') }}<span v-if="activeFilters.length" class="list__tool-count">{{ activeFilters.length }}</span>
          </UiButton>
          <div v-if="openPanel === 'filter'" id="list-filter-panel" class="list__panel list__panel--filter">
            <p v-if="!filterableColumns.length" class="list__panel-empty">{{ t('list.noFilters') }}</p>
            <div v-for="c in filterableColumns" :key="c.key" class="list__filter-row">
              <span class="list__filter-label">{{ colLabel(c) }}</span>
              <div class="list__filter-controls">
                <select
                  v-if="opsFor(c).length > 1"
                  class="list__filter-op"
                  :data-filter-op="c.key"
                  :aria-label="`${t('filter.operator')} — ${colLabel(c)}`"
                  :value="draft[c.key]?.op"
                  @change="setOp(c.key, ($event.target as HTMLSelectElement).value as FilterOp)"
                >
                  <option v-for="op in opsFor(c)" :key="op" :value="op">{{ opLabel(c.filterKind ?? 'text', op) }}</option>
                </select>

                <input
                  v-if="c.filterKind === 'datetime'"
                  type="date"
                  class="list__filter"
                  :data-filter="c.key"
                  :aria-label="colLabel(c)"
                  :value="draft[c.key]?.value ?? ''"
                  @input="setValue(c.key, ($event.target as HTMLInputElement).value)"
                >
                <input
                  v-else-if="c.filterKind === 'number' || c.filterKind === 'ref' || c.filterKind === 'idSet'"
                  type="number"
                  class="list__filter"
                  :data-filter="c.key"
                  :aria-label="colLabel(c)"
                  :value="draft[c.key]?.value ?? ''"
                  @input="setValue(c.key, ($event.target as HTMLInputElement).value)"
                >
                <select
                  v-else-if="c.filterKind === 'boolean'"
                  class="list__filter"
                  :data-filter="c.key"
                  :aria-label="colLabel(c)"
                  :value="draft[c.key]?.value ?? ''"
                  @change="setValue(c.key, ($event.target as HTMLSelectElement).value)"
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
                  @change="setValue(c.key, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">—</option>
                  <option v-for="o in enumOptions(c)" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
                <input
                  v-else
                  type="text"
                  class="list__filter"
                  :data-filter="c.key"
                  :aria-label="colLabel(c)"
                  :value="draft[c.key]?.value ?? ''"
                  :placeholder="t('list.filterPlaceholder', { name: colLabel(c) })"
                  @input="setValue(c.key, ($event.target as HTMLInputElement).value)"
                >
              </div>
            </div>
            <button v-if="activeFilters.length" type="button" class="list__panel-action" @click="clearAllFilters">{{ t('list.filterClearAll') }}</button>
          </div>
        </div>

        <div class="list__tool">
          <UiButton
            type="button"
            size="sm"
            icon="columns"
            aria-controls="list-columns-panel"
            :aria-expanded="openPanel === 'columns'"
            class="list__tool-btn"
            @click="togglePanel('columns', $event)"
          >{{ t('list.columns') }}</UiButton>
          <div v-if="openPanel === 'columns'" id="list-columns-panel" class="list__panel">
            <label v-for="c in available" :key="c.key" class="list__col-row">
              <UiCheckbox
                class="list__col-check"
                :data-col="c.key"
                :model-value="visibleKeys.includes(c.key)"
                :disabled="visibleKeys.length === 1 && visibleKeys.includes(c.key)"
                @update:model-value="() => toggleColumn(c.key)"
              />
              <span>{{ colLabel(c) }}</span>
            </label>
            <button v-if="!columnsAreDefault" type="button" class="list__panel-action" @click="resetColumns">{{ t('list.columnsReset') }}</button>
          </div>
        </div>
      </div>

      <NuxtLink :to="`/admin/${collection}/new${localeQuery}`" class="list__new">{{ newLabel }}</NuxtLink>
    </div>

    <!-- Bulk action bar: chrome (flex:0 0 auto) that appears when ≥1 row is selected, shrinking the one
         scroll region rather than overlaying it. Publish/Unpublish are schema-driven (only when status).
         NOT a live region: the selection count is announced through the permanent .list__sr-status region
         (see `srStatus`); a v-if-toggled role="status" here would double up and stay silent on first show. -->
    <div v-if="selected.size" class="list__bulkbar">
      <span class="list__bulk-count">{{ t('list.selected', { n: selected.size }) }}</span>
      <div class="list__bulk-actions">
        <template v-if="schema.status">
          <UiButton type="button" size="sm" variant="secondary" :disabled="opsBusy" @click="onBulkStatus('published')">{{ t('list.bulkPublish') }}</UiButton>
          <UiButton type="button" size="sm" variant="secondary" :disabled="opsBusy" @click="onBulkStatus('draft')">{{ t('list.bulkUnpublish') }}</UiButton>
        </template>
        <UiButton type="button" size="sm" variant="danger" :disabled="opsBusy" @click="askDelete([...selected])">{{ t('list.bulkDelete') }}</UiButton>
        <UiButton type="button" size="sm" variant="ghost" @click="clearSelection">{{ t('list.clearSelection') }}</UiButton>
      </div>
    </div>

    <div v-if="activeFilters.length" class="list__chips">
      <span v-for="f in activeFilters" :key="f.key" class="list__chip">
        <span class="list__chip-label">{{ f.label }} {{ f.opLabel }}:</span> {{ f.display }}
        <button type="button" class="list__chip-x" :aria-label="t('list.removeFilter', { name: f.label })" @click="clearFilter(f.key)">
          <UiIcon name="x" :size="12" />
        </button>
      </span>
    </div>

    <UiAlert v-if="error" variant="error" class="list__error">
      {{ error }}
      <UiButton type="button" variant="secondary" size="sm" class="list__retry" @click="fetchRows">{{ t('common.retry') }}</UiButton>
    </UiAlert>

    <!-- The one scroll region: the table + its alternate empty-states scroll here while the bar, chips,
         error and pager stay fixed (see the admin layout's scroll-ownership convention). -->
    <div class="list__scroll">
      <table class="list__table">
        <thead>
          <tr>
            <th class="list__select-th" scope="col">
              <UiCheckbox
                :model-value="allSelected"
                :indeterminate="headerIndeterminate"
                :aria-label="t('list.selectAll')"
                @update:model-value="toggleAll"
              />
            </th>
            <!-- Row actions: an always-visible, left-frozen chrome column placed right after Select. Its
                 accessible name is real visually-hidden text, not aria-label on a static <th> (which several
                 screen-reader / browser pairs ignore on non-interactive table cells). -->
            <th class="list__actions-th" scope="col">
              <span class="list__vh">{{ t('a11y.rowActions') }}</span>
            </th>
            <th
              v-for="c in visibleColumns"
              :key="c.key"
              scope="col"
              :aria-sort="c.sortable ? ariaSort(c.key) : undefined"
              :class="{ 'list__th-narrow': c.type === 'translations' || c.type === 'deadRefs' }"
            >
              <button v-if="c.sortable" type="button" class="list__sort" @click="setSort(c.key)">{{ colLabel(c) }}<span aria-hidden="true">{{ arrow(c.key) }}</span></button>
              <span v-else>{{ colLabel(c) }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)" class="list__row">
            <td class="list__select-cell">
              <UiCheckbox
                :model-value="selected.has(Number(row.id))"
                :aria-label="t('list.selectRow', { name: rowLabel(row) })"
                @update:model-value="(v) => toggleRow(Number(row.id), v)"
              />
            </td>
            <td class="list__actions-cell">
              <div class="list__row-actions">
                <NuxtLink :to="`/admin/${collection}/${row.id}${localeQuery}`" class="list__action-btn" :aria-label="t('list.rowEdit', { name: rowLabel(row) })">
                  <UiIcon name="pencil" :size="15" />
                </NuxtLink>
                <button type="button" class="list__action-btn" :disabled="opsBusy" :aria-label="t('list.rowDuplicate', { name: rowLabel(row) })" @click="onDuplicate(Number(row.id))">
                  <UiIcon name="copy" :size="15" />
                </button>
                <button type="button" class="list__action-btn list__action-btn--danger" :disabled="opsBusy" :aria-label="t('list.rowDelete', { name: rowLabel(row) })" @click="askDelete([Number(row.id)])">
                  <UiIcon name="trash" :size="15" />
                </button>
              </div>
            </td>
            <td v-for="c in visibleColumns" :key="c.key" :class="{ 'list__narrow-cell': c.type === 'translations' || c.type === 'deadRefs' }">
              <span v-if="c.type === 'deadRefs'" class="list__deadrefs">
                <UiIcon
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

      <UiEmptyState
        v-if="!rows.length && !error && activeFilters.length"
        icon="filter"
        :title="t('list.noMatch.title')"
        :description="t('list.noMatch.desc', { name: label })"
      >
        <template #action>
          <button type="button" class="list__new" @click="clearAllFilters">{{ t('list.filterClearAll') }}</button>
        </template>
      </UiEmptyState>
      <UiEmptyState
        v-else-if="!rows.length && !error"
        icon="file-text"
        :title="t('list.empty.title')"
        :description="t('list.empty.desc', { name: label })"
      >
        <template #action>
          <NuxtLink :to="`/admin/${collection}/new${localeQuery}`" class="list__new">{{ newLabel }}</NuxtLink>
        </template>
      </UiEmptyState>
    </div>

    <p class="list__sr-status" role="status" aria-live="polite">{{ srStatus }}</p>

    <div class="list__pager">
      <UiButton type="button" size="sm" :disabled="page <= 1" @click="prev">{{ t('list.prev') }}</UiButton>
      <span class="list__page">{{ t('list.page', { page, totalPages, total }) }}</span>
      <UiButton type="button" size="sm" :disabled="page >= totalPages" @click="next">{{ t('list.next') }}</UiButton>
      <label class="list__perpage">
        <span class="list__perpage-label">{{ t('list.perPage') }}</span>
        <select
          class="list__perpage-select"
          :value="perPage"
          :aria-label="t('list.perPage')"
          @change="setPerPage(Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="n in PER_PAGE_OPTIONS" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
    </div>

    <CollectionDeleteDialog
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

// Visually-hidden text for a static cell that must be announced but not shown (the Actions column header).
// Same technique as .list__sr-status above; chosen over aria-label, which is unreliably announced on
// non-interactive table cells.
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

// Fills the height handed down and stays fixed itself; scroll is delegated to .list__scroll. Overflow is
// left VISIBLE (not a scroll container) so the inline Filter/Columns popovers are never clipped.
.list {
  // Frozen-column token: the actions column's sticky `left` must equal the select column's width
  // (1.25rem checkbox + 2×var(--space-3) cell padding). Keep in sync if the checkbox size or padding change.
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

  // Filter / Columns toolbar
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
  &__filter-controls .list__filter {
    flex: 1 1 auto;
    min-width: 0;
  }
  &__col-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    cursor: pointer;
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
  &__filter {
    width: 100%;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font: inherit;
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

  // Bulk action bar — appears above the scroll region when ≥1 row is selected.
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
