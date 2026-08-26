import type { Ref } from 'vue'
import type { ListColumn } from '../utils/list-columns'
import { toQuery, toggleSort, parseListQuery, type FilterCell, type ListState } from '../utils/list-query'
import { clampPerPage, DEFAULT_PER_PAGE } from '@michaelthielemann/kestrel-core/client'

/**
 * The URL is the SINGLE SOURCE OF TRUTH for a collection list's committed state (sort · page · perPage ·
 * filter). This composable derives that state from `route.query` (sanitized via `parseListQuery`, so a
 * hostile/partial URL degrades to defaults rather than reaching the server), and turns each mutation into a
 * router navigation: `page` uses `push` (Back walks pages), everything else uses `replace` (typing / toggling
 * must not spam history). Every non-page action also resets `page → 1`, so a page-only transition is the only
 * one that ever differs by page alone — the push/replace split is exact.
 *
 * The per-page cookie is a DEFAULT, never state: when the URL carries no `perPage`, the initial value is
 * seeded from the cookie (clamped); when perPage changes we write the cookie so a chosen density survives
 * navigation. The URL always wins.
 */
export function useListUrlState(columns: Ref<ListColumn[]>) {
  const route = useRoute()
  const router = useRouter()
  const perPageCookie = useCookie<number>('kestrel-list-per-page', { default: () => DEFAULT_PER_PAGE })

  const parsed = computed(() => parseListQuery(route.query, columns.value))
  const sort = computed(() => parsed.value.sort ?? '-createdAt')
  const page = computed(() => parsed.value.page ?? 1)
  const perPage = computed(() => parsed.value.perPage ?? clampPerPage(perPageCookie.value)) // URL wins, else cookie
  const filter = computed(() => parsed.value.filter ?? {})
  // The exact `$fetch` query the list endpoint expects — always the SANITIZED computeds, never the raw URL.
  const effectiveQuery = computed(() => toQuery({ sort: sort.value, page: page.value, perPage: perPage.value, filter: filter.value }))

  // We replace the WHOLE query on every navigation, so re-merge `locale` from the RAW URL (it lives outside
  // the list-state keys and must survive a sort/page/filter change). Reading `route.query.locale` — NOT a
  // resolved prop — keeps a locale-LESS URL locale-less after a list mutation: for a translatable collection
  // the prop is the PRIMARY locale even when the URL carries no `?locale`, so merging it would inject
  // `locale=<primary>`, flip the host page's `${collection}::${locale}` key and needlessly REMOUNT the list
  // mid-edit. The locale switcher still navigates with an explicit `?locale`, which is preserved here (and
  // correctly re-keys → remounts on a real locale switch).
  function go(patch: Partial<ListState>, mode: 'push' | 'replace') {
    const next: ListState = { sort: sort.value, page: page.value, perPage: perPage.value, filter: filter.value, ...patch }
    const locale = route.query.locale
    return router[mode]({ query: { ...toQuery(next), ...(typeof locale === 'string' ? { locale } : {}) } })
  }

  const setSort = (f: string) => go({ sort: toggleSort(sort.value, f), page: 1 }, 'replace')
  const setPage = (p: number) => go({ page: p }, 'push')
  // Corrective clamp (a page that emptied out from under us) — REPLACE, not push, so the now-invalid page
  // doesn't stay a reachable history entry that Back bounces the user forward from on every press.
  const clampPage = (p: number) => go({ page: p }, 'replace')
  const setPerPage = (n: number) => { perPageCookie.value = clampPerPage(n); return go({ perPage: clampPerPage(n), page: 1 }, 'replace') }
  const setFilter = (f: Record<string, FilterCell>) => go({ filter: f, page: 1 }, 'replace')

  return { sort, page, perPage, filter, effectiveQuery, setSort, setPage, clampPage, setPerPage, setFilter }
}
