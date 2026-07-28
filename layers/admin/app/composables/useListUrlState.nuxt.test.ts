import { describe, it, expect, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { useListUrlState } from './useListUrlState'
import type { ListColumn } from '../utils/list-columns'

const cols: ListColumn[] = [
  { key: 'title', type: 'field', name: 'title', sortable: true, filterable: true, filterKind: 'text' },
  { key: 'createdAt', type: 'meta', labelKey: 'list.col.createdAt', sortable: true, filterable: true, filterKind: 'datetime' },
]

// The composable navigates the shared test router — reset it before each case so URL state never leaks.
beforeEach(async () => { await useRouter().replace({ path: '/', query: {} }) })

describe('useListUrlState', () => {
  it('seeds sort/page/perPage/filter from the URL query', async () => {
    await useRouter().replace({ query: { sort: '-title', page: '2', perPage: '50', 'filter[title]': 'Al' } })
    const s = useListUrlState(ref(cols))
    expect(s.sort.value).toBe('-title')
    expect(s.page.value).toBe(2)
    expect(s.perPage.value).toBe(50)
    expect(s.filter.value).toEqual({ title: { op: 'eq', value: 'Al' } })
  })

  it('falls back to defaults when the URL carries no list state', async () => {
    const s = useListUrlState(ref(cols))
    expect(s.sort.value).toBe('-createdAt')
    expect(s.page.value).toBe(1)
    expect(s.filter.value).toEqual({})
  })

  it('perPage: the URL wins; a garbage or absent perPage falls back to the cookie', async () => {
    // Seed the density cookie the same way the app does (write through a useCookie ref, then let the write
    // settle) so the composable's own cookie read sees a non-default value.
    useCookie<number>('kestrel-list-per-page').value = 100
    await nextTick()
    await new Promise((r) => setTimeout(r, 10))
    // absent → cookie
    expect(useListUrlState(ref(cols)).perPage.value).toBe(100)
    // garbage → cookie (the URL value is unusable, so the density default holds)
    await useRouter().replace({ query: { perPage: 'abc' } })
    expect(useListUrlState(ref(cols)).perPage.value).toBe(100)
    // present → the URL wins over the cookie
    await useRouter().replace({ query: { perPage: '50' } })
    expect(useListUrlState(ref(cols)).perPage.value).toBe(50)
  })

  it('setPage pushes (Back walks pages); setSort/setPerPage/setFilter replace, each resetting page and preserving an explicit URL locale', async () => {
    // The locale rides in the URL, not a prop: seed `?locale=de` and every list mutation must carry it through.
    await useRouter().replace({ query: { locale: 'de' } })
    const router = useRouter()
    const push = vi.spyOn(router, 'push')
    const replace = vi.spyOn(router, 'replace')
    const s = useListUrlState(ref(cols))

    await s.setPage(4)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0]![0]).toMatchObject({ query: { page: 4, locale: 'de' } })

    replace.mockClear()
    await s.setSort('title')
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace.mock.calls[0]![0]).toMatchObject({ query: { sort: 'title', page: 1, locale: 'de' } })

    replace.mockClear()
    await s.setFilter({ title: { op: 'eq', value: 'x' } })
    expect(replace.mock.calls[0]![0]).toMatchObject({ query: { 'filter[title]': 'x', page: 1, locale: 'de' } })

    replace.mockClear()
    await s.setPerPage(50)
    expect(replace.mock.calls[0]![0]).toMatchObject({ query: { perPage: 50, page: 1, locale: 'de' } })

    push.mockRestore()
    replace.mockRestore()
  })

  // Regression: the locale is preserved from the RAW URL, never re-injected
  // from a resolved prop. On a locale-LESS URL (a translatable collection whose AdminNav links omit `?locale`),
  // no list mutation may introduce a `locale` key — otherwise the host page's `${collection}::${locale}` key
  // flips and Nuxt remounts the list mid-edit. This is why the composable takes no locale argument at all.
  it('never introduces a `locale` query param when the URL carries none', async () => {
    const router = useRouter()
    const replace = vi.spyOn(router, 'replace')
    const push = vi.spyOn(router, 'push')
    const s = useListUrlState(ref(cols)) // locale-less route (reset in beforeEach)

    await s.setFilter({ title: { op: 'eq', value: 'hel' } })
    expect(replace.mock.calls[0]![0]).toMatchObject({ query: { 'filter[title]': 'hel', page: 1 } })
    expect((replace.mock.calls[0]![0] as { query: Record<string, unknown> }).query).not.toHaveProperty('locale')

    replace.mockClear()
    await s.setSort('title')
    expect((replace.mock.calls[0]![0] as { query: Record<string, unknown> }).query).not.toHaveProperty('locale')

    await s.setPage(3)
    expect((push.mock.calls[0]![0] as { query: Record<string, unknown> }).query).not.toHaveProperty('locale')

    replace.mockRestore()
    push.mockRestore()
  })
})
