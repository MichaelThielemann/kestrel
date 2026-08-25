import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { previewRelocation, executeRelocation, coerceOpItems, type MediaOp } from '../../../src/server/utils/relocate-ops.js'
import { ensureFolder } from '../../../src/server/utils/folders.js'
import { create, ensureRevisionsTable, sqliteClientOf, createLocalDriver  } from '@kestrel/core'
import media from '../../../src/server/collections/media.js'
import { createTestDb } from '../../../../../test/helpers/db.js'
import type { MediaDb } from '../../../src/server/db/media-db.js'

function asMediaDb(db: ReturnType<typeof createTestDb>): MediaDb {
  return db as unknown as MediaDb
}

let db: ReturnType<typeof createTestDb>
const seed = (storageKey: string, folder: string, filename: string) =>
  create(db, media, { storageKey, folder, filename, mime: 'image/png', ext: 'png', size: 1 }) as { id: number }
const idOf = (storageKey: string) => (db.all(sql`select id from media where storage_key = ${storageKey}`) as { id: number }[])[0].id

beforeEach(() => {
  db = createTestDb()
  ensureRevisionsTable(sqliteClientOf(db), 'media')
  // db is reassigned per-test (including in the nested executeRelocation describe below); this stub reads
  // the module-level `db` variable live, so it always resolves the connection the test is currently using.
  Object.assign(globalThis, { useDb: () => db })
  ensureFolder(asMediaDb(db), 'pics/sub')
  ensureFolder(asMediaDb(db), 'pics-archive') // sibling-prefix — must NOT be swept by 'pics'
  seed('pics/a.png', 'pics', 'a.png')
  seed('pics/sub/b.png', 'pics/sub', 'b.png')
  seed('pics-archive/c.png', 'pics-archive', 'c.png')
  seed('other/d.png', 'other', 'd.png')
})
afterEach(() => {
  delete (globalThis as Record<string, unknown>).useDb
})

