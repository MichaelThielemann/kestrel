// The collection list's row fetch: request, out-of-range clamp, and the inline error state.
import { computed, ref, type ComputedRef, type Ref } from 'vue'

interface ListRowsOptions {
  collection: ComputedRef<string>
  /** The sanitized query derived from the URL (sort / page / perPage / filter). */
  effectiveQuery: ComputedRef<Record<string, unknown>>
  locale: () => string | undefined
  page: ComputedRef<number>
  perPage: ComputedRef<number>
  /** Navigate back into range when the current page emptied out; REPLACE, never push. */
  clampPage: (page: number) => void
  /** Runs after a SUCCESSFUL fetch — the caller drops its page-scoped state here. A failed fetch keeps
   *  the previously rendered rows, so anything scoped to them stays valid. */
  onLoaded?: () => void
}

interface ListResponse {
  data: Record<string, unknown>[]
  total: number
  page: number
  perPage: number
  /** Set by `validateOut` — count of rows in `data` replaced with the quarantine shape. */
  quarantinedCount?: number
}

export function useListRows(opts: ListRowsOptions) {
  const { t } = useT()
  const rows = ref<Record<string, unknown>[]>([])
  const total = ref(0)
  const quarantinedCount = ref(0)
  // Surfaced when a (re)fetch fails — an inline error + Retry, never a silent stale list or a thrown
  // error boundary. Distinct from the empty state (which only shows when the fetch SUCCEEDED with no rows).
  const error = ref<string | null>(null)
  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / opts.perPage.value)))

  // Monotonic request id: a slow earlier response must not overwrite a newer one.
  let seq = 0
  async function fetchRows() {
    const mine = ++seq
    const locale = opts.locale()
    try {
      const res = await $fetch<ListResponse>(`/api/${opts.collection.value}/readMany`, {
        query: { ...opts.effectiveQuery.value, ...(locale ? { locale } : {}) },
      })
      if (mine !== seq) return
      rows.value = res.data
      total.value = res.total
      quarantinedCount.value = res.quarantinedCount ?? 0
      error.value = null
      // A page that emptied out from under us — e.g. bulk-deleting the last rows of the trailing page —
      // would otherwise strand the user on an out-of-range page showing the "create your first" empty
      // state. Clamp back to the last page that still has rows (REPLACE, so the dead page isn't left as a
      // history entry that Back would bounce off; the query watch refetches).
      if (res.data.length === 0 && res.total > 0 && opts.page.value > 1) {
        opts.clampPage(Math.max(1, Math.ceil(res.total / opts.perPage.value)))
      }
      opts.onLoaded?.()
    } catch (e) {
      if (mine !== seq) return
      // Keep any previously-rendered rows, but surface that this fetch failed (and don't show the
      // "create your first" empty state — that would imply the collection is empty when it isn't).
      error.value = (e as { statusMessage?: string })?.statusMessage ?? t('list.loadError')
    }
  }

  return { rows, total, quarantinedCount, error, totalPages, fetchRows } as {
    rows: Ref<Record<string, unknown>[]>
    total: Ref<number>
    quarantinedCount: Ref<number>
    error: Ref<string | null>
    totalPages: ComputedRef<number>
    fetchRows: () => Promise<void>
  }
}
