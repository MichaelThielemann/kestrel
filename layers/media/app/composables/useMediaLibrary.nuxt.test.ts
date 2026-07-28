import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { registerEndpoint, mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent } from 'vue'
import { getQuery } from 'h3'
import { useMediaLibrary } from './useMediaLibrary'

const page1 = {
  folder: '', exists: true, folders: [{ path: 'pics', name: 'pics', size: 0 }],
  files: Array.from({ length: 60 }, (_, i) => ({ id: i + 1, filename: `f${i + 1}.png`, mime: 'image/png', folder: '', size: 1, src: `/u/f${i + 1}` })),
  total: 61, page: 1, perPage: 60,
}
const page2 = { ...page1, folders: [], files: [{ id: 61, filename: 'f61.png', mime: 'image/png', folder: '', size: 1, src: '/u/f61' }], page: 2 }

let lastQuery: Record<string, unknown> = {}

registerEndpoint('/api/media/library', (event) => {
  lastQuery = getQuery(event)
  const url = new URL(event.node.req.url ?? '', 'http://localhost')
  if (url.searchParams.get('folder') === 'ghost') return { folder: 'ghost', exists: false, folders: [], files: [], total: 0, page: 1, perPage: 60 }
  return url.searchParams.get('page') === '2' ? page2 : page1
})

const Host = defineComponent({ setup: () => ({ lib: useMediaLibrary() }), template: '<div/>' })

describe('useMediaLibrary', () => {
  it('fetches the current folder on mount', async () => {
    const w = await mountSuspended(Host)
    await flushPromises()
    expect(w.vm.lib.folders.value.map((f) => f.path)).toEqual(['pics'])
    expect(w.vm.lib.files.value.length).toBe(60)
    expect(w.vm.lib.total.value).toBe(61)
    expect(w.vm.lib.hasMore.value).toBe(true)
  })
  it('loadMore appends the next page', async () => {
    const w = await mountSuspended(Host)
    await flushPromises()
    await w.vm.lib.loadMore()
    expect(w.vm.lib.files.value.length).toBe(61)
    expect(w.vm.lib.hasMore.value).toBe(false)
  })
  it('a non-append refresh after loadMore resets to page 1 (never collapses to just the last page)', async () => {
    const w = await mountSuspended(Host)
    await flushPromises()
    await w.vm.lib.loadMore() // page 2 → 61 files shown
    expect(w.vm.lib.files.value.length).toBe(61)
    await w.vm.lib.fetchLibrary() // an external refresh (delete/upload/rename/alt-save)
    await flushPromises()
    expect(w.vm.lib.page.value).toBe(1)
    expect(w.vm.lib.files.value.length).toBe(60) // page 1, not the 1 leftover page-2 file
    expect(w.vm.lib.hasMore.value).toBe(true)
  })
  it('selection: select replaces, toggle adds/removes, clear empties', async () => {
    const w = await mountSuspended(Host)
    await flushPromises()
    const a = w.vm.lib.items.value[0]
    const b = w.vm.lib.items.value[1]
    w.vm.lib.select(a); expect(w.vm.lib.count.value).toBe(1)
    w.vm.lib.toggle(b); expect(w.vm.lib.count.value).toBe(2)
    w.vm.lib.toggle(b); expect(w.vm.lib.count.value).toBe(1)
    w.vm.lib.clear(); expect(w.vm.lib.count.value).toBe(0)
  })
  it('range selects inclusively from the anchor', async () => {
    const w = await mountSuspended(Host)
    await flushPromises()
    const items = w.vm.lib.items.value
    w.vm.lib.select(items[0])   // anchor at the folder
    w.vm.lib.range(items[3])    // folder + first 3 files = 4
    expect(w.vm.lib.count.value).toBe(4)
  })

  it('surfaces an error (not a blank listing) when navigating to a folder that does not exist', async () => {
    const GhostHost = defineComponent({ setup: () => ({ lib: useMediaLibrary({ urlSync: false }) }), template: '<div/>' })
    const w = await mountSuspended(GhostHost)
    await flushPromises()
    await w.vm.lib.navigate('ghost')
    expect(w.vm.lib.error.value).toBeTruthy()
    expect(w.vm.lib.folders.value.length).toBe(0)
    expect(w.vm.lib.files.value.length).toBe(0)
  })

  it('setSort toggles direction on the same field and re-queries', async () => {
    const SortHost = defineComponent({ setup: () => ({ lib: useMediaLibrary({ urlSync: false }) }), template: '<div/>' })
    const w = await mountSuspended(SortHost)
    await flushPromises()
    await w.vm.lib.setSort('size')
    expect(w.vm.lib.sort.value).toBe('size')
    expect(lastQuery.sort).toBe('size')
    await w.vm.lib.setSort('size')
    expect(w.vm.lib.sort.value).toBe('-size')
    expect(lastQuery.sort).toBe('-size')
  })

  it('clears the active search filter when navigating to another folder', async () => {
    const NavHost = defineComponent({ setup: () => ({ lib: useMediaLibrary({ urlSync: false }) }), template: '<div/>' })
    const w = await mountSuspended(NavHost)
    await flushPromises()
    w.vm.lib.setSearch('foo')
    expect(w.vm.lib.search.value).toBe('foo')
    await w.vm.lib.navigate('pics')
    expect(w.vm.lib.search.value).toBe('')
  })

  it('with urlSync:false, navigate fetches directly without the router and accept:image filters', async () => {
    const PickerHost = defineComponent({ setup: () => ({ lib: useMediaLibrary({ urlSync: false, accept: 'image' }) }), template: '<div/>' })
    const w = await mountSuspended(PickerHost)
    await flushPromises()
    expect(lastQuery.type).toBe('image')
    w.vm.lib.navigate('sub')
    await flushPromises()
    expect(w.vm.lib.folder.value).toBe('sub')
    expect(lastQuery.folder).toBe('sub')
  })
})
