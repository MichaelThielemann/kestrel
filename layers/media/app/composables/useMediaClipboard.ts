import { ref, computed } from 'vue'
import type { OpItem } from '../utils/ops'

// Module-level singleton so the clipboard survives folder navigation + remounts.
const clipboard = ref<{ mode: 'cut' | 'copy'; items: OpItem[] } | null>(null)

export function useMediaClipboard() {
  const isEmpty = computed(() => !clipboard.value?.items.length)
  const count = computed(() => clipboard.value?.items.length ?? 0)
  function cut(items: OpItem[]) { clipboard.value = { mode: 'cut', items } }
  function copy(items: OpItem[]) { clipboard.value = { mode: 'copy', items } }
  function clear() { clipboard.value = null }
  return { clipboard, isEmpty, count, cut, copy, clear }
}
