import { ref } from 'vue'

/**
 * The shared HTML drag-and-drop REORDER interaction (chip lists, media tiles, …): owns the `dragIndex` /
 * `overIndex` state and the five dnd handlers, so a widget only supplies `disabled` and a `commit(from,
 * to)` that actually reorders its model (and announces the move). The index passed to the handlers is
 * whatever the widget renders by (a model index for the combobox, a resolved/subsequence index for the
 * media field) — `commit` maps it.
 */
export function useDragReorder(opts: { disabled: () => boolean; commit: (from: number, to: number) => void }) {
  const dragIndex = ref<number | null>(null)
  const overIndex = ref<number | null>(null)

  function onDragStart(index: number, event: DragEvent) {
    if (opts.disabled()) return
    dragIndex.value = index
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', String(index)) // Firefox needs data set to start the drag
    }
  }
  function onDragEnter(index: number) {
    if (dragIndex.value !== null) overIndex.value = index
  }
  // Clear the drop highlight only when the cursor leaves the list entirely (not on item-to-item moves).
  function onDragLeave(event: DragEvent) {
    if (!(event.currentTarget as Element).contains(event.relatedTarget as Node | null)) overIndex.value = null
  }
  function onDrop(index: number) {
    if (opts.disabled() || dragIndex.value === null) return
    if (dragIndex.value !== index) opts.commit(dragIndex.value, index)
    dragIndex.value = null
    overIndex.value = null
  }
  function onDragEnd() {
    dragIndex.value = null
    overIndex.value = null
  }

  return { dragIndex, overIndex, onDragStart, onDragEnter, onDragLeave, onDrop, onDragEnd }
}
