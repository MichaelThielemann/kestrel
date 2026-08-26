import { describe, it, expect, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDb } from '../../../../../test/helpers/db.js'
import { createLocalDriver } from '@michaelthielemann/kestrel-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistUpload } from '../../../src/server/utils/persist-upload.js'
import { buildMediaValues } from '../../../src/server/utils/record.js'
import { NO_PIPELINE_CTX } from '../../../src/server/utils/media-write.js'
import type { StorageDriver } from '@michaelthielemann/kestrel-core'
import type { MediaDb } from '../../../src/server/db/media-db.js'

function asMediaDb(db: ReturnType<typeof createTestDb>): MediaDb {
  return db as unknown as MediaDb
}

let db: ReturnType<typeof createTestDb>
let dir: string
beforeEach(() => {
  db = createTestDb()
  dir = mkdtempSync(join(tmpdir(), 'kestrel-persist-'))
})

const args = (over: Record<string, unknown> = {}) => ({
  storageKey: 'pics/a.png', bytes: Buffer.from('orig'), mime: 'image/png',
  derived: { width: 10, height: 10, thumbhash: 'T', variants: [{ name: 'w320', width: 320, height: 240, format: 'webp' as const, mime: 'image/webp', bytes: Buffer.from('v') }] },
  values: buildMediaValues({ storageKey: 'pics/a.png', folder: 'pics', filename: 'a.png', mime: 'image/png', ext: 'png', size: 4, checksum: 'c', derived: { width: 10, height: 10, thumbhash: 'T', variants: [{ name: 'w320', width: 320, height: 240, format: 'webp', mime: 'image/webp', bytes: Buffer.from('v') }] } }),
  existing: undefined, overwrite: false, facts: NO_PIPELINE_CTX, ...over,
})

describe('persistUpload', () => {
  it('writes the original + derivatives and inserts the row (create path)', async () => {
    const driver = createLocalDriver({ dir, baseUrl: '/uploads' })
    const row = await persistUpload(asMediaDb(db), driver, args() as never)
    expect((row as { storageKey: string }).storageKey).toBe('pics/a.png')
    expect(await driver.exists!('pics/a.png')).toBe(true)
    expect(await driver.exists!('pics/a.png-w320.webp')).toBe(true)
  })

  it('overwrite merges FRESH translations at write time, not the pre-I/O snapshot the caller captured', async () => {
    const driver = createLocalDriver({ dir, baseUrl: '/uploads' })
    db.run(sql`INSERT INTO media (storage_key, folder, filename, mime, ext, size, derivatives, translations, created_at, updated_at) VALUES ('pics/a.png','pics','a.png','image/png','png',4,'{}','{"en":{"alt":"original"}}',0,0)`)
    // The caller (index.post.ts) reads `existing` BEFORE the slow driver.put I/O below runs. Simulate a
    // concurrent alt-text PATCH landing during that window by writing straight to the row after the
    // snapshot is taken but before persistUpload's own update.
    const staleExisting = { id: 1, derivatives: {}, translations: { en: { alt: 'original' } } }
    db.run(sql`UPDATE media SET translations = '{"en":{"alt":"edited-during-upload"}}' WHERE storage_key = 'pics/a.png'`)
    await persistUpload(asMediaDb(db), driver, args({ existing: staleExisting, overwrite: true }) as never)
    const row = db.all(sql`SELECT translations FROM media WHERE storage_key = 'pics/a.png'`)[0] as { translations: string }
    expect(JSON.parse(row.translations).en.alt).toBe('edited-during-upload')
  })

  it('cleans up every freshly-written blob when the insert fails (no orphan strands the filename)', async () => {
    const real = createLocalDriver({ dir, baseUrl: '/uploads' })
    const deleted: string[] = []
    const driver: StorageDriver = { ...real, delete: async (k) => { deleted.push(k); await real.delete(k) } }
    // pre-insert a row on the same storageKey so the create INSERT hits the UNIQUE constraint and throws
    db.run(sql`INSERT INTO media (storage_key, folder, filename, mime, ext, size, derivatives, translations, created_at, updated_at) VALUES ('pics/a.png','pics','a.png','image/png','png',4,'{}','{}',0,0)`)
    await expect(persistUpload(asMediaDb(db), driver, args() as never)).rejects.toThrow()
    // both objects written during the attempt were removed, so the filename is reclaimable
    expect(await real.exists!('pics/a.png')).toBe(false)
    expect(await real.exists!('pics/a.png-w320.webp')).toBe(false)
    expect(deleted.sort()).toEqual(['pics/a.png', 'pics/a.png-w320.webp'])
  })
})