describe('previewRelocation', () => {
  const count = (q: ReturnType<typeof sql>) => (db.all(q) as { c: number }[])[0].c

  it('reports a file-exists conflict when moving a file onto an occupied key (no mutation)', () => {
    seed('other/a.png', 'other', 'a.png') // occupies the target key of moving pics/a.png into other
    const before = count(sql`select count(*) c from media`)
    const op: MediaOp = { type: 'move', items: [{ type: 'file', id: idOf('pics/a.png') }], dest: 'other' }
    const report = previewRelocation(asMediaDb(db), op)
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]).toMatchObject({ targetPath: 'other/a.png', type: 'file-exists' })
    expect(count(sql`select count(*) c from media`)).toBe(before)
  })

  it('reports a folder-exists conflict when the destination folder path already exists', () => {
    ensureFolder(asMediaDb(db), 'archive/sub')
    const op: MediaOp = { type: 'move', items: [{ type: 'folder', path: 'pics/sub' }], dest: 'archive' }
    const report = previewRelocation(asMediaDb(db), op)
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]).toMatchObject({ targetPath: 'archive/sub', type: 'folder-exists' })
  })

  it('reports a conflict when a folder is renamed/moved ONTO an existing file key (would 500 / desync on execute)', () => {
    // a file `other/pics` occupies the exact key a folder move would target
    seed('other/pics', 'other', 'pics')
    const op: MediaOp = { type: 'move', items: [{ type: 'folder', path: 'pics' }], dest: 'other' }
    const report = previewRelocation(asMediaDb(db), op)
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]).toMatchObject({ targetPath: 'other/pics', type: 'folder-exists' })
  })

  it('reports no conflicts for a clean move and computes the subtree summary', () => {
    const op: MediaOp = { type: 'move', items: [{ type: 'folder', path: 'pics' }], dest: 'archive' }
    const report = previewRelocation(asMediaDb(db), op)
    expect(report.conflicts).toEqual([])
    expect(report.summary.files).toBe(2) // pics/a.png + pics/sub/b.png
    expect(report.summary.folders).toBe(2) // pics + pics/sub
    expect(report.summary.totalBytes).toBe(2) // size 1 each
  })

  it('reports a file-exists conflict when copying into the same folder (source occupies the target)', () => {
    const op: MediaOp = { type: 'copy', items: [{ type: 'file', id: idOf('pics/a.png') }], dest: 'pics' }
    const report = previewRelocation(asMediaDb(db), op)
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]).toMatchObject({ targetPath: 'pics/a.png', type: 'file-exists' })
  })

  it('rejects moving a folder into its own descendant', () => {
    const op: MediaOp = { type: 'move', items: [{ type: 'folder', path: 'pics' }], dest: 'pics/sub' }
    expect(() => previewRelocation(asMediaDb(db), op)).toThrow()
  })

  it('reports no conflicts for a clean rename of a file', () => {
    const op: MediaOp = { type: 'rename', items: [{ type: 'file', id: idOf('pics/a.png') }], name: 'renamed.png' }
    const report = previewRelocation(asMediaDb(db), op)
    expect(report.conflicts).toEqual([])
    expect(report.summary.files).toBe(1)
  })

  it('flags only the conflicting item in a multi-item op (no cross-contamination)', () => {
    ensureFolder(asMediaDb(db), 'archive/sub') // archive/sub exists; archive/a.png does NOT
    const op: MediaOp = {
      type: 'move',
      items: [{ type: 'folder', path: 'pics/sub' }, { type: 'file', id: idOf('pics/a.png') }],
      dest: 'archive',
    }
    const report = previewRelocation(asMediaDb(db), op)
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]).toMatchObject({ targetPath: 'archive/sub', type: 'folder-exists' })
  })

  it('flags an intra-batch collision when two items target the same key (DB has nothing there)', () => {
    ensureFolder(asMediaDb(db), 'x'); ensureFolder(asMediaDb(db), 'y')
    seed('x/dup.png', 'x', 'dup.png')
    seed('y/dup.png', 'y', 'dup.png')
    const before = count(sql`select count(*) c from media`)
    const op: MediaOp = {
      type: 'move',
      items: [{ type: 'file', id: idOf('x/dup.png') }, { type: 'file', id: idOf('y/dup.png') }],
      dest: 'merged',
    }
    const report = previewRelocation(asMediaDb(db), op)
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]).toMatchObject({ targetPath: 'merged/dup.png', type: 'file-exists' })
    expect(count(sql`select count(*) c from media`)).toBe(before)
  })

  it('probes only the op\'s own target keys/paths — never an unconditional full-table scan', () => {
    const client = (db as unknown as { $client: { prepare: (source: string) => unknown } }).$client
    const spy = vi.spyOn(client, 'prepare')
    previewRelocation(asMediaDb(db), { type: 'move', items: [{ type: 'file', id: idOf('pics/a.png') }], dest: 'other' })
    const sqls = spy.mock.calls.map((c) => String(c[0]))
    spy.mockRestore()
    expect(sqls).not.toContain('select "storage_key" from "media"')
    expect(sqls).not.toContain('select "path" from "folders"')
  })
})

