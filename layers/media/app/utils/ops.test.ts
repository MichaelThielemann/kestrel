import { describe, it, expect } from 'vitest'
import { toOpItem, resolveTargetItem, effectiveTargets, buildMenuItems } from './ops'
import type { LibraryItem } from './library'

const file = (id: number): LibraryItem => ({ type: 'file', file: { id, filename: `f${id}.png`, mime: 'image/png', folder: '', size: 1, src: `/u/${id}` } })
const folder = (path: string): LibraryItem => ({ type: 'folder', folder: { path, name: path.split('/').pop()!, size: 0 } })

describe('toOpItem', () => {
  it('maps file → {type:file,id} and folder → {type:folder,path}', () => {
    expect(toOpItem(file(5))).toEqual({ type: 'file', id: 5 })
    expect(toOpItem(folder('pics/holiday'))).toEqual({ type: 'folder', path: 'pics/holiday' })
  })
})

describe('resolveTargetItem', () => {
  const items = [file(5), folder('pics')]
  const fakeEl = (attr: 'data-file-id' | 'data-drop-folder', val: string) =>
    ({ closest: (sel: string) => (sel === `[${attr}]` ? { getAttribute: () => val } : null) }) as unknown as Element
  it('resolves a file element to its item', () => {
    expect(resolveTargetItem(fakeEl('data-file-id', '5'), items)).toBe(items[0])
  })
  it('resolves a folder element to its item', () => {
    expect(resolveTargetItem(fakeEl('data-drop-folder', 'pics'), items)).toBe(items[1])
  })
  it('returns null when the element matches no item', () => {
    expect(resolveTargetItem({ closest: () => null } as unknown as Element, items)).toBeNull()
    expect(resolveTargetItem(null, items)).toBeNull()
  })
})

describe('effectiveTargets', () => {
  const items = [file(1), file(2), file(3)]
  const isSel = (set: Set<number>) => (i: LibraryItem) => i.type === 'file' && set.has(i.file.id)
  it('returns the whole selection when the clicked item is selected', () => {
    const selected = [items[0], items[1]]
    expect(effectiveTargets(items[0], isSel(new Set([1, 2])), selected)).toBe(selected)
  })
  it('returns just the clicked item when it is not selected', () => {
    expect(effectiveTargets(items[2], isSel(new Set([1, 2])), [items[0], items[1]])).toEqual([items[2]])
  })
})

describe('buildMenuItems', () => {
  it('blank space: empty clipboard → no menu; non-empty → Paste', () => {
    expect(buildMenuItems({ targetCount: 0, targetType: null, clipboardEmpty: true })).toEqual([])
    expect(buildMenuItems({ targetCount: 0, targetType: null, clipboardEmpty: false })).toEqual([{ labelKey: 'media.menu.paste', value: 'paste' }])
  })
  it('single file: Cut/Copy/Rename/Delete (never paste)', () => {
    expect(buildMenuItems({ targetCount: 1, targetType: 'file', clipboardEmpty: false })).toEqual([
      { labelKey: 'media.menu.cut', value: 'cut' },
      { labelKey: 'media.menu.copy', value: 'copy' },
      { labelKey: 'media.menu.rename', value: 'rename' },
      { labelKey: 'media.menu.delete', value: 'delete', danger: true },
    ])
  })
  it('single folder with a non-empty clipboard appends Paste into folder', () => {
    const items = buildMenuItems({ targetCount: 1, targetType: 'folder', clipboardEmpty: false })
    expect(items.at(-1)).toEqual({ labelKey: 'media.menu.pasteInto', value: 'paste' })
  })
  it('single folder with an empty clipboard has no paste', () => {
    expect(buildMenuItems({ targetCount: 1, targetType: 'folder', clipboardEmpty: true }).some((i) => i.value === 'paste')).toBe(false)
  })
  it('multi-select: Cut/Copy/Delete N (no rename, no paste; N carried for plural resolution)', () => {
    expect(buildMenuItems({ targetCount: 3, targetType: 'file', clipboardEmpty: true })).toEqual([
      { labelKey: 'media.menu.cut', value: 'cut' },
      { labelKey: 'media.menu.copy', value: 'copy' },
      { labelKey: 'media.menu.deleteN', count: 3, value: 'delete', danger: true },
    ])
  })
})
