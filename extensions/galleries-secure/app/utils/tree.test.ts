import { describe, it, expect } from 'vitest'
import { buildTree, type DecryptedItem, type GalleryNode } from './tree'

const img = (name: string, dir = ''): DecryptedItem => ({ name, dir, src: `blob:${name}`, mime: 'image/jpeg', blobKey: `k/${name}` })

// Narrowing helpers for the discriminated union (keeps the assertions readable).
const folders = (nodes: GalleryNode[]) => nodes.filter((n): n is Extract<GalleryNode, { type: 'folder' }> => n.type === 'folder')
const images = (nodes: GalleryNode[]) => nodes.filter((n) => n.type === 'image')

describe('buildTree — folder/file tree from decrypted items', () => {
  it('flat gallery (no dirs) → all images at the root', () => {
    const tree = buildTree([img('b.jpg'), img('a.jpg')])
    expect(folders(tree)).toHaveLength(0)
    expect(images(tree).map((n) => n.name)).toEqual(['a.jpg', 'b.jpg']) // alpha-sorted
  })

  it('nests by dir and merges items sharing a folder', () => {
    const tree = buildTree([
      img('2.jpg', 'Trauung'),
      img('1.jpg', 'Trauung'),
      img('top.jpg'),
    ])
    // Folders first, then root images.
    expect(tree[0]).toMatchObject({ type: 'folder', name: 'Trauung', path: 'Trauung' })
    const trauung = folders(tree)[0]!
    expect(images(trauung.children).map((n) => n.name)).toEqual(['1.jpg', '2.jpg'])
    expect(images(tree).map((n) => n.name)).toEqual(['top.jpg'])
  })

  it('creates deep nested folders with correct paths', () => {
    const tree = buildTree([img('x.jpg', '2024/Trauung/Details')])
    const y2024 = folders(tree)[0]!
    expect(y2024).toMatchObject({ name: '2024', path: '2024' })
    const trauung = folders(y2024.children)[0]!
    expect(trauung).toMatchObject({ name: 'Trauung', path: '2024/Trauung' })
    const details = folders(trauung.children)[0]!
    expect(details).toMatchObject({ name: 'Details', path: '2024/Trauung/Details' })
    expect(images(details.children).map((n) => n.name)).toEqual(['x.jpg'])
  })

  it('normalizes messy dir strings (leading/trailing/duplicate slashes)', () => {
    const tree = buildTree([img('a.jpg', '/a//b/')])
    const a = folders(tree)[0]!
    expect(a.path).toBe('a')
    expect(folders(a.children)[0]!.path).toBe('a/b')
  })

  it('folders sort before images at every level', () => {
    const tree = buildTree([img('z-image.jpg'), img('inside.jpg', 'a-folder')])
    expect(tree.map((n) => n.type)).toEqual(['folder', 'image'])
  })

  it('drops the dir from image leaves (carries only render fields)', () => {
    const [leaf] = buildTree([img('a.jpg')])
    expect(leaf).not.toHaveProperty('dir')
    expect(leaf).toMatchObject({ type: 'image', name: 'a.jpg', src: 'blob:a.jpg', mime: 'image/jpeg' })
  })

  it('seeds explicit EMPTY folders (paths with no files) so they still appear', () => {
    const tree = buildTree([img('a.jpg', 'Full')], ['Full', 'Empty', 'Empty/Deep'])
    const top = folders(tree).map((f) => f.path)
    expect(top).toEqual(['Empty', 'Full'])
    const empty = folders(tree).find((f) => f.path === 'Empty')!
    expect(folders(empty.children).map((f) => f.path)).toEqual(['Empty/Deep'])
    expect(images(empty.children)).toHaveLength(0)
  })
})
