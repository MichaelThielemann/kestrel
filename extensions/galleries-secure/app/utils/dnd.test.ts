import { describe, it, expect } from 'vitest'
import { extractUploads, type EntryLike } from './dnd'

const fileEntry = (name: string): EntryLike => ({
  isFile: true, isDirectory: false, name,
  file: (ok) => ok(new File(['x'], name)),
})
const dirEntry = (name: string, children: EntryLike[]): EntryLike => ({
  isFile: false, isDirectory: true, name,
  createReader: () => { let done = false; return { readEntries: (ok) => { if (done) return ok([]); done = true; ok(children) } } },
})
const dt = (opts: { files?: File[]; entries?: EntryLike[] }) => ({
  files: opts.files,
  items: opts.entries?.map((e) => ({ webkitGetAsEntry: () => e })),
})

describe('extractUploads — drag-drop intake', () => {
  it('plain files (no entry API) land at the base folder', async () => {
    const r = await extractUploads(dt({ files: [new File(['x'], 'a.jpg'), new File(['x'], 'b.jpg')] }), '')
    expect(r.uploads.map((u) => [u.file.name, u.folder])).toEqual([['a.jpg', ''], ['b.jpg', '']])
  })

  it('walks dropped folders into per-file folder paths', async () => {
    const tree = [dirEntry('Trauung', [fileEntry('1.jpg'), dirEntry('Details', [fileEntry('ring.jpg')])]), fileEntry('cover.jpg')]
    const r = await extractUploads(dt({ entries: tree }), '')
    expect(r.uploads.map((u) => [u.file.name, u.folder]).sort()).toEqual(
      [['1.jpg', 'Trauung'], ['cover.jpg', ''], ['ring.jpg', 'Trauung/Details']].sort(),
    )
    expect(r.dirs).toContain('Trauung')
    expect(r.dirs).toContain('Trauung/Details')
  })

  it('prefixes everything with the base folder', async () => {
    const r = await extractUploads(dt({ entries: [dirEntry('day1', [fileEntry('x.jpg')])] }), 'event')
    expect(r.uploads[0]!.folder).toBe('event/day1')
  })
})
