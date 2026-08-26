// The Filter panel's pending edits, and how they become committed clauses in the URL.
//
// `filter` (from the URL) is the committed state that drives the query; `draft` is what the panel shows
// while the user is still typing. A value change debounces, an operator change commits at once.
import { computed, onBeforeUnmount, reactive, watch, type ComputedRef } from 'vue'
import { DEFAULT_OP, OPS_BY_KIND } from '@michaelthielemann/kestrel-core/client'
import type { FilterKind, FilterOp } from '@michaelthielemann/kestrel-core/client'
import type { Localized } from '@michaelthielemann/kestrel-core'
import { resolveLocalized } from '../../../ui/app/utils/localized'
import { columnLabel } from '../utils/list-cell'
import type { ListColumn } from '../utils/list-columns'
import type { FilterCell } from '../utils/list-query'

const COMMIT_DEBOUNCE_MS = 250

/** One active clause as the chip row renders it. */
export interface ActiveFilter {
  key: string
  op: FilterOp
  opLabel: string
  label: string
  display: string
}

/** The panel's whole controller — passed to the filter panel as one prop rather than a dozen. */
export interface ListFilterDraft {
  draft: Record<string, FilterCell>
  activeFilters: ComputedRef<ActiveFilter[]>
  opsFor: (c: ListColumn) => readonly FilterOp[]
  opLabel: (kind: FilterKind, op: FilterOp) => string
  enumOptions: (c: ListColumn) => { label: string; value: string }[]
  setValue: (field: string, value: string) => void
  setOp: (field: string, op: FilterOp) => void
  clearFilter: (field: string) => void
  clearAll: () => void
}

interface FilterDraftOptions {
  available: ComputedRef<ListColumn[]>
  filterableColumns: ComputedRef<ListColumn[]>
  filter: ComputedRef<Record<string, FilterCell>>
  setFilter: (next: Record<string, FilterCell>) => void
}

export function useListFilterDraft(opts: FilterDraftOptions): ListFilterDraft {
  const { t, lang } = useT()
  const draft = reactive<Record<string, FilterCell>>({})

  // Overwrite each draft cell FROM the committed `filter` so deep-link / Back-Forward / chip-removal reflect
  // back into the open panel; drop drafts for columns this collection no longer has. We key the watch on the
  // committed filter's CONTENT (its JSON), not its object identity: `filter` recomputes to a fresh-but-EQUAL
  // object on every `route.query` change (page/sort/perPage navigations too), and resyncing on those identity
  // flips would wipe an in-progress panel edit. Clobber-safe on a real filter commit: a commit sends ALL
  // drafts at once, so post-commit `filter` equals `draft` (a no-op overwrite) — the content only actually
  // changes on external navigation (deep-link/Back-Forward/chip-removal), which is when the panel should resync.
  watch([opts.filterableColumns, () => JSON.stringify(opts.filter.value)], () => {
    const cols = opts.filterableColumns.value
    for (const c of cols) {
      const cm = opts.filter.value[c.key]
      draft[c.key] = { op: cm?.op ?? DEFAULT_OP[c.filterKind ?? 'text'], value: cm?.value ?? '' }
    }
    for (const key of Object.keys(draft)) if (!cols.some((c) => c.key === key)) Reflect.deleteProperty(draft, key)
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
    // A choice label is `Localized`, so resolve it here as the editor widget does — `{{ o.label }}` would
    // stringify a `{ en, de }` map into the filter dropdown.
    return ((c.field?.options?.choices ?? []) as { label: Localized; value: string }[])
      .map((o) => ({ value: o.value, label: resolveLocalized(o.label, lang.value) ?? o.value }))
  }
  function displayValue(kind: FilterKind, value: string): string {
    if (kind === 'boolean') return value === 'true' ? t('filter.bool.true') : value === 'false' ? t('filter.bool.false') : value
    return value
  }

  // Builds a fresh clause map from the non-empty draft cells and navigates via `setFilter` (which also
  // resets page → 1).
  let timer: ReturnType<typeof setTimeout> | undefined
  function commitDrafts() {
    const next: Record<string, FilterCell> = {}
    for (const [field, cell] of Object.entries(draft)) {
      if (cell.value !== '' && cell.value != null) next[field] = { op: cell.op, value: cell.value }
    }
    opts.setFilter(next)
  }
  function setValue(field: string, value: string) {
    if (draft[field]) draft[field].value = value
    clearTimeout(timer)
    timer = setTimeout(commitDrafts, COMMIT_DEBOUNCE_MS)
  }
  function setOp(field: string, op: FilterOp) {
    if (draft[field]) draft[field].op = op
    // An operator change is deliberate — re-query immediately (no debounce) if the field has a value.
    clearTimeout(timer)
    commitDrafts()
  }
  function clearFilter(field: string) {
    if (draft[field]) draft[field].value = ''
    commitDrafts() // re-commits the drafts with this one now empty → the clause is dropped (and page → 1)
  }
  function clearAll() {
    for (const cell of Object.values(draft)) cell.value = ''
    opts.setFilter({}) // clear the committed clauses (and page → 1); the draft-resync watch clears the panel
  }
  onBeforeUnmount(() => clearTimeout(timer))

  const activeFilters = computed(() => Object.entries(opts.filter.value).map(([key, cell]) => {
    const col = opts.available.value.find((c) => c.key === key)
    const kind = col?.filterKind ?? 'text'
    return { key, op: cell.op, opLabel: opLabel(kind, cell.op), label: col ? columnLabel(col, t) : key, display: displayValue(kind, cell.value) }
  }))

  return { draft, activeFilters, opsFor, opLabel, enumOptions, setValue, setOp, clearFilter, clearAll }
}
