import { ref, computed } from 'vue'
import type { LibraryItem } from '../utils/library'
import { resolveTargetItem, effectiveTargets, toOpItem, buildMenuItems, type MenuItemSpec, type OpItem } from '../utils/ops'

export function useMediaContextMenu(opts: {
  items: () => LibraryItem[]
  isSelected: (i: LibraryItem) => boolean
  select: (i: LibraryItem) => void
  currentFolder: () => string
  clipboardEmpty: () => boolean
  onDelete: (items: OpItem[]) => void
  onRename: (item: LibraryItem) => void
  onCut: (items: OpItem[]) => void
  onCopy: (items: OpItem[]) => void
  onPaste: (dest: string) => void
}) {
  const targets = ref<LibraryItem[]>([])
  const targetType = ref<'file' | 'folder' | null>(null)
  const pasteDest = ref('')

  // Returns label *specs* (i18n keys); the component resolves them via useT so this composable stays
  // pure and node-testable (no Nuxt/i18n context required).
  const menuItems = computed<MenuItemSpec[]>(() =>
    buildMenuItems({ targetCount: targets.value.length, targetType: targetType.value, clipboardEmpty: opts.clipboardEmpty() }),
  )

  function onContextMenu(e: MouseEvent) {
    const all = opts.items()
    const target = resolveTargetItem(e.target as Element, all)
    if (!target) {
      targets.value = []
      targetType.value = null
      // blank space: only open a menu (Paste) when the clipboard has something; else suppress
      // both the native menu and an empty Reka menu (capture-phase, synchronous — a reactive
      // :disabled can't, its prop updates after Reka's handler runs).
      if (opts.clipboardEmpty()) { e.preventDefault?.(); e.stopPropagation?.(); return }
      pasteDest.value = opts.currentFolder()
      return
    }
    targets.value = effectiveTargets(target, opts.isSelected, all.filter((i) => opts.isSelected(i)))
    targetType.value = target.type
    pasteDest.value = target.type === 'folder' ? target.folder.path : ''
    if (!opts.isSelected(target)) opts.select(target)
  }

  function onSelect(value: string) {
    const opItems = targets.value.map(toOpItem)
    if (value === 'delete') opts.onDelete(opItems)
    else if (value === 'rename' && targets.value.length === 1) opts.onRename(targets.value[0])
    else if (value === 'cut') opts.onCut(opItems)
    else if (value === 'copy') opts.onCopy(opItems)
    else if (value === 'paste') opts.onPaste(pasteDest.value)
  }

  return { targets, menuItems, onContextMenu, onSelect }
}
