// Toolbar disclosure panels (filter / columns). Plain inline panels, not teleported, so they stay
// testable and keep their scoped styles; a document listener closes them on an outside click.
import { onBeforeUnmount, onMounted, ref } from 'vue'

export function useToolbarPanel<T extends string>() {
  const container = ref<HTMLElement | null>(null)
  const open = ref<T | null>(null)
  // The element that opened the current panel — Escape restores focus to it (otherwise closing the panel
  // from inside drops keyboard focus onto <body>, stranding the keyboard user at the top of the document).
  let trigger: HTMLElement | null = null

  function toggle(which: T, e: MouseEvent) {
    if (open.value === which) { open.value = null; return }
    trigger = e.currentTarget as HTMLElement
    open.value = which
  }
  function onDocPointer(e: PointerEvent) {
    // Outside click: close but do NOT steal focus — it belongs wherever the user just clicked.
    if (container.value && !container.value.contains(e.target as Node)) open.value = null
  }
  function onDocKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open.value) {
      open.value = null
      trigger?.focus() // return focus to the trigger, per the disclosure/APG pattern
    }
  }

  onMounted(() => {
    document.addEventListener('pointerdown', onDocPointer)
    document.addEventListener('keydown', onDocKeydown)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onDocPointer)
    document.removeEventListener('keydown', onDocKeydown)
  })

  return { container, open, toggle }
}
