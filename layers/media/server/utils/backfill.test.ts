import { describe, it, expect } from 'vitest'
import { sql, eq, getTableColumns } from 'drizzle-orm'
import sharp from 'sharp'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from '../../../../test/helpers/db'
import { createLocalDriver } from '../../../core/server/utils/storage.local'
import { DEFAULT_IMAGE_POLICY, type ResolvedVariant } from '../../../core/server/utils/kestrel-config'
import { planBackfill, backfillRow, runBackfill } from './backfill'
import { registerWriteListener, clearWriteListeners } from '../../../core/server/utils/write-events'
import { media } from '../collections/media'
import type { DerivativeManifest } from './record'

const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer()
const spec = (name: string, width: number, height: number | null, formats: ('webp' | 'jpeg')[]): ResolvedVariant =>
  ({ name, width, height, fit: 'cover', position: 'centre', formats })
// createTestDb() already migrates the `media` table (built-in collection); only `media_settings` (Slice 3) is new.
const MEDIA_SETTINGS_DDL = sql`CREATE TABLE IF NOT EXISTS media_settings (id integer PRIMARY KEY AUTOINCREMENT, singleton_key text NOT NULL, variants text, created_at integer NOT NULL, updated_at integer NOT NULL)`

describe('planBackfill (pure)', () => {
  const row = {
    width: 800,
    derivatives: {
      'w320.webp': { key: 'a/pic.png-w320.webp', width: 320, height: 240, mime: 'image/webp' },
      'w960.webp': { key: 'a/pic.png-w960.webp', width: 960, height: 720, mime: 'image/webp' }, // deregistered
    } as DerivativeManifest,
  }

  it('reports the missing formats to generate and the deregistered objects to prune', () => {
    const plan = planBackfill(row, [spec('w320', 320, null, ['webp', 'jpeg']), spec('w640', 640, null, ['webp'])])
    expect(plan.missing).toEqual([
      { name: 'w320', width: 320, height: null, fit: 'cover', position: 'centre', formats: ['jpeg'] }, // webp exists
      { name: 'w640', width: 640, height: null, fit: 'cover', position: 'centre', formats: ['webp'] },
    ])
    expect(plan.orphanKeys).toEqual(['a/pic.png-w960.webp'])
  })

  it('never marks a proportional spec wider than the source as missing (deriveImage would skip it)', () => {
    const plan = planBackfill({ width: 500, derivatives: {} }, [spec('w320', 320, null, ['webp']), spec('w1280', 1280, null, ['webp'])])
    expect(plan.missing.map((s) => s.name)).toEqual(['w320'])
  })

  it('a fully-covered row has no work', () => {
    const plan = planBackfill(row, [spec('w320', 320, null, ['webp']), spec('w960', 960, null, ['webp'])])
    expect(plan).toEqual({ missing: [], orphanKeys: [] })
  })
})

