import { describe, it, expect, vi } from 'vitest'
import { useMediaDnd } from './useMediaDnd'
import type { OpItem } from '../utils/ops'

function dragEvent(opts: { types?: string[]; folder?: string | null; files?: File[] } = {}) {
  const el = opts.folder != null ? { getAttribute: () => opts.folder } : null
  return {
    preventDefault: vi.fn(),
    target: { closest: (_s: string) => el },
    dataTransfer: { types: opts.types ?? [], files: opts.files ?? [], items: [], dropEffect: '' },
  } as unknown as DragEvent
}
const FILES = ['Files']
const MEDIA = ['application/x-kestrel-media']
const base = (over: Partial<Parameters<typeof useMediaDnd>[0]> = {}) =>
  useMediaDnd({ currentFolder: () => 'cur', onDrop: vi.fn(), draggedItems: () => [], onMove: vi.fn(), ...over })

describe('useMediaDnd', () => {
  it('shows the upload overlay only for file drags, not internal drags', () => {
    const a = base()
    a.onDragEnter(dragEvent({ types: MEDIA }))
    expect(a.dragActive.value).toBe(false) // internal drag → no overlay
    const b = base()
    b.onDragEnter(dragEvent({ types: FILES }))
    expect(b.dragActive.value).toBe(true)
    b.onDragLeave(dragEvent({ types: FILES }))
    expect(b.dragActive.value).toBe(false)
  })
  it('treats a drag carrying BOTH Files and the internal marker as internal (no upload overlay)', () => {
    // Some platforms add 'Files' to dataTransfer.types on an internal item-drag; the marker still wins.
    const a = base()
    a.onDragEnter(dragEvent({ types: ['Files', 'application/x-kestrel-media'] }))
    expect(a.dragActive.value).toBe(false)
  })
  it('sets dropEffect move for internal drags, copy for file drags, and tracks the hovered folder', () => {
    const dnd = base()
    const over = dragEvent({ types: MEDIA, folder: 'photos' })
    dnd.onDragOver(over)
    expect((over.dataTransfer as DataTransfer).dropEffect).toBe('move')
    expect(dnd.dropFolder.value).toBe('photos')
    const overF = dragEvent({ types: FILES, folder: 'photos' })
    dnd.onDragOver(overF)
    expect((overF.dataTransfer as DataTransfer).dropEffect).toBe('copy')
  })
  it('internal drop on a folder tile moves the dragged items into it', async () => {
    const onMove = vi.fn()
    const dragged: OpItem[] = [{ type: 'file', id: 1 }]
    const dnd = base({ draggedItems: () => dragged, onMove })
    await dnd.onDrop(dragEvent({ types: MEDIA, folder: 'photos' }))
    expect(onMove).toHaveBeenCalledWith(dragged, 'photos')
  })
  it('internal drop on blank space (no folder) does not move', async () => {
    const onMove = vi.fn()
    const dnd = base({ draggedItems: () => [{ type: 'file', id: 1 }], onMove })
    await dnd.onDrop(dragEvent({ types: MEDIA, folder: null }))
    expect(onMove).not.toHaveBeenCalled()
  })
  it('internal drop onto a dragged folder itself does not move', async () => {
    const onMove = vi.fn()
    const dnd = base({ draggedItems: () => [{ type: 'folder', path: 'photos' }], onMove })
    await dnd.onDrop(dragEvent({ types: MEDIA, folder: 'photos' }))
    expect(onMove).not.toHaveBeenCalled()
  })
  it('file drop routes to the upload onDrop path', async () => {
    const onDrop = vi.fn()
    const onMove = vi.fn()
    const dnd = base({ onDrop, onMove })
    await dnd.onDrop(dragEvent({ types: FILES, folder: 'photos', files: [new File([new Uint8Array([1])], 'a.png')] }))
    expect(onMove).not.toHaveBeenCalled()
    expect(onDrop).toHaveBeenCalled()
    expect(onDrop.mock.calls[0][0]).toHaveProperty('uploads')
  })
})
