import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { collectAffected, bulkUsages, deleteAffected } from './media-ops'
import { ensureFolder } from './folders'
import { create } from '../../../core/server/utils/crud'
import media from '../collections/media'
import { createTestDb } from '../../../../test/helpers/db'
import { createLocalDriver } from '../../../core/server/utils/storage.local'
import { clearRegistry, registerCollection } from '../../../core/server/utils/registry'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../../core/server/utils/defineCollection'

let db: ReturnType<typeof createTestDb>
const seed = (storageKey: string, folder: string, filename: string) =>
  create(db, media, { storageKey, folder, filename, mime: 'image/png', ext: 'png', size: 1 }) as { id: number }
const idOf = (storageKey: string) => (db.all(sql`select id from media where storage_key = ${storageKey}`) as { id: number }[])[0].id

beforeEach(() => {
  db = createTestDb()
  ensureFolder(db, 'pics/sub')
  ensureFolder(db, 'pics-archive') // sibling-prefix — must NOT be swept by 'pics'
  seed('pics/a.png', 'pics', 'a.png')
  seed('pics/sub/b.png', 'pics/sub', 'b.png')
  seed('pics-archive/c.png', 'pics-archive', 'c.png')
  seed('other/d.png', 'other', 'd.png')
})

describe('collectAffected', () => {
  it('resolves a file item to its single media row', () => {
    const r = collectAffected(db, [{ type: 'file', id: idOf('pics/a.png') }])
    expect(r.media.map((m) => m.storageKey)).toEqual(['pics/a.png'])
    expect(r.folders).toEqual([])
  })
  it('expands a folder item to itself + descendants (media + folder rows), not sibling-prefixes', () => {
    const r = collectAffected(db, [{ type: 'folder', path: 'pics' }])
    expect(r.media.map((m) => m.storageKey).sort()).toEqual(['pics/a.png', 'pics/sub/b.png'])
    expect(r.folders.sort()).toEqual(['pics', 'pics/sub'])
    expect(r.media.some((m) => m.storageKey.startsWith('pics-archive'))).toBe(false)
  })
  it('returns folders deepest-first and dedupes overlapping items', () => {
    const r = collectAffected(db, [{ type: 'folder', path: 'pics' }, { type: 'folder', path: 'pics/sub' }])
    expect(r.folders).toEqual(['pics/sub', 'pics'])
    expect(r.media.length).toBe(2)
  })
  it('never reads the folders table for an all-file item list (the list would go unused)', () => {
    const client = (db as unknown as { $client: { prepare: (source: string) => unknown } }).$client
    const spy = vi.spyOn(client, 'prepare')
    collectAffected(db, [{ type: 'file', id: idOf('pics/a.png') }, { type: 'file', id: idOf('other/d.png') }])
    const sqls = spy.mock.calls.map((c) => String(c[0]))
    spy.mockRestore()
    expect(sqls.some((s) => s.includes('from "folders"'))).toBe(false)
  })
})

describe('bulkUsages', () => {
  it('returns a usages array per requested id (empty when unreferenced)', () => {
    const a = seed('u/a.png', 'u', 'a.png')
    const b = seed('u/b.png', 'u', 'b.png')
    const r = bulkUsages(db, [a.id, b.id])
    expect(Object.keys(r).map(Number).sort()).toEqual([a.id, b.id].sort())
    expect(r[a.id]).toEqual([])
    expect(r[b.id]).toEqual([])
  })

  it('costs the same number of SQL statements for many ids as for one (no per-id full scans)', () => {
    clearRegistry()
    try {
      registerCollection(buildCollection(defineCollection({
        name: 'posts2', mode: 'multi', translatable: false, seo: true,
        blocks: { enabled: true },
        fields: { cover: { type: 'media' }, gallery: { type: 'media', options: { multiple: true } }, meta: { type: 'json' } },
      })))
      db.run(sql`CREATE TABLE posts2 (id integer PRIMARY KEY AUTOINCREMENT, seo text NOT NULL DEFAULT '{}', cover_id integer, gallery text, meta text, content text NOT NULL DEFAULT '[]', created_at integer NOT NULL, updated_at integer NOT NULL)`)
      const client = (db as unknown as { $client: { prepare: (source: string) => unknown } }).$client
      const spy = vi.spyOn(client, 'prepare')
      bulkUsages(db, [1])
      const forOne = spy.mock.calls.length
      expect(forOne).toBeGreaterThan(0)
      spy.mockClear()
      bulkUsages(db, Array.from({ length: 20 }, (_, i) => i + 1))
      expect(spy.mock.calls.length).toBe(forOne)
      spy.mockRestore()
    } finally {
      clearRegistry()
    }
  })
})

