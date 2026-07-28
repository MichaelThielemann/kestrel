import { describe, it, expect } from 'vitest'
import { toLibraryItems, fileId } from './library-adapter'
import type { WorkingFile } from './index-codec'

const f = (blobId: string, name: string, dir = ''): WorkingFile => ({ blobId, ivB64: 'iv', name, mime: 'image/jpeg', size: 2048, dir })

describe('library-adapter', () => {
  it('fileId is stable + non-negative', () => {
    expect(fileId('b1')).toBe(fileId('b1'))
    expect(fileId('b1')).toBeGreaterThanOrEqual(0)
    expect(fileId('b1')).not.toBe(fileId('b2'))
  })

  it('partitions immediate child folders (with recursive counts) then files in the current folder', () => {
    const files = [f('b1', 'root.jpg'), f('b2', 'a.jpg', 'Party'), f('b3', 'b.jpg', 'Party/Tag1')]
    const folders = ['Party', 'Party/Tag1', 'Empty']
    const items = toLibraryItems('', files, folders, { b1: { src: 'blob:1' } })

    const folderItems = items.filter((i) => i.type === 'folder')
    expect(folderItems.map((i) => i.type === 'folder' && i.folder.path)).toEqual(['Empty', 'Party'])
    const party = folderItems.find((i) => i.type === 'folder' && i.folder.path === 'Party')
    expect(party && party.type === 'folder' && party.folder.size).toBe(2) // recursive count (b2 + b3)

    const fileItems = items.filter((i) => i.type === 'file')
    expect(fileItems).toHaveLength(1) // only the root file
    expect(fileItems[0].type === 'file' && fileItems[0].file.src).toBe('blob:1')
    expect(fileItems[0].type === 'file' && fileItems[0].file.blobId).toBe('b1')
    expect(fileItems[0].type === 'file' && fileItems[0].file.size).toBe(2048)
  })

  it('shows files directly in a sub-folder, no folders when none nest deeper', () => {
    const files = [f('b2', 'a.jpg', 'Party'), f('b3', 'b.jpg', 'Party/Tag1')]
    const items = toLibraryItems('Party', files, ['Party', 'Party/Tag1'], {})
    expect(items.filter((i) => i.type === 'folder').map((i) => i.type === 'folder' && i.folder.path)).toEqual(['Party/Tag1'])
    expect(items.filter((i) => i.type === 'file').map((i) => i.type === 'file' && i.file.filename)).toEqual(['a.jpg'])
  })
})
