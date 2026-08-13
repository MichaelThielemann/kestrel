import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MediaTable from './MediaTable.vue'
import type { LibraryItem } from '../utils/library'

const items: LibraryItem[] = [
  { type: 'folder', folder: { path: 'pics', name: 'pics', size: 0 } },
  { type: 'file', file: { id: 1, filename: 'a.png', mime: 'image/png', folder: '', size: 1536, width: 800, height: 600, src: '/u/a', srcset: '/u/a-320.webp 320w' } },
]

describe('MediaTable', () => {
  it('renders rows with humanized size and dimensions, navigates on a folder row', async () => {
    const w = await mountSuspended(MediaTable, { props: { items, isSelected: () => false } })
    expect(w.text()).toContain('1.5 KB')
    expect(w.text()).toContain('800×600')
    await w.find('[data-test="row-folder-pics"]').trigger('click')
    expect(w.emitted('navigate')?.at(-1)).toEqual(['pics'])
  })
  it('renders a navigate-only ".." row when parentPath is set, absent at the root', async () => {
    const w = await mountSuspended(MediaTable, { props: { items, isSelected: () => false, parentPath: 'a', upLabel: 'Up' } })
    const up = w.find('[data-test="row-folder-up"]')
    expect(up.exists()).toBe(true)
    expect(up.text()).toContain('..')
    expect(up.attributes('data-drop-folder')).toBeUndefined()
    await up.trigger('click')
    expect(w.emitted('navigate')?.at(-1)).toEqual(['a'])
    const root = await mountSuspended(MediaTable, { props: { items, isSelected: () => false, parentPath: null } })
    expect(root.find('[data-test="row-folder-up"]').exists()).toBe(false)
  })
  it('renders the recursive folder size in the size column', async () => {
    const sized: LibraryItem[] = [{ type: 'folder', folder: { path: 'pics', name: 'pics', size: 2048 } }]
    const w = await mountSuspended(MediaTable, { props: { items: sized, isSelected: () => false } })
    expect(w.text()).toContain('2.0 KB')
  })
  it('emits sort on a column header click and reflects the active sort', async () => {
    const w = await mountSuspended(MediaTable, { props: { items, isSelected: () => false, sort: 'size' } })
    const headers = w.findAll('th')
    expect(headers[2]!.attributes('aria-sort')).toBe('ascending') // Size column
    expect(headers[2]!.text()).toContain('▲')
    const sortBtns = w.findAll('.media-table__sort') // Name, Type, Size (Dimensions is not sortable)
    expect(sortBtns.length).toBe(3)
    await sortBtns[0]!.trigger('click')
    expect(w.emitted('sort')?.at(-1)).toEqual(['name'])
  })
  it('opens the viewer on a file row double-click (folder rows do not)', async () => {
    const w = await mountSuspended(MediaTable, { props: { items, isSelected: () => false } })
    await w.find('[data-test="row-file-1"]').trigger('dblclick')
    expect(w.emitted('open')?.at(-1)?.[0]).toMatchObject({ type: 'file' })
    await w.find('[data-test="row-folder-pics"]').trigger('dblclick')
    expect(w.emitted('open')?.length).toBe(1) // folder double-click is a no-op
  })
  it('Enter opens a file row (keyboard path to the viewer) and navigates a folder row', async () => {
    const w = await mountSuspended(MediaTable, { props: { items, isSelected: () => false } })
    await w.find('[data-test="row-file-1"]').trigger('keydown.enter')
    expect(w.emitted('open')?.at(-1)?.[0]).toMatchObject({ type: 'file' })
    await w.find('[data-test="row-folder-pics"]').trigger('keydown.enter')
    expect(w.emitted('navigate')?.at(-1)).toEqual(['pics'])
  })
  it('Space selects a file row (leaving Enter for open)', async () => {
    const w = await mountSuspended(MediaTable, { props: { items, isSelected: () => false } })
    await w.find('[data-test="row-file-1"]').trigger('keydown.space')
    expect(w.emitted('select')?.at(-1)?.[0]).toMatchObject({ type: 'file' })
    expect(w.emitted('open')).toBeFalsy()
  })
  it('Space SELECTS a folder row (consistent with the grid; does not navigate)', async () => {
    const w = await mountSuspended(MediaTable, { props: { items, isSelected: () => false } })
    await w.find('[data-test="row-folder-pics"]').trigger('keydown.space')
    expect(w.emitted('navigate')).toBeFalsy()
    const ev = w.emitted('select')?.at(-1) as [LibraryItem, { toggle: boolean; range: boolean }]
    expect(ev[0]).toMatchObject({ type: 'folder' })
    expect(ev[1].toggle).toBe(true)
  })
  it('emits select with modifiers on a file row', async () => {
    const w = await mountSuspended(MediaTable, { props: { items, isSelected: () => false } })
    await w.find('[data-test="row-file-1"]').trigger('click', { shiftKey: true })
    const ev = w.emitted('select')?.at(-1) as [LibraryItem, { toggle: boolean; range: boolean }]
    expect(ev[1].range).toBe(true)
  })
  it('selects (not navigates) a folder row on modifier-click', async () => {
    const w = await mountSuspended(MediaTable, { props: { items, isSelected: () => false } })
    await w.find('[data-test="row-folder-pics"]').trigger('click', { ctrlKey: true })
    expect(w.emitted('navigate')).toBeFalsy()
    expect((w.emitted('select')?.at(-1) as [LibraryItem, unknown])[0]).toMatchObject({ type: 'folder' })
  })
  it('marks folders with data-drop-folder and highlights the drop target', async () => {
    const items: LibraryItem[] = [
      { type: 'folder', folder: { path: 'photos', name: 'photos', size: 0 } },
      { type: 'file', file: { id: 1, filename: 'a.png', mime: 'image/png', folder: '', size: 1, src: '/u/a' } },
    ]
    const w = await mountSuspended(MediaTable, { props: { items, isSelected: () => false, dropTargetPath: 'photos' } })
    expect(w.findAll('[data-drop-folder]').length).toBe(1) // folders only
    expect(w.find('[data-drop-folder="photos"]').classes()).toContain('is-drop-target')
  })
  it('marks file rows with data-file-id (folders carry data-drop-folder instead)', async () => {
    const items: LibraryItem[] = [
      { type: 'folder', folder: { path: 'pics', name: 'pics', size: 0 } },
      { type: 'file', file: { id: 7, filename: 'a.png', mime: 'image/png', folder: '', size: 1, src: '/u/a' } },
    ]
    const w = await mountSuspended(MediaTable, { props: { items, isSelected: () => false } })
    expect(w.findAll('[data-file-id]').length).toBe(1)
    expect(w.find('[data-file-id="7"]').exists()).toBe(true)
  })
  it('file rows are draggable and emit dragstart with the item', async () => {
    const items = [{ type: 'file', file: { id: 7, filename: 'a.png', mime: 'image/png', folder: '', size: 1, src: '/u/a' } }]
    const w = await mountSuspended(MediaTable, { props: { items, isSelected: () => false } })
    const row = w.find('[data-file-id="7"]')
    expect(row.attributes('draggable')).toBe('true')
    await row.trigger('dragstart')
    expect(w.emitted('dragstart')).toBeTruthy()
    expect((w.emitted('dragstart')![0][0] as { type: string }).type).toBe('file')
  })
})
