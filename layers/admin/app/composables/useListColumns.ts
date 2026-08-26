import type { Ref } from 'vue'
import type { SerializedCollection } from '@michaelthielemann/kestrel-core'
import { availableColumns, defaultVisibleKeys, resolveVisibleColumns, type ListColumn } from '../utils/list-columns'

/**
 * Per-collection list column visibility, persisted in a cookie (SSR-safe, like the rail-collapsed state).
 * The store maps collection name → the chosen visible keys; an absent entry falls back to the default set.
 * Stale keys (a since-removed field) are dropped on read via `resolveVisibleColumns`.
 */
export function useListColumns(schema: Ref<SerializedCollection>) {
  const store = useCookie<Record<string, string[]>>('kestrel-list-columns', { default: () => ({}) })

  const available = computed<ListColumn[]>(() => availableColumns(schema.value))
  const defaults = computed<string[]>(() => defaultVisibleKeys(schema.value))

  const visibleKeys = computed<string[]>(() => {
    const stored = store.value[schema.value.name]
    // Project through the available columns so order is canonical and removed columns disappear.
    return resolveVisibleColumns(available.value, stored ?? defaults.value).map((c) => c.key)
  })
  const visibleColumns = computed<ListColumn[]>(() => resolveVisibleColumns(available.value, visibleKeys.value))

  function persist(keys: string[]) {
    // Keep canonical order so persisted prefs round-trip stably.
    const ordered = available.value.filter((c) => keys.includes(c.key)).map((c) => c.key)
    store.value = { ...store.value, [schema.value.name]: ordered }
  }

  function toggle(key: string) {
    const next = new Set(visibleKeys.value)
    if (next.has(key)) {
      if (next.size <= 1) return // never hide the last column
      next.delete(key)
    } else {
      next.add(key)
    }
    persist([...next])
  }

  function reset() {
    const next = { ...store.value }
    Reflect.deleteProperty(next, schema.value.name)
    store.value = next
  }

  const isDefault = computed(() => {
    const a = visibleKeys.value
    const b = defaults.value
    return a.length === b.length && a.every((k, i) => k === b[i])
  })

  return { available, visibleColumns, visibleKeys, toggle, reset, isDefault }
}