describe('executeRelocation', () => {
  let driver: ReturnType<typeof createLocalDriver>
  let uploadsDir: string
  beforeEach(() => {
    db = createTestDb()
    ensureRevisionsTable(sqliteClientOf(db), 'media')
    uploadsDir = mkdtempSync(join(tmpdir(), 'kestrel-mv-'))
    driver = createLocalDriver({ dir: uploadsDir, baseUrl: '/uploads' })
  })

  type Deriv = { key: string; width: number; height: number; mime: string }
  async function put(storageKey: string, folder: string, filename: string, derivs: Record<string, Deriv> = {}) {
    await driver.put(storageKey, Buffer.from('x'), 'image/png')
    for (const d of Object.values(derivs)) await driver.put(d.key, Buffer.from('v'), d.mime)
    ensureFolder(asMediaDb(db), folder)
    return create(db, media, { storageKey, folder, filename, mime: 'image/png', ext: 'png', size: 1, derivatives: derivs }) as { id: number }
  }
  const keyOf = (id: number) => (db.all(sql`select storage_key k from media where id = ${id}`) as { k: string }[])[0]?.k
  const filenameOf = (id: number) => (db.all(sql`select filename f from media where id = ${id}`) as { f: string }[])[0]?.f
  const folderExists = (path: string) => (db.all(sql`select count(*) c from folders where path = ${path}`) as { c: number }[])[0].c === 1
  const mediaCount = () => (db.all(sql`select count(*) c from media`) as { c: number }[])[0].c

  it('moves a file (+ derivative) into the destination folder', async () => {
    const a = await put('pics/a.png', 'pics', 'a.png', { '320.webp': { key: 'pics/a.png-320.webp', width: 320, height: 240, mime: 'image/webp' } })
    const result = await executeRelocation(asMediaDb(db), driver, { type: 'move', items: [{ type: 'file', id: a.id }], dest: 'archive' }, 'abort')

    expect(result).toEqual([{ item: { type: 'file', id: a.id }, status: 'moved', newPath: 'archive/a.png' }])
    expect(keyOf(a.id)).toBe('archive/a.png')
    expect(await driver.exists!('archive/a.png')).toBe(true)
    expect(await driver.exists!('archive/a.png-320.webp')).toBe(true)
    expect(await driver.exists!('pics/a.png')).toBe(false)
    expect(await driver.exists!('pics/a.png-320.webp')).toBe(false)
    expect(folderExists('archive')).toBe(true)
  })

  it('moves a folder recursively (media + folder rows); siblings untouched', async () => {
    ensureFolder(asMediaDb(db), 'pics')
    const b = await put('pics/sub/b.png', 'pics/sub', 'b.png')
    const c = await put('pics/sub/deep/c.png', 'pics/sub/deep', 'c.png')
    const x = await put('pics-archive/x.png', 'pics-archive', 'x.png')

    await executeRelocation(asMediaDb(db), driver, { type: 'move', items: [{ type: 'folder', path: 'pics/sub' }], dest: 'archive' }, 'abort')

    expect(keyOf(b.id)).toBe('archive/sub/b.png')
    expect(keyOf(c.id)).toBe('archive/sub/deep/c.png')
    expect(await driver.exists!('archive/sub/b.png')).toBe(true)
    expect(await driver.exists!('archive/sub/deep/c.png')).toBe(true)
    expect(folderExists('pics/sub')).toBe(false)
    expect(folderExists('pics/sub/deep')).toBe(false)
    expect(folderExists('archive/sub')).toBe(true)
    expect(folderExists('archive/sub/deep')).toBe(true)
    expect(keyOf(x.id)).toBe('pics-archive/x.png')
    expect(await driver.exists!('pics-archive/x.png')).toBe(true)
  })

  it('copies a file: new row + object, source intact', async () => {
    const a = await put('pics/a.png', 'pics', 'a.png')
    const result = await executeRelocation(asMediaDb(db), driver, { type: 'copy', items: [{ type: 'file', id: a.id }], dest: 'dup' }, 'abort')

    expect(result[0]).toMatchObject({ status: 'copied', newPath: 'dup/a.png' })
    const newId = (db.all(sql`select id from media where storage_key = ${'dup/a.png'}`) as { id: number }[])[0].id
    expect(newId).not.toBe(a.id)
    expect(await driver.exists!('dup/a.png')).toBe(true)
    expect(keyOf(a.id)).toBe('pics/a.png')
    expect(await driver.exists!('pics/a.png')).toBe(true)
    expect(folderExists('dup')).toBe(true)
  })

  it('copies a folder recursively: new rows + folder rows, source intact', async () => {
    const b = await put('pics/sub/b.png', 'pics/sub', 'b.png')
    await executeRelocation(asMediaDb(db), driver, { type: 'copy', items: [{ type: 'folder', path: 'pics/sub' }], dest: 'archive' }, 'abort')

    expect((db.all(sql`select count(*) c from media where storage_key = ${'archive/sub/b.png'}`) as { c: number }[])[0].c).toBe(1)
    expect(await driver.exists!('archive/sub/b.png')).toBe(true)
    expect(folderExists('archive/sub')).toBe(true)
    // source intact + total doubled for the subtree
    expect(keyOf(b.id)).toBe('pics/sub/b.png')
    expect(await driver.exists!('pics/sub/b.png')).toBe(true)
    expect(mediaCount()).toBe(2)
  })

  it('renames a file', async () => {
    const a = await put('docs/a.pdf', 'docs', 'a.pdf')
    const result = await executeRelocation(asMediaDb(db), driver, { type: 'rename', items: [{ type: 'file', id: a.id }], name: 'b.pdf' }, 'abort')

    expect(result[0].status).toBe('renamed')
    expect(keyOf(a.id)).toBe('docs/b.pdf')
    expect(await driver.exists!('docs/b.pdf')).toBe(true)
    expect(await driver.exists!('docs/a.pdf')).toBe(false)
  })

  it('renames a folder recursively', async () => {
    const b = await put('pics/sub/b.png', 'pics/sub', 'b.png')
    await executeRelocation(asMediaDb(db), driver, { type: 'rename', items: [{ type: 'folder', path: 'pics/sub' }], name: 'gallery' }, 'abort')

    expect(keyOf(b.id)).toBe('pics/gallery/b.png')
    expect(await driver.exists!('pics/gallery/b.png')).toBe(true)
    expect(folderExists('pics/sub')).toBe(false)
    expect(folderExists('pics/gallery')).toBe(true)
  })

  it('aborts on a real collision without mutating anything', async () => {
    const a = await put('pics/a.png', 'pics', 'a.png')
    await put('archive/a.png', 'archive', 'a.png') // occupies the move target

    await expect(
      executeRelocation(asMediaDb(db), driver, { type: 'move', items: [{ type: 'file', id: a.id }], dest: 'archive' }, 'abort'),
    ).rejects.toThrow()

    expect(keyOf(a.id)).toBe('pics/a.png')
    expect(await driver.exists!('pics/a.png')).toBe(true)
    expect(await driver.exists!('archive/a.png')).toBe(true)
  })

  it('skips a no-op move (file into its own folder)', async () => {
    const a = await put('pics/a.png', 'pics', 'a.png')
    const result = await executeRelocation(asMediaDb(db), driver, { type: 'move', items: [{ type: 'file', id: a.id }], dest: 'pics' }, 'abort')

    expect(result).toEqual([{ item: { type: 'file', id: a.id }, status: 'skipped' }])
    expect(await driver.exists!('pics/a.png')).toBe(true)
    expect(keyOf(a.id)).toBe('pics/a.png')
  })

  it('rejects moving a folder into its own descendant (guard)', async () => {
    ensureFolder(asMediaDb(db), 'pics')
    await expect(
      executeRelocation(asMediaDb(db), driver, { type: 'move', items: [{ type: 'folder', path: 'pics' }], dest: 'pics/sub' }, 'abort'),
    ).rejects.toThrow()
  })

  it('carries a derivative across folders in a folder move (key rewrite composes through the cascade)', async () => {
    const b = await put('pics/sub/b.png', 'pics/sub', 'b.png', {
      '320.webp': { key: 'pics/sub/b.png-320.webp', width: 320, height: 240, mime: 'image/webp' },
    })

    await executeRelocation(asMediaDb(db), driver, { type: 'move', items: [{ type: 'folder', path: 'pics/sub' }], dest: 'archive' }, 'abort')

    const derivKey = (db.all(sql`select derivatives from media where id = ${b.id}`) as { derivatives: string }[])[0].derivatives
    expect(derivKey).toContain('archive/sub/b.png-320.webp')
    expect(await driver.exists!('archive/sub/b.png-320.webp')).toBe(true)
    expect(await driver.exists!('pics/sub/b.png-320.webp')).toBe(false)
  })

  it('assigns distinct ids to every row in a multi-row folder copy', async () => {
    const b = await put('pics/sub/b.png', 'pics/sub', 'b.png')
    const c = await put('pics/sub/c.png', 'pics/sub', 'c.png')

    await executeRelocation(asMediaDb(db), driver, { type: 'copy', items: [{ type: 'folder', path: 'pics/sub' }], dest: 'archive' }, 'abort')

    expect(keyOf(b.id)).toBe('pics/sub/b.png')
    expect(keyOf(c.id)).toBe('pics/sub/c.png')

    const newB = (db.all(sql`select id from media where storage_key = ${'archive/sub/b.png'}`) as { id: number }[])[0].id
    const newC = (db.all(sql`select id from media where storage_key = ${'archive/sub/c.png'}`) as { id: number }[])[0].id

    expect(new Set([b.id, c.id, newB, newC]).size).toBe(4)
    expect(await driver.exists!('archive/sub/b.png')).toBe(true)
    expect(await driver.exists!('archive/sub/c.png')).toBe(true)
  })

  it('onConflict skip: skips the conflicting item, moves the clean one, occupant untouched', async () => {
    const dup = await put('x/dup.png', 'x', 'dup.png')
    const other = await put('y/other.png', 'y', 'other.png')
    const occupant = await put('merged/dup.png', 'merged', 'dup.png')

    const result = await executeRelocation(asMediaDb(db), driver, {
      type: 'move', items: [{ type: 'file', id: dup.id }, { type: 'file', id: other.id }], dest: 'merged',
    }, 'skip')

    expect(result.map((r) => r.status)).toEqual(['skipped', 'moved'])
    // occupant untouched (same id, still there)
    expect(idOf('merged/dup.png')).toBe(occupant.id)
    expect(await driver.exists!('merged/dup.png')).toBe(true)
    // mover x/dup.png stays at source
    expect(keyOf(dup.id)).toBe('x/dup.png')
    expect(await driver.exists!('x/dup.png')).toBe(true)
    // clean item moved
    expect(keyOf(other.id)).toBe('merged/other.png')
    expect(await driver.exists!('merged/other.png')).toBe(true)
    expect(await driver.exists!('y/other.png')).toBe(false)
  })

  it('onConflict overwrite (file): removes the occupant, lands the mover, status overwritten', async () => {
    const a = await put('pics/a.png', 'pics', 'a.png')
    const occupant = await put('archive/a.png', 'archive', 'a.png')

    const result = await executeRelocation(asMediaDb(db), driver, {
      type: 'move', items: [{ type: 'file', id: a.id }], dest: 'archive',
    }, 'overwrite')

    expect(result[0].status).toBe('overwritten')
    expect(keyOf(occupant.id)).toBeUndefined()
    // archive/a.png now exists and is the moved row
    expect(idOf('archive/a.png')).toBe(a.id)
    expect(await driver.exists!('archive/a.png')).toBe(true)
    expect(await driver.exists!('pics/a.png')).toBe(false)
  })

  it('onConflict overwrite: a LATER item in the same batch never destroys an EARLIER item that already landed on its target (both survive)', async () => {
    const a = await put('x/a.png', 'x', 'a.png')
    const b = await put('y/a.png', 'y', 'a.png')

    const result = await executeRelocation(asMediaDb(db), driver, {
      type: 'move', items: [{ type: 'file', id: a.id }, { type: 'file', id: b.id }], dest: 'd',
    }, 'overwrite')

    expect(result[0].status).toBe('moved')
    expect(result[1].status).toBe('skipped')
    expect(keyOf(a.id)).toBe('d/a.png')
    expect(await driver.exists!('d/a.png')).toBe(true)
    expect(keyOf(b.id)).toBe('y/a.png')
    expect(await driver.exists!('y/a.png')).toBe(true)
  })

  it('onConflict overwrite (copy): a LATER item never destroys the fresh row an EARLIER copy just created', async () => {
    const a = await put('x/a.png', 'x', 'a.png')
    await driver.put('x/a.png', Buffer.from('AAA'), 'image/png')
    const b = await put('y/a.png', 'y', 'a.png')
    await driver.put('y/a.png', Buffer.from('BBB'), 'image/png')

    const result = await executeRelocation(asMediaDb(db), driver, {
      type: 'copy', items: [{ type: 'file', id: a.id }, { type: 'file', id: b.id }], dest: 'd',
    }, 'overwrite')

    expect(result[0].status).toBe('copied')
    expect(result[1].status).toBe('skipped')
    expect((await driver.get!('d/a.png')).toString()).toBe('AAA')
    expect(keyOf(a.id)).toBe('x/a.png')
    expect(keyOf(b.id)).toBe('y/a.png')
  })

  it('onConflict overwrite (copy): a genuine pre-existing occupant is still overwritten even when it is an earlier no-op item of the same batch', async () => {
    const a = await put('d/keep.png', 'd', 'keep.png')
    await driver.put('d/keep.png', Buffer.from('AAA'), 'image/png')
    const b = await put('y/keep.png', 'y', 'keep.png')
    await driver.put('y/keep.png', Buffer.from('BBB'), 'image/png')

    const result = await executeRelocation(asMediaDb(db), driver, {
      type: 'copy', items: [{ type: 'file', id: a.id }, { type: 'file', id: b.id }], dest: 'd',
    }, 'overwrite')

    expect(result[0].status).toBe('skipped') // copying a into its own folder is a no-op — nothing landed
    expect(result[1].status).toBe('overwritten')
    expect(keyOf(a.id)).toBeUndefined()
    expect((await driver.get!('d/keep.png')).toString()).toBe('BBB')
  })

  it('onConflict overwrite (folder): wipes the occupant subtree, lands the mover subtree', async () => {
    const b = await put('pics/sub/b.png', 'pics/sub', 'b.png')
    const old = await put('archive/sub/old.png', 'archive/sub', 'old.png')

    const result = await executeRelocation(asMediaDb(db), driver, {
      type: 'move', items: [{ type: 'folder', path: 'pics/sub' }], dest: 'archive',
    }, 'overwrite')

    expect(result[0].status).toBe('overwritten')
    expect(keyOf(old.id)).toBeUndefined()
    expect(await driver.exists!('archive/sub/old.png')).toBe(false)
    expect(keyOf(b.id)).toBe('archive/sub/b.png')
    expect(await driver.exists!('archive/sub/b.png')).toBe(true)
    expect(folderExists('pics/sub')).toBe(false)
    expect(await driver.exists!('pics/sub/b.png')).toBe(false)
  })

  it('onConflict rename (file): keeps the occupant, lands the mover at a freed name', async () => {
    const a = await put('pics/a.png', 'pics', 'a.png')
    const occupant = await put('archive/a.png', 'archive', 'a.png')

    const result = await executeRelocation(asMediaDb(db), driver, {
      type: 'move', items: [{ type: 'file', id: a.id }], dest: 'archive',
    }, 'rename')

    expect(result[0].status).toBe('renamed-auto')
    expect(result[0].newPath).toBe('archive/a-2.png')
    expect(keyOf(occupant.id)).toBe('archive/a.png')
    expect(await driver.exists!('archive/a.png')).toBe(true)
    expect(keyOf(a.id)).toBe('archive/a-2.png')
    expect(await driver.exists!('archive/a-2.png')).toBe(true)
    expect(await driver.exists!('pics/a.png')).toBe(false)
  })

  it('onConflict rename (folder): keeps the occupant, re-bases the mover under a freed root', async () => {
    const b = await put('pics/sub/b.png', 'pics/sub', 'b.png')
    const x = await put('archive/sub/x.png', 'archive/sub', 'x.png')

    const result = await executeRelocation(asMediaDb(db), driver, {
      type: 'move', items: [{ type: 'folder', path: 'pics/sub' }], dest: 'archive',
    }, 'rename')

    expect(result[0].status).toBe('renamed-auto')
    expect(result[0].newPath).toBe('archive/sub-2')
    expect(keyOf(x.id)).toBe('archive/sub/x.png')
    expect(await driver.exists!('archive/sub/x.png')).toBe(true)
    expect(keyOf(b.id)).toBe('archive/sub-2/b.png')
    expect(await driver.exists!('archive/sub-2/b.png')).toBe(true)
    expect(folderExists('archive/sub-2')).toBe(true)
    expect(folderExists('pics/sub')).toBe(false)
  })

  it('onConflict rename: copy duplicate-in-place gets a freed name, source intact', async () => {
    const a = await put('pics/a.png', 'pics', 'a.png')

    const result = await executeRelocation(asMediaDb(db), driver, {
      type: 'copy', items: [{ type: 'file', id: a.id }], dest: 'pics',
    }, 'rename')

    expect(result[0].status).toBe('renamed-auto')
    expect(keyOf(a.id)).toBe('pics/a.png')
    expect(await driver.exists!('pics/a.png')).toBe(true)
    expect(idOf('pics/a-2.png')).not.toBe(a.id)
    expect(await driver.exists!('pics/a-2.png')).toBe(true)
    expect(mediaCount()).toBe(2)
  })

  it('onConflict rename: two movers colliding on the same key get distinct freed names', async () => {
    await put('archive/a.png', 'archive', 'a.png')
    const x = await put('x/a.png', 'x', 'a.png')
    const y = await put('y/a.png', 'y', 'a.png')

    const result = await executeRelocation(asMediaDb(db), driver, {
      type: 'move', items: [{ type: 'file', id: idOf('x/a.png') }, { type: 'file', id: idOf('y/a.png') }], dest: 'archive',
    }, 'rename')

    expect(result.map((r) => r.status)).toEqual(['renamed-auto', 'renamed-auto'])
    expect(result[0].newPath).toBe('archive/a-2.png')
    expect(result[1].newPath).toBe('archive/a-3.png')
    expect(await driver.exists!('archive/a.png')).toBe(true)
    expect(keyOf(x.id)).toBe('archive/a-2.png')
    expect(keyOf(y.id)).toBe('archive/a-3.png')
    expect(await driver.exists!('archive/a-2.png')).toBe(true)
    expect(await driver.exists!('archive/a-3.png')).toBe(true)
  })

  it('folder move: dest dir exists, source dir is removed from disk', async () => {
    const b = await put('pics/sub/b.png', 'pics/sub', 'b.png')

    await executeRelocation(asMediaDb(db), driver, { type: 'move', items: [{ type: 'folder', path: 'pics/sub' }], dest: 'archive' }, 'abort')

    expect(keyOf(b.id)).toBe('archive/sub/b.png')
    expect(existsSync(join(uploadsDir, 'archive/sub'))).toBe(true)
    expect(existsSync(join(uploadsDir, 'pics/sub'))).toBe(false)
  })

  it('folder rename: dest dir exists, source dir is removed from disk', async () => {
    const b = await put('pics/sub/b.png', 'pics/sub', 'b.png')

    await executeRelocation(asMediaDb(db), driver, { type: 'rename', items: [{ type: 'folder', path: 'pics/sub' }], name: 'gallery' }, 'abort')

    expect(keyOf(b.id)).toBe('pics/gallery/b.png')
    expect(existsSync(join(uploadsDir, 'pics/gallery'))).toBe(true)
    expect(existsSync(join(uploadsDir, 'pics/sub'))).toBe(false)
  })

  it('folder copy: dest dir exists, source dir still present on disk', async () => {
    const b = await put('pics/sub/b.png', 'pics/sub', 'b.png')

    await executeRelocation(asMediaDb(db), driver, { type: 'copy', items: [{ type: 'folder', path: 'pics/sub' }], dest: 'archive' }, 'abort')

    expect(existsSync(join(uploadsDir, 'archive/sub'))).toBe(true)
    expect(existsSync(join(uploadsDir, 'pics/sub'))).toBe(true)
    expect(keyOf(b.id)).toBe('pics/sub/b.png')
  })

  it('empty folder move: dest dir created, source dir removed from disk', async () => {
    ensureFolder(asMediaDb(db), 'empty-src')
    await driver.ensureDir!('empty-src')

    await executeRelocation(asMediaDb(db), driver, { type: 'move', items: [{ type: 'folder', path: 'empty-src' }], dest: 'archive' }, 'abort')

    expect(folderExists('archive/empty-src')).toBe(true)
    expect(existsSync(join(uploadsDir, 'archive/empty-src'))).toBe(true)
    expect(existsSync(join(uploadsDir, 'empty-src'))).toBe(false)
  })

  it('copy + abort onto an occupied target throws at execute (nothing changed)', async () => {
    const a = await put('pics/a.png', 'pics', 'a.png')
    const occupant = await put('dup/a.png', 'dup', 'a.png')
    const before = mediaCount()

    await expect(
      executeRelocation(asMediaDb(db), driver, { type: 'copy', items: [{ type: 'file', id: a.id }], dest: 'dup' }, 'abort'),
    ).rejects.toThrow()

    expect(keyOf(a.id)).toBe('pics/a.png')
    expect(await driver.exists!('pics/a.png')).toBe(true)
    expect(keyOf(occupant.id)).toBe('dup/a.png')
    expect(await driver.exists!('dup/a.png')).toBe(true)
    expect(mediaCount()).toBe(before)
  })

  it('rename updates the filename column (not just the storageKey)', async () => {
    const a = await put('pics/to-rename.png', 'pics', 'to-rename.png', {
      '16.webp': { key: 'pics/to-rename.png-16.webp', width: 16, height: 16, mime: 'image/webp' },
    })
    const result = await executeRelocation(asMediaDb(db), driver, { type: 'rename', items: [{ type: 'file', id: a.id }], name: 'renamed.png' }, 'abort')
    expect(result[0].status).toBe('renamed')
    expect(keyOf(a.id)).toBe('pics/renamed.png')
    expect(filenameOf(a.id)).toBe('renamed.png') // the displayed name must follow the rename
    expect(await driver.exists!('pics/renamed.png')).toBe(true)
    expect(await driver.exists!('pics/renamed.png-16.webp')).toBe(true)
    expect(await driver.exists!('pics/to-rename.png')).toBe(false)
  })

  it('move keeps the filename column unchanged', async () => {
    const a = await put('pics/a.png', 'pics', 'a.png')
    await executeRelocation(asMediaDb(db), driver, { type: 'move', items: [{ type: 'file', id: a.id }], dest: 'archive' }, 'abort')
    expect(keyOf(a.id)).toBe('archive/a.png')
    expect(filenameOf(a.id)).toBe('a.png')
  })

  it('copy into the same folder with overwrite is a no-op (keeps exactly one file)', async () => {
    const a = await put('pics/to-copy.png', 'pics', 'to-copy.png', {
      '16.webp': { key: 'pics/to-copy-16.webp', width: 16, height: 16, mime: 'image/webp' },
    })
    await executeRelocation(asMediaDb(db), driver, { type: 'copy', items: [{ type: 'file', id: a.id }], dest: 'pics' }, 'overwrite')
    expect(await driver.exists!('pics/to-copy.png')).toBe(true)
    expect(mediaCount()).toBe(1)
  })

  it('moves a mixed file+folder batch in one op (both land; asserts uniform newPath)', async () => {
    const x = await put('top/x.png', 'top', 'x.png')
    const b = await put('pics/sub/b.png', 'pics/sub', 'b.png')

    const result = await executeRelocation(asMediaDb(db), driver, {
      type: 'move', items: [{ type: 'file', id: x.id }, { type: 'folder', path: 'pics/sub' }], dest: 'archive',
    }, 'abort')

    expect(result).toEqual([
      { item: { type: 'file', id: x.id }, status: 'moved', newPath: 'archive/x.png' },
      { item: { type: 'folder', path: 'pics/sub' }, status: 'moved', newPath: 'archive/sub' },
    ])
    expect(keyOf(x.id)).toBe('archive/x.png')
    expect(await driver.exists!('archive/x.png')).toBe(true)
    expect(keyOf(b.id)).toBe('archive/sub/b.png')
    expect(await driver.exists!('archive/sub/b.png')).toBe(true)
    expect(folderExists('archive/sub')).toBe(true)
    expect(await driver.exists!('top/x.png')).toBe(false)
    expect(await driver.exists!('pics/sub/b.png')).toBe(false)
    expect(folderExists('pics/sub')).toBe(false)
  })
})

