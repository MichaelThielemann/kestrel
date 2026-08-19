// Page-scoped row selection for the collection list.
//
// The Set is valid only for the rows currently on screen — every (re)fetch replaces them, so the caller
// clears it from its fetch handler. A reactive Set (Vue tracks add/delete/has/size) keeps a single-row
// toggle O(1): no full-Set copy and no whole-table re-diff per click, which mattered at the 500-row cap.
import { computed, reactive, type Ref } from 'vue'

export function useListSelection(rows: Ref<Record<string, unknown>[]>) {
  const selected = reactive(new Set<number>())
  const pageIds = computed(() => rows.value.map((r) => Number(r.id)))
  const allSelected = computed(() => pageIds.value.length > 0 && pageIds.value.every((id) => selected.has(id)))
  // Tri-state header checkbox: some rows selected, but not all of them.
  const headerIndeterminate = computed(() => pageIds.value.some((id) => selected.has(id)) && !allSelected.value)

  function toggleRow(id: number, on: boolean) {
    if (on) selected.add(id)
    else selected.delete(id)
  }
  function toggleAll(on: boolean) {
    selected.clear()
    if (on) for (const id of pageIds.value) selected.add(id)
  }
  function clear() {
    selected.clear()
  }

  return { selected, allSelected, headerIndeterminate, toggleRow, toggleAll, clear }
}
