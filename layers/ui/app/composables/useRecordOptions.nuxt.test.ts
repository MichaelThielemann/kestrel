import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { getQuery } from 'h3'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, ref } from 'vue'
import { useRecordOptions } from './useRecordOptions'

registerEndpoint('/api/posts/options', (event) => {
  const q = getQuery(event)
  if (q.ids) return { data: [{ id: 1, label: 'First Post' }], total: 1 }
  if (q.search) return { data: [{ id: 2, label: 'Second Post' }], total: 1 }
  // no search/ids → the first page (list), used by the on-focus/empty-query load
  return { data: [{ id: 1, label: 'First Post' }, { id: 2, label: 'Second Post' }], total: 2 }
})

registerEndpoint('/api/things/options', (event) => {
  const q = getQuery(event)
  if (q.ids) return { data: [{ id: 10, label: 'Thing A' }], total: 1 }
  return { data: [], total: 0 }
})

describe('useRecordOptions', () => {
  it('resolves ids to labels via /api/<collection>/options?ids', async () => {
    const collection = ref('posts')
    const ids = ref([1])
    const locale = ref('en')
    let result: ReturnType<typeof useRecordOptions>
    const Wrapper = defineComponent({
      setup() { result = useRecordOptions(collection, ids, locale); return result },
      template: '<div />',
    })
    await mountSuspended(Wrapper)
    await flushPromises()
    expect(result!.selected.value.find((s) => s.value === 1)?.label).toBe('First Post')
  })

  it('debounce-searches via /api/<collection>/options?search', async () => {
    const collection = ref('posts')
    const ids = ref<number[]>([])
    const locale = ref('en')
    let result: ReturnType<typeof useRecordOptions>
    const Wrapper = defineComponent({
      setup() { result = useRecordOptions(collection, ids, locale); return result },
      template: '<div />',
    })
    await mountSuspended(Wrapper)
    result!.onSearch('sec')
    await new Promise((r) => setTimeout(r, 300))
    await flushPromises()
    expect(result!.options.value.some((o) => o.label === 'Second Post')).toBe(true)
  })

  it('loads the first page (list) when searched with an empty term', async () => {
    const collection = ref('posts')
    const ids = ref<number[]>([])
    const locale = ref('en')
    let result: ReturnType<typeof useRecordOptions>
    const Wrapper = defineComponent({
      setup() { result = useRecordOptions(collection, ids, locale); return result },
      template: '<div />',
    })
    await mountSuspended(Wrapper)
    result!.onSearch('')
    await new Promise((r) => setTimeout(r, 300))
    await flushPromises()
    expect(result!.options.value.length).toBe(2)
  })

  it('clears options and cache when collection changes', async () => {
    const collection = ref('posts')
    const ids = ref<number[]>([])
    const locale = ref('en')
    let result: ReturnType<typeof useRecordOptions>
    const Wrapper = defineComponent({
      setup() { result = useRecordOptions(collection, ids, locale); return result },
      template: '<div />',
    })
    await mountSuspended(Wrapper)
    result!.onSearch('sec')
    await new Promise((r) => setTimeout(r, 300))
    await flushPromises()
    expect(result!.options.value.length).toBeGreaterThan(0)

    collection.value = 'things'
    await flushPromises()
    expect(result!.options.value).toEqual([])

    // the 'posts' label cached for id 2 must be dropped on the switch → falls back to #2
    ids.value = [2]
    await new Promise((r) => setTimeout(r, 50))
    await flushPromises()
    expect(result!.selected.value.find((s) => s.value === 2)?.label).toBe('#2')

    // the new collection resolves its own ids
    ids.value = [10]
    await new Promise((r) => setTimeout(r, 50))
    await flushPromises()
    expect(result!.selected.value.find((s) => s.value === 10)?.label).toBe('Thing A')
  })
})
