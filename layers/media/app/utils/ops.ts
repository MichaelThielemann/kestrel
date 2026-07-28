import type { LibraryItem } from './library'
import type { OpItem, DeleteReport } from '../../server/utils/media-ops'
import type { Conflict, RelocationReport } from '../../server/utils/relocate-ops'
import type { MediaUsage } from '../../server/utils/usages'

// Single-source the HTTP wire shapes from the server utils that own them — one definition, no drift.
export type { OpItem, DeleteReport, Conflict, RelocationReport, MediaUsage }

/** Structural shape of a UiMenu entry (UiMenu declares its own copy; kept in sync structurally). */
export interface MenuItem { label: string; value: string; danger?: boolean; disabled?: boolean }

/** A menu entry before its label is localized: carries an i18n key (+ a `count` for plural-bearing
 *  entries) so the pure builder stays free of presentation copy; the composable resolves it via useT. */
export interface MenuItemSpec { labelKey: string; count?: number; value: string; danger?: boolean }

export function toOpItem(item: LibraryItem): OpItem {
  return item.type === 'folder' ? { type: 'folder', path: item.folder.path } : { type: 'file', id: item.file.id }
}

/** Map a right-clicked element to its LibraryItem via the data-id attributes
 *  (files carry data-file-id, folders carry data-drop-folder). Null if neither matches. */
export function resolveTargetItem(el: Element | null, items: LibraryItem[]): LibraryItem | null {
  const fileEl = el?.closest('[data-file-id]')
  if (fileEl) {
    const id = Number(fileEl.getAttribute('data-file-id'))
    return items.find((i) => i.type === 'file' && i.file.id === id) ?? null
  }
  const folderEl = el?.closest('[data-drop-folder]')
  if (folderEl) {
    const path = folderEl.getAttribute('data-drop-folder')
    return items.find((i) => i.type === 'folder' && i.folder.path === path) ?? null
  }
  return null
}

/** Explorer semantics: right-clicking a selected item targets the whole selection;
 *  right-clicking elsewhere targets just that item. */
export function effectiveTargets(clicked: LibraryItem, isSelected: (i: LibraryItem) => boolean, selected: LibraryItem[]): LibraryItem[] {
  return isSelected(clicked) ? selected : [clicked]
}

/** Build the context-menu items for the current target + clipboard state. Blank space with an
 *  empty clipboard returns [] (the caller suppresses the menu). */
export function buildMenuItems(ctx: { targetCount: number; targetType: 'file' | 'folder' | null; clipboardEmpty: boolean }): MenuItemSpec[] {
  const { targetCount, targetType, clipboardEmpty } = ctx
  if (targetCount === 0) return clipboardEmpty ? [] : [{ labelKey: 'media.menu.paste', value: 'paste' }]
  if (targetCount === 1) {
    const items: MenuItemSpec[] = [
      { labelKey: 'media.menu.cut', value: 'cut' },
      { labelKey: 'media.menu.copy', value: 'copy' },
      { labelKey: 'media.menu.rename', value: 'rename' },
      { labelKey: 'media.menu.delete', value: 'delete', danger: true },
    ]
    if (targetType === 'folder' && !clipboardEmpty) items.push({ labelKey: 'media.menu.pasteInto', value: 'paste' })
    return items
  }
  return [
    { labelKey: 'media.menu.cut', value: 'cut' },
    { labelKey: 'media.menu.copy', value: 'copy' },
    { labelKey: 'media.menu.deleteN', count: targetCount, value: 'delete', danger: true },
  ]
}