describe('deleteAffected', () => {
  let uploadsDir: string
  let driver: ReturnType<typeof createLocalDriver>
  beforeEach(() => {
    db = createTestDb()
    uploadsDir = mkdtempSync(join(tmpdir(), 'kestrel-del-'))
    driver = createLocalDriver({ dir: uploadsDir, baseUrl: '/uploads' })
  })
  afterEach(() => { rmSync(uploadsDir, { recursive: true, force: true }) })
  const count = (q: ReturnType<typeof sql>) => (db.all(q) as { c: number }[])[0].c

  it('dryRun reports the impact + usages without mutating', async () => {
    ensureFolder(db, 'pics/sub')
    const a = seed('pics/a.png', 'pics', 'a.png'); await driver.put('pics/a.png', Buffer.from('x'), 'image/png')
    seed('pics/sub/b.png', 'pics/sub', 'b.png'); await driver.put('pics/sub/b.png', Buffer.from('y'), 'image/png')
    const report = await deleteAffected(db, driver, [{ type: 'folder', path: 'pics' }], true)
    expect(report.summary.files).toBe(2)
    expect(report.summary.folders).toBe(2)
    expect(report.usages![a.id]).toEqual([])
    expect(await driver.exists!('pics/a.png')).toBe(true)
    expect(count(sql`select count(*) c from media`)).toBe(2)
  })
  it('execute deletes media rows + storage objects + folder rows (cascade); siblings survive', async () => {
    ensureFolder(db, 'pics/sub'); ensureFolder(db, 'pics-archive')
    seed('pics/a.png', 'pics', 'a.png'); await driver.put('pics/a.png', Buffer.from('x'), 'image/png')
    seed('pics/sub/b.png', 'pics/sub', 'b.png'); await driver.put('pics/sub/b.png', Buffer.from('y'), 'image/png')
    seed('pics-archive/c.png', 'pics-archive', 'c.png')
    await deleteAffected(db, driver, [{ type: 'folder', path: 'pics' }], false)
    expect(count(sql`select count(*) c from media`)).toBe(1) // only pics-archive/c.png left
    expect(count(sql`select count(*) c from folders where path = 'pics' or path like 'pics/%'`)).toBe(0)
    expect(count(sql`select count(*) c from folders where path = 'pics-archive'`)).toBe(1)
    expect(await driver.exists!('pics/a.png')).toBe(false)
    expect(await driver.exists!('pics/sub/b.png')).toBe(false)
  })
  it('execute removes the folder dir subtree from disk', async () => {
    ensureFolder(db, 'pics/sub')
    seed('pics/a.png', 'pics', 'a.png'); await driver.put('pics/a.png', Buffer.from('x'), 'image/png')
    seed('pics/sub/b.png', 'pics/sub', 'b.png'); await driver.put('pics/sub/b.png', Buffer.from('y'), 'image/png')
    expect(existsSync(join(uploadsDir, 'pics'))).toBe(true)
    await deleteAffected(db, driver, [{ type: 'folder', path: 'pics' }], false)
    expect(existsSync(join(uploadsDir, 'pics'))).toBe(false)
  })
  it('execute removes an empty folder dir (no files, just a folders row + dir)', async () => {
    ensureFolder(db, 'empty-folder')
    mkdirSync(join(uploadsDir, 'empty-folder'), { recursive: true })
    expect(existsSync(join(uploadsDir, 'empty-folder'))).toBe(true)
    await deleteAffected(db, driver, [{ type: 'folder', path: 'empty-folder' }], false)
    expect(existsSync(join(uploadsDir, 'empty-folder'))).toBe(false)
    expect(count(sql`select count(*) c from folders where path = 'empty-folder'`)).toBe(0)
  })
  it('never wipes unmanaged objects under the folder (e.g. an extension blob namespace) on delete', async () => {
    ensureFolder(db, 'galleries-secure')
    seed('galleries-secure/cover.png', 'galleries-secure', 'cover.png'); await driver.put('galleries-secure/cover.png', Buffer.from('x'), 'image/png')
    // an unmanaged blob written by an extension under a same-named path — no media row backs it
    await driver.put('galleries-secure/g1/secret.bin', Buffer.from('cipher'), 'application/octet-stream')
    await deleteAffected(db, driver, [{ type: 'folder', path: 'galleries-secure' }], false)
    expect(await driver.exists!('galleries-secure/cover.png')).toBe(false)   // managed media deleted
    expect(await driver.exists!('galleries-secure/g1/secret.bin')).toBe(true) // unmanaged blob preserved
  })
  it('file-only delete does not remove any directory', async () => {
    ensureFolder(db, 'pics')
    const a = seed('pics/a.png', 'pics', 'a.png'); await driver.put('pics/a.png', Buffer.from('x'), 'image/png')
    await deleteAffected(db, driver, [{ type: 'file', id: a.id }], false)
    expect(existsSync(join(uploadsDir, 'pics'))).toBe(true)
  })
  it('a storage delete failure for one item is best-effort: later items still get deleted and the failure is reported, not thrown', async () => {
    ensureFolder(db, 'pics')
    const a = seed('pics/a.png', 'pics', 'a.png'); await driver.put('pics/a.png', Buffer.from('x'), 'image/png')
    const b = seed('pics/b.png', 'pics', 'b.png'); await driver.put('pics/b.png', Buffer.from('y'), 'image/png')
    const realDelete = driver.delete.bind(driver)
    vi.spyOn(driver, 'delete').mockImplementation(async (key: string, opts) => {
      if (key === 'pics/a.png') throw new Error('boom')
      return realDelete(key, opts)
    })
    const report = await deleteAffected(db, driver, [{ type: 'folder', path: 'pics' }], false)
    expect(report.failedKeys).toEqual(['pics/a.png'])
    // the row for the FAILING item is still gone (rows commit up front) — but its blob delete failing
    // must not abort the loop before it reaches the next item
    expect(count(sql`select count(*) c from media`)).toBe(0)
    expect(await driver.exists!('pics/b.png')).toBe(false)
    void a
  })
})
