import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MediaGrid from './MediaGrid.vue'
import type { LibraryItem } from '../utils/library'

const items: LibraryItem[] = [
  { type: 'folder', folder: { path: 'pics', name: 'pics', size: 0 } },
  { type: 'file', file: { id: 1, filename: 'a.png', mime: 'image/png', folder: '', size: 1, src: '/u/a', srcset: '/u/a-320.webp 320w' } },
  { type: 'file', file: { id: 2, filename: 'doc.pdf', mime: 'application/pdf', folder: '', size: 1, src: '/u/doc' } },
]

describe('MediaGrid', () => {
  it('navigates on a folder tile click', async () => {
    const w = await mountSuspended(MediaGrid, { props: { items, isSelected: () => false } })
    await w.find('[data-test="folder-pics"]').trigger('click')
    expect(w.emitted('navigate')?.at(-1)).toEqual(['pics'])
  })
  it('renders a navigate-only ".." tile when parentPath is set (not draggable, not a drop target)', async () => {
    const w = await mountSuspended(MediaGrid, { props: { items, isSelected: () => false, parentPath: 'a', upLabel: 'Up' } })
    const up = w.find('[data-test="folder-up"]')
    expect(up.exists()).toBe(true)
    expect(up.text()).toContain('..')
    expect(up.attributes('draggable')).toBeUndefined()
    expect(up.attributes('data-drop-folder')).toBeUndefined()
    await up.trigger('click')
    expect(w.emitted('navigate')?.at(-1)).toEqual(['a'])
  })
  it('renders no ".." tile at the root (parentPath null), and an empty-string parent still renders', async () => {
    const root = await mountSuspended(MediaGrid, { props: { items, isSelected: () => false, parentPath: null } })
    expect(root.find('[data-test="folder-up"]').exists()).toBe(false)
    const sub = await mountSuspended(MediaGrid, { props: { items, isSelected: () => false, parentPath: '' } })
    await sub.find('[data-test="folder-up"]').trigger('click')
    expect(sub.emitted('navigate')?.at(-1)).toEqual([''])
  })
  it('renders an <img srcset> for images and an ext badge for non-images', async () => {
    const w = await mountSuspended(MediaGrid, { props: { items, isSelected: () => false } })
    const img = w.find('img')
    expect(img.attributes('srcset')).toContain('320w')
    expect(img.attributes('alt')).toBeDefined()
    expect(w.text()).toContain('PDF')
  })
  it('shows a dimensions · size meta on file tiles, and the recursive size on folder tiles', async () => {
    const meta: LibraryItem[] = [
      { type: 'folder', folder: { path: 'pics', name: 'pics', size: 2048 } },
      { type: 'file', file: { id: 9, filename: 'p.png', mime: 'image/png', folder: '', size: 1536, width: 800, height: 600, src: '/u/p', srcset: '/u/p-320.webp 320w' } },
    ]
    const w = await mountSuspended(MediaGrid, { props: { items: meta, isSelected: () => false } })
    const captions = w.findAll('.media-grid__meta').map((m) => m.text())
    expect(captions).toContain('2.0 KB')
    expect(captions).toContain('800×600 · 1.5 KB')
  })
  it('opens the viewer on a file double-click', async () => {
    const w = await mountSuspended(MediaGrid, { props: { items, isSelected: () => false } })
    await w.find('[data-test="file-1"]').trigger('dblclick')
    expect(w.emitted('open')?.at(-1)?.[0]).toMatchObject({ type: 'file' })
  })
  it('opens the viewer on Enter — a keyboard path to the alt-text editor (no mouse needed)', async () => {
    const w = await mountSuspended(MediaGrid, { props: { items, isSelected: () => false } })
    await w.find('[data-test="file-1"]').trigger('keydown.enter')
    expect(w.emitted('open')?.at(-1)?.[0]).toMatchObject({ type: 'file' })
  })
  it('selects a folder on Space (keyboard toggle), leaving Enter/click for navigation', async () => {
    const w = await mountSuspended(MediaGrid, { props: { items, isSelected: () => false } })
    await w.find('[data-test="folder-pics"]').trigger('keydown.space')
    expect(w.emitted('navigate')).toBeFalsy()
    const ev = w.emitted('select')?.at(-1) as [LibraryItem, { toggle: boolean; range: boolean }]
    expect(ev[0]).toMatchObject({ type: 'folder' })
    expect(ev[1].toggle).toBe(true)
  })
  it('conveys selection via aria-pressed (valid on a button; aria-selected is not)', async () => {
    const sel = await mountSuspended(MediaGrid, { props: { items, isSelected: (i: LibraryItem) => i.type === 'file' && i.file.id === 1 } })
    expect(sel.find('[data-file-id="1"]').attributes('aria-pressed')).toBe('true')
    expect(sel.find('[data-file-id="2"]').attributes('aria-pressed')).toBe('false')
    expect(sel.find('[data-file-id="1"]').attributes('aria-selected')).toBeUndefined()
  })
  it('emits select with modifier flags on a file click', async () => {
    const w = await mountSuspended(MediaGrid, { props: { items, isSelected: () => false } })
    await w.find('[data-test="file-1"]').trigger('click', { ctrlKey: true })
    const ev = w.emitted('select')?.at(-1) as [LibraryItem, { toggle: boolean; range: boolean }]
    expect(ev[0]).toMatchObject({ type: 'file' })
    expect(ev[1].toggle).toBe(true)
  })
  it('selects (not navigates) a folder on modifier-click', async () => {
    const w = await mountSuspended(MediaGrid, { props: { items, isSelected: () => false } })
    await w.find('[data-test="folder-pics"]').trigger('click', { ctrlKey: true })
    expect(w.emitted('navigate')).toBeFalsy()
    const ev = w.emitted('select')?.at(-1) as [LibraryItem, { toggle: boolean; range: boolean }]
    expect(ev[0]).toMatchObject({ type: 'folder' })
    expect(ev[1].toggle).toBe(true)
  })
  it('marks folders with data-drop-folder and highlights the drop target', async () => {
    const items: LibraryItem[] = [
      { type: 'folder', folder: { path: 'photos', name: 'photos', size: 0 } },
      { type: 'file', file: { id: 1, filename: 'a.png', mime: 'image/png', folder: '', size: 1, src: '/u/a' } },
    ]
    const w = await mountSuspended(MediaGrid, { props: { items, isSelected: () => false, dropTargetPath: 'photos' } })
    expect(w.findAll('[data-drop-folder]').length).toBe(1) // folders only
    expect(w.find('[data-drop-folder="photos"]').classes()).toContain('is-drop-target')
  })
  it('marks file tiles with data-file-id (folders carry data-drop-folder instead)', async () => {
    const items: LibraryItem[] = [
      { type: 'folder', folder: { path: 'pics', name: 'pics', size: 0 } },
      { type: 'file', file: { id: 7, filename: 'a.png', mime: 'image/png', folder: '', size: 1, src: '/u/a' } },
    ]
    const w = await mountSuspended(MediaGrid, { props: { items, isSelected: () => false } })
    expect(w.findAll('[data-file-id]').length).toBe(1)
    expect(w.find('[data-file-id="7"]').exists()).toBe(true)
  })
  it('tiles are draggable and emit dragstart with the item', async () => {
    const items = [{ type: 'file', file: { id: 7, filename: 'a.png', mime: 'image/png', folder: '', size: 1, src: '/u/a' } }]
    const w = await mountSuspended(MediaGrid, { props: { items, isSelected: () => false } })
    const tile = w.find('[data-file-id="7"]')
    expect(tile.attributes('draggable')).toBe('true')
    await tile.trigger('dragstart')
    expect(w.emitted('dragstart')).toBeTruthy()
    expect((w.emitted('dragstart')![0][0] as { type: string }).type).toBe('file')
  })
})
