import { describe, it, expect, vi } from 'vitest'
import { useMediaContextMenu } from './useMediaContextMenu'
import type { LibraryItem } from '../utils/library'

const file = (id: number): LibraryItem => ({ type: 'file', file: { id, filename: `f${id}.png`, mime: 'image/png', folder: '', size: 1, src: `/u/${id}` } })
const ctxEvent = (fileId: string | null) => ({
  target: { closest: (sel: string) => (sel === '[data-file-id]' && fileId !== null ? { getAttribute: () => fileId } : null) },
}) as unknown as MouseEvent

describe('useMediaContextMenu', () => {
  it('targets the clicked unselected file (and selects it) and offers Cut/Copy/Rename/Delete', () => {
    const items = [file(5)]
    const select = vi.fn()
    const cm = useMediaContextMenu({ items: () => items, isSelected: () => false, select, currentFolder: () => 'cur', clipboardEmpty: () => true, onDelete: vi.fn(), onRename: vi.fn(), onCut: vi.fn(), onCopy: vi.fn(), onPaste: vi.fn() })
    cm.onContextMenu(ctxEvent('5'))
    expect(cm.targets.value).toEqual([items[0]])
    expect(select).toHaveBeenCalledWith(items[0])
    expect(cm.menuItems.value).toEqual([
      { labelKey: 'media.menu.cut', value: 'cut' },
      { labelKey: 'media.menu.copy', value: 'copy' },
      { labelKey: 'media.menu.rename', value: 'rename' },
      { labelKey: 'media.menu.delete', value: 'delete', danger: true },
    ])
  })
  it('targets the whole selection (Cut/Copy/Delete N, no Rename) when the clicked item is already selected', () => {
    const items = [file(1), file(2)]
    const cm = useMediaContextMenu({ items: () => items, isSelected: () => true, select: vi.fn(), currentFolder: () => 'cur', clipboardEmpty: () => true, onDelete: vi.fn(), onRename: vi.fn(), onCut: vi.fn(), onCopy: vi.fn(), onPaste: vi.fn() })
    cm.onContextMenu(ctxEvent('1'))
    expect(cm.targets.value).toEqual(items)
    expect(cm.menuItems.value).toEqual([
      { labelKey: 'media.menu.cut', value: 'cut' },
      { labelKey: 'media.menu.copy', value: 'copy' },
      { labelKey: 'media.menu.deleteN', count: 2, value: 'delete', danger: true },
    ])
  })
  it('clears targets, shows no items, and suppresses both menus when nothing is hit (empty clipboard)', () => {
    const cm = useMediaContextMenu({ items: () => [file(1)], isSelected: () => false, select: vi.fn(), currentFolder: () => 'cur', clipboardEmpty: () => true, onDelete: vi.fn(), onRename: vi.fn(), onCut: vi.fn(), onCopy: vi.fn(), onPaste: vi.fn() })
    const e = { target: { closest: () => null }, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent
    cm.onContextMenu(e)
    expect(cm.targets.value).toEqual([])
    expect(cm.menuItems.value).toEqual([])
    expect(e.preventDefault).toHaveBeenCalled()
    expect(e.stopPropagation).toHaveBeenCalled()
  })
  it('onSelect("delete") calls onDelete with op items', () => {
    const onDelete = vi.fn()
    const items = [file(5)]
    const cm = useMediaContextMenu({ items: () => items, isSelected: () => true, select: vi.fn(), currentFolder: () => 'cur', clipboardEmpty: () => true, onDelete, onRename: vi.fn(), onCut: vi.fn(), onCopy: vi.fn(), onPaste: vi.fn() })
    cm.onContextMenu(ctxEvent('5'))
    cm.onSelect('delete')
    expect(onDelete).toHaveBeenCalledWith([{ type: 'file', id: 5 }])
  })
  it('onSelect("rename") calls onRename with the single target', () => {
    const onRename = vi.fn()
    const items = [file(5)]
    const cm = useMediaContextMenu({ items: () => items, isSelected: () => false, select: vi.fn(), currentFolder: () => 'cur', clipboardEmpty: () => true, onDelete: vi.fn(), onRename, onCut: vi.fn(), onCopy: vi.fn(), onPaste: vi.fn() })
    cm.onContextMenu(ctxEvent('5'))
    cm.onSelect('rename')
    expect(onRename).toHaveBeenCalledWith(items[0])
  })
  it('blank space with a non-empty clipboard offers Paste into the current folder', () => {
    const onPaste = vi.fn()
    const cm = useMediaContextMenu({ items: () => [file(1)], isSelected: () => false, select: vi.fn(), currentFolder: () => 'cur', clipboardEmpty: () => false, onDelete: vi.fn(), onRename: vi.fn(), onCut: vi.fn(), onCopy: vi.fn(), onPaste })
    const e = { target: { closest: () => null }, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent
    cm.onContextMenu(e)
    expect(e.preventDefault).not.toHaveBeenCalled() // menu opens
    expect(cm.menuItems.value).toEqual([{ labelKey: 'media.menu.paste', value: 'paste' }])
    cm.onSelect('paste')
    expect(onPaste).toHaveBeenCalledWith('cur')
  })
  it('onSelect cut/copy passes op items; paste on a folder targets that folder path', () => {
    const onCut = vi.fn(); const onCopy = vi.fn(); const onPaste = vi.fn()
    const folderItem: LibraryItem = { type: 'folder', folder: { path: 'pics', name: 'pics', size: 0 } }
    const cm = useMediaContextMenu({ items: () => [folderItem], isSelected: () => false, select: vi.fn(), currentFolder: () => 'cur', clipboardEmpty: () => false, onDelete: vi.fn(), onRename: vi.fn(), onCut, onCopy, onPaste })
    const folderEvent = { target: { closest: (s: string) => (s === '[data-drop-folder]' ? { getAttribute: () => 'pics' } : null) } } as unknown as MouseEvent
    cm.onContextMenu(folderEvent)
    cm.onSelect('cut'); expect(onCut).toHaveBeenCalledWith([{ type: 'folder', path: 'pics' }])
    cm.onSelect('copy'); expect(onCopy).toHaveBeenCalledWith([{ type: 'folder', path: 'pics' }])
    cm.onSelect('paste'); expect(onPaste).toHaveBeenCalledWith('pics')
  })
})