describe('backfillRow (integration: get → derive missing → put → update → prune-last)', () => {
  it('generates the missing variants, prunes the orphan object, and rewrites the manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-backfill-'))
    try {
      const db = createTestDb()
      const driver = createLocalDriver({ dir, baseUrl: '/uploads' })
      const original = await png(800, 600)
      await driver.put('a/pic.png', original, 'image/png')
      await driver.put('a/pic.png-w320.webp', Buffer.from('existing'), 'image/webp')
      await driver.put('a/pic.png-w960.webp', Buffer.from('orphan'), 'image/webp')
      const manifest = {
        'w320.webp': { key: 'a/pic.png-w320.webp', width: 320, height: 240, mime: 'image/webp' },
        'w960.webp': { key: 'a/pic.png-w960.webp', width: 960, height: 720, mime: 'image/webp' },
      }
      db.run(sql`INSERT INTO media (storage_key, filename, mime, ext, size, width, height, derivatives, translations, created_at, updated_at)
        VALUES ('a/pic.png','pic.png','image/png','png',${original.length},800,600,${JSON.stringify(manifest)},'{}',0,0)`)

      const specs = [spec('w320', 320, null, ['webp', 'jpeg']), spec('w640', 640, null, ['webp'])]
      const r = await backfillRow(db, driver, { id: 1, storageKey: 'a/pic.png', mime: 'image/png', width: 800, derivatives: manifest }, specs, DEFAULT_IMAGE_POLICY)

      expect(r).toEqual({ generated: 2, pruned: 1 }) // w320.jpeg + w640.webp generated; w960.webp pruned
      expect(await driver.exists!('a/pic.png-w320.jpeg')).toBe(true)
      expect(await driver.exists!('a/pic.png-w640.webp')).toBe(true)
      expect(await driver.exists!('a/pic.png-w960.webp')).toBe(false)
      const cols = getTableColumns(media) as Record<string, never>
      const saved = db.select().from(media).where(eq(cols.id, 1)).get() as { derivatives: DerivativeManifest }
      expect(Object.keys(saved.derivatives).sort()).toEqual(['w320.jpeg', 'w320.webp', 'w640.webp'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('emits a media write event so pages embedding the pruned derivative re-render', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-backfill-'))
    const events: { before: unknown; after: unknown; name: string }[] = []
    registerWriteListener((e) => events.push({ before: e.before, after: e.after, name: e.def.name }))
    try {
      const db = createTestDb()
      const driver = createLocalDriver({ dir, baseUrl: '/uploads' })
      const original = await png(800, 600)
      await driver.put('a/pic.png', original, 'image/png')
      await driver.put('a/pic.png-w960.webp', Buffer.from('orphan'), 'image/webp')
      const manifest = { 'w960.webp': { key: 'a/pic.png-w960.webp', width: 960, height: 720, mime: 'image/webp' } }
      db.run(sql`INSERT INTO media (storage_key, filename, mime, ext, size, width, height, derivatives, translations, created_at, updated_at)
        VALUES ('a/pic.png','pic.png','image/png','png',${original.length},800,600,${JSON.stringify(manifest)},'{}',0,0)`)

      await backfillRow(db, driver, { id: 1, storageKey: 'a/pic.png', mime: 'image/png', width: 800, derivatives: manifest }, [spec('w320', 320, null, ['webp'])], DEFAULT_IMAGE_POLICY)

      expect(events).toEqual([{ name: 'media', before: { id: 1 }, after: { id: 1 } }])
    } finally {
      clearWriteListeners()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('emits nothing for a row that is already reconciled', async () => {
    const events: unknown[] = []
    registerWriteListener((e) => events.push(e))
    try {
      const db = createTestDb()
      const r = await backfillRow(db, createLocalDriver({ dir: tmpdir(), baseUrl: '/uploads' }), { id: 1, storageKey: 'a/pic.png', mime: 'image/png', width: 800, derivatives: {} }, [], DEFAULT_IMAGE_POLICY)
      expect(r).toEqual({ generated: 0, pruned: 0 })
      expect(events).toEqual([])
    } finally {
      clearWriteListeners()
    }
  })
})

describe('runBackfill', () => {
  it('check mode reports the plan across raster rows without writing (skips non-raster)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-backfill-run-'))
    const events: unknown[] = []
    registerWriteListener((e) => events.push(e))
    try {
      const db = createTestDb()
      db.run(MEDIA_SETTINGS_DDL) // empty → activeVariants falls back to the config default ladder
      db.run(sql`INSERT INTO media (storage_key, filename, mime, ext, size, width, height, derivatives, translations, created_at, updated_at) VALUES ('a/pic.png','pic.png','image/png','png',1,800,600,'{}','{}',0,0)`)
      db.run(sql`INSERT INTO media (storage_key, filename, mime, ext, size, width, height, derivatives, translations, created_at, updated_at) VALUES ('a/doc.pdf','doc.pdf','application/pdf','pdf',1,NULL,NULL,'{}','{}',0,0)`)
      const report = await runBackfill(db, createLocalDriver({ dir, baseUrl: '/uploads' }), DEFAULT_IMAGE_POLICY, { check: true })
      // default ladder w320..w1920; source 800 → w320,w640 applicable (webp each); the pdf row is skipped
      expect(report).toEqual({ rows: 2, rowsChanged: 1, generated: 2, pruned: 0, check: true })
      expect(events).toEqual([]) // a dry run changes nothing, so it must not trigger a republish
    } finally {
      clearWriteListeners()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
