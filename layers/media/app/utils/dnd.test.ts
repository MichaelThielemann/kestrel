import { describe, it, expect } from 'vitest'
import { readAllEntries, walkEntry, extractUploads, selectEmptyFolders, type EntryLike, type WalkResult } from './dnd'

const fileEntry = (name: string): EntryLike => ({
  isFile: true, isDirectory: false, name,
  file: (ok) => ok(new File([new Uint8Array([1])], name, { type: 'image/png' })),
})
const dirEntry = (name: string, children: EntryLike[]): EntryLike => ({
  isFile: false, isDirectory: true, name,
  createReader: () => { let served = false; return { readEntries: (ok) => { if (served) return ok([]); served = true; ok(children) } } },
})

describe('readAllEntries', () => {
  it('loops until an empty batch terminates', async () => {
    const batches: EntryLike[][] = [[fileEntry('1')], [fileEntry('2')], []]
    let i = 0
    const all = await readAllEntries({ readEntries: (ok) => ok(batches[i++]) })
    expect(all.map((e) => e.name)).toEqual(['1', '2'])
  })
})

describe('walkEntry', () => {
  it('walks a nested tree into uploads + dirs', async () => {
    const tree = dirEntry('photos', [fileEntry('a.png'), dirEntry('sub', [fileEntry('b.png')]), dirEntry('empty', [])])
    const out: WalkResult = { uploads: [], dirs: [] }
    await walkEntry(tree, 'base', out)
    expect(out.uploads.map((u) => [u.file.name, u.folder])).toEqual([
      ['a.png', 'base/photos'],
      ['b.png', 'base/photos/sub'],
    ])
    expect(out.dirs).toEqual(['base/photos', 'base/photos/sub', 'base/photos/empty'])
  })
})

describe('extractUploads', () => {
  it('uses webkitGetAsEntry when items expose entries', async () => {
    const dt = { items: [{ webkitGetAsEntry: () => fileEntry('a.png') }] }
    const out = await extractUploads(dt, 'pics')
    expect(out.uploads.map((u) => [u.file.name, u.folder])).toEqual([['a.png', 'pics']])
  })
  it('falls back to a flat file list when no entries', async () => {
    const f = new File([], 'b.png')
    const out = await extractUploads({ items: [], files: [f] }, 'pics')
    expect(out.uploads).toEqual([{ file: f, folder: 'pics' }])
  })
})

describe('selectEmptyFolders', () => {
  it('keeps only dirs no uploaded file covers, reduced to the deepest', () => {
    const uploads = [{ file: new File([], 'x'), folder: 'a/b' }]
    const dirs = ['a', 'a/b', 'a/empty', 'a/empty/deep']
    expect(selectEmptyFolders(uploads, dirs)).toEqual(['a/empty/deep'])
  })
  it('returns [] when every dir holds files', () => {
    expect(selectEmptyFolders([{ file: new File([], 'x'), folder: 'a/b' }], ['a', 'a/b'])).toEqual([])
  })
  it('keeps a dropped empty folder with no files', () => {
    expect(selectEmptyFolders([], ['photos'])).toEqual(['photos'])
  })
  it('treats sibling-prefixed folders as distinct (pics vs pics-archive)', () => {
    expect(selectEmptyFolders([], ['pics', 'pics-archive']).sort()).toEqual(['pics', 'pics-archive'])
  })
})