describe('coerceOpItems', () => {
  it('keeps valid file and folder items verbatim', () => {
    expect(coerceOpItems([{ type: 'file', id: 3 }])).toEqual([{ type: 'file', id: 3 }])
    expect(coerceOpItems([{ type: 'folder', path: 'a/b' }])).toEqual([{ type: 'folder', path: 'a/b' }])
  })

  it('drops malformed entries', () => {
    const raw = [
      { type: 'file' }, // no id
      { type: 'file', id: 1.5 }, // non-integer id
      { type: 'folder' }, // no path
      { type: 'folder', path: 5 }, // non-string path
      null,
      42,
      { type: 'x' }, // unknown type
    ]
    expect(coerceOpItems(raw)).toEqual([])
  })

  it('returns [] for non-array input', () => {
    expect(coerceOpItems(undefined)).toEqual([])
    expect(coerceOpItems('foo')).toEqual([])
    expect(coerceOpItems({})).toEqual([])
  })

  it('sanitizes folder paths so the disk cascade matches the DB cascade (no .. desync)', () => {
    expect(coerceOpItems([{ type: 'folder', path: 'keep/../target' }])).toEqual([{ type: 'folder', path: 'keep/target' }])
    expect(coerceOpItems([{ type: 'folder', path: '../etc' }])).toEqual([{ type: 'folder', path: 'etc' }])
    expect(coerceOpItems([{ type: 'folder', path: '/a//b/' }])).toEqual([{ type: 'folder', path: 'a/b' }])
  })

  it('drops folder items that sanitize to empty (the root is not a relocatable item)', () => {
    expect(coerceOpItems([{ type: 'folder', path: '..' }])).toEqual([])
    expect(coerceOpItems([{ type: 'folder', path: '' }])).toEqual([])
    expect(coerceOpItems([{ type: 'folder', path: '/' }])).toEqual([])
  })

  it('keeps only the valid items from a mixed array, in order', () => {
    const raw = [
      { type: 'file', id: 1 },
      { type: 'file' }, // dropped
      { type: 'folder', path: 'x' },
      null, // dropped
      { type: 'file', id: 2 },
    ]
    expect(coerceOpItems(raw)).toEqual([
      { type: 'file', id: 1 },
      { type: 'folder', path: 'x' },
      { type: 'file', id: 2 },
    ])
  })
})
