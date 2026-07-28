import { describe, it, expect } from 'vitest'
import { planRelocateInto, planRename } from './relocate-plan'
import type { AffectedMedia, AffectedSet } from './media-ops'

const m = (over: Partial<AffectedMedia>): AffectedMedia => ({
  id: 1, storageKey: '', folder: null, filename: '', size: 0, derivatives: null, ...over,
})

describe('planRelocateInto', () => {
  it('moves a file item into a dest', () => {
    const affected: AffectedSet = {
      media: [m({ id: 7, folder: 'pics', filename: 'a.png', storageKey: 'pics/a.png' })],
      folders: [],
    }
    const plan = planRelocateInto({ type: 'file', id: 7 }, affected, 'archive')
    expect(plan.toRoot).toBe('archive')
    expect(plan.folders).toEqual([])
    expect(plan.media).toEqual([
      { id: 7, fromKey: 'pics/a.png', toFolder: 'archive', toFilename: 'a.png', toKey: 'archive/a.png' },
    ])
  })

  it('moves a folder subtree into a dest, cascading media + folder rows', () => {
    const affected: AffectedSet = {
      media: [
        m({ id: 1, folder: 'pics/sub', filename: 'b.png', storageKey: 'pics/sub/b.png' }),
        m({ id: 2, folder: 'pics/sub/deep', filename: 'c.png', storageKey: 'pics/sub/deep/c.png' }),
      ],
      folders: ['pics/sub/deep', 'pics/sub'],
    }
    const plan = planRelocateInto({ type: 'folder', path: 'pics/sub' }, affected, 'archive')
    expect(plan.toRoot).toBe('archive/sub')
    expect(plan.media.map((p) => p.toKey)).toEqual(['archive/sub/b.png', 'archive/sub/deep/c.png'])
    expect(plan.media.map((p) => p.toFolder)).toEqual(['archive/sub', 'archive/sub/deep'])
    expect(plan.media.map((p) => p.fromKey)).toEqual(['pics/sub/b.png', 'pics/sub/deep/c.png'])
    expect(plan.folders).toEqual([
      { from: 'pics/sub/deep', to: 'archive/sub/deep' },
      { from: 'pics/sub', to: 'archive/sub' },
    ])
  })

  it('moves a folder subtree into root (empty dest)', () => {
    const affected: AffectedSet = {
      media: [
        m({ id: 1, folder: 'pics/sub', filename: 'b.png', storageKey: 'pics/sub/b.png' }),
        m({ id: 2, folder: 'pics/sub/deep', filename: 'c.png', storageKey: 'pics/sub/deep/c.png' }),
      ],
      folders: ['pics/sub/deep', 'pics/sub'],
    }
    const plan = planRelocateInto({ type: 'folder', path: 'pics/sub' }, affected, '')
    expect(plan.toRoot).toBe('sub')
    expect(plan.media.map((p) => p.toKey)).toEqual(['sub/b.png', 'sub/deep/c.png'])
    expect(plan.folders).toEqual([
      { from: 'pics/sub/deep', to: 'sub/deep' },
      { from: 'pics/sub', to: 'sub' },
    ])
  })

  it('carries the existing filename through verbatim, unsanitized', () => {
    const affected: AffectedSet = {
      media: [m({ id: 3, folder: 'pics', filename: 'keep me.png', storageKey: 'pics/keep me.png' })],
      folders: [],
    }
    const plan = planRelocateInto({ type: 'file', id: 3 }, affected, 'archive')
    expect(plan.media[0].toFilename).toBe('keep me.png')
    expect(plan.media[0].toKey).toBe('archive/keep me.png')
  })

  it('treats a null media folder as root', () => {
    const affected: AffectedSet = {
      media: [m({ id: 5, folder: null, filename: 'x.png', storageKey: 'x.png' })],
      folders: [],
    }
    const plan = planRelocateInto({ type: 'file', id: 5 }, affected, 'dest')
    expect(plan.media[0]).toMatchObject({ toFolder: 'dest', toKey: 'dest/x.png' })
  })
})

