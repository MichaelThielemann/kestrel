import { ref, computed, watch, onUnmounted } from 'vue'
import type { Ref } from 'vue'
import type { FieldOption } from '../utils/field-component'

export function useRecordOptions(
  collection: Ref<string>,
  ids: Ref<number[]>,
  locale: Ref<string>,
  labelField?: Ref<string | undefined>,
) {
  const cache = ref<Map<number, string>>(new Map())
  const options = ref<FieldOption[]>([])
  const loading = ref(false)

  const selected = computed<FieldOption[]>(() =>
    ids.value.map((value) => ({ value, label: cache.value.get(value) ?? `#${value}` })),
  )

  function cacheOptions(opts: FieldOption[]) {
    const next = new Map(cache.value)
    for (const o of opts) next.set(o.value, o.label)
    cache.value = next
  }

  // The endpoint returns { id, label }; map it to the combobox's { value, label }.
  async function fetchOptions(query: Record<string, unknown>): Promise<FieldOption[]> {
    const res = await $fetch<{ data: { id: number; label: string }[] }>(`/api/${collection.value}/options`, {
      query: { label: labelField?.value, locale: locale.value, ...query },
    })
    return res.data.map((r) => ({ value: r.id, label: r.label }))
  }

  // Labels are per-collection; drop stale options/cache on switch (runs before the resolve below).
  watch(collection, () => {
    cache.value = new Map()
    options.value = []
  })

  // Resolve labels for any current ids we don't yet have cached. Depends on collection too, so it
  // (re)resolves once the collection becomes available (a v-model prop can arrive after setup) and
  // after a switch — not only when ids change.
  watch([ids, collection], async () => {
    const missing = ids.value.filter((value) => !cache.value.has(value))
    const forCollection = collection.value
    if (!missing.length || !forCollection) return
    try {
      const data = await fetchOptions({ ids: missing.join(',') })
      if (collection.value === forCollection) cacheOptions(data) // discard if the collection switched mid-fetch
    } catch {
      // leave the unresolved ids as `#id` placeholders rather than throwing
    }
  }, { immediate: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  let searchSeq = 0

  function onSearch(term: string) {
    if (timer) clearTimeout(timer)
    // No collection → nothing to list. Bump the token so any in-flight fetch can't repopulate.
    if (!collection.value) { ++searchSeq; options.value = []; loading.value = false; return }
    timer = setTimeout(async () => {
      const seq = ++searchSeq
      const forCollection = collection.value
      loading.value = true
      try {
        // An empty term lists the first page (records appear on focus, no typing needed).
        const data = await fetchOptions(term.trim() ? { search: term } : {})
        // ignore if a newer search superseded this one, or the collection switched mid-fetch
        if (seq === searchSeq && collection.value === forCollection) {
          options.value = data
          cacheOptions(data)
        }
      } catch {
        if (seq === searchSeq) options.value = [] // failed search clears rather than showing stale matches
      } finally {
        if (seq === searchSeq) loading.value = false
      }
    }, 250)
  }

  onUnmounted(() => { if (timer) clearTimeout(timer) })

  return { options, selected, loading, onSearch }
}