describe('planRename', () => {
  it('renames a file in place, keeping its folder', () => {
    const affected: AffectedSet = {
      media: [m({ id: 9, folder: 'pics', filename: 'old.png', storageKey: 'pics/old.png' })],
      folders: [],
    }
    const plan = planRename({ type: 'file', id: 9 }, affected, 'new name.png')
    expect(plan.toRoot).toBe('pics')
    expect(plan.folders).toEqual([])
    expect(plan.media).toEqual([
      { id: 9, fromKey: 'pics/old.png', toFolder: 'pics', toFilename: 'new_name.png', toKey: 'pics/new_name.png' },
    ])
  })

  it('keeps the original file extension on rename (cannot rename to an active extension)', () => {
    const affected: AffectedSet = {
      media: [m({ id: 9, folder: 'pics', filename: 'photo.png', storageKey: 'pics/photo.png' })],
      folders: [],
    }
    const plan = planRename({ type: 'file', id: 9 }, affected, 'evil.html')
    expect(plan.media[0].toFilename).toBe('evil.png')
    expect(plan.media[0].toKey).toBe('pics/evil.png')
  })

  it('renames a file at the root (null folder)', () => {
    const affected: AffectedSet = {
      media: [m({ id: 9, folder: null, filename: 'old.png', storageKey: 'old.png' })],
      folders: [],
    }
    const plan = planRename({ type: 'file', id: 9 }, affected, 'fresh.png')
    expect(plan.toRoot).toBe('')
    expect(plan.media[0]).toMatchObject({ toFolder: '', toKey: 'fresh.png' })
  })

  it('renames a nested folder, cascading its subtree', () => {
    const affected: AffectedSet = {
      media: [
        m({ id: 1, folder: 'pics/sub', filename: 'b.png', storageKey: 'pics/sub/b.png' }),
        m({ id: 2, folder: 'pics/sub/deep', filename: 'c.png', storageKey: 'pics/sub/deep/c.png' }),
      ],
      folders: ['pics/sub/deep', 'pics/sub'],
    }
    const plan = planRename({ type: 'folder', path: 'pics/sub' }, affected, 'gallery')
    expect(plan.toRoot).toBe('pics/gallery')
    expect(plan.media.map((p) => p.toKey)).toEqual(['pics/gallery/b.png', 'pics/gallery/deep/c.png'])
    expect(plan.folders).toEqual([
      { from: 'pics/sub/deep', to: 'pics/gallery/deep' },
      { from: 'pics/sub', to: 'pics/gallery' },
    ])
  })

  it('renames a top-level folder', () => {
    const affected: AffectedSet = {
      media: [m({ id: 1, folder: 'pics', filename: 'b.png', storageKey: 'pics/b.png' })],
      folders: ['pics'],
    }
    const plan = planRename({ type: 'folder', path: 'pics' }, affected, 'photos')
    expect(plan.toRoot).toBe('photos')
    expect(plan.media[0].toKey).toBe('photos/b.png')
    expect(plan.folders).toEqual([{ from: 'pics', to: 'photos' }])
  })

  it('collapses a name containing a separator to its last clean segment', () => {
    const affected: AffectedSet = {
      media: [m({ id: 1, folder: 'pics', filename: 'b.png', storageKey: 'pics/b.png' })],
      folders: ['pics'],
    }
    const plan = planRename({ type: 'folder', path: 'pics' }, affected, 'a/b')
    expect(plan.toRoot).toBe('b')
  })

  it('throws 400 when the segment sanitizes to empty', () => {
    const affected: AffectedSet = {
      media: [m({ id: 1, folder: 'pics', filename: 'b.png', storageKey: 'pics/b.png' })],
      folders: ['pics'],
    }
    for (const bad of ['..', '', '.', '/']) {
      expect(() => planRename({ type: 'folder', path: 'pics' }, affected, bad))
        .toThrowError(expect.objectContaining({ statusCode: 400 }))
    }
  })

  it('only rewrites folder paths present in the affected set (unrelated siblings untouched)', () => {
    const affected: AffectedSet = {
      media: [m({ id: 1, folder: 'pics/sub', filename: 'b.png', storageKey: 'pics/sub/b.png' })],
      folders: ['pics/sub'],
    }
    const plan = planRename({ type: 'folder', path: 'pics/sub' }, affected, 'gallery')
    expect(plan.folders.map((f) => f.from)).toEqual(['pics/sub'])
    expect(plan.folders.some((f) => f.from === 'pics/sub-archive')).toBe(false)
  })
})
