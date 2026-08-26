import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import sharp from 'sharp'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from '../../../../../test/helpers/db.js'
import { createLocalDriver, DEFAULT_IMAGE_POLICY  } from '@michaelthielemann/kestrel-core'
import { parseVariantName, deriveOnDemand, variantKeyFromPath } from '../../../src/server/utils/ondemand.js'
import type { MediaDb } from '../../../src/server/db/media-db.js'

function asMediaDb(db: ReturnType<typeof createTestDb>): MediaDb {
  return db as unknown as MediaDb
}

describe('variantKeyFromPath', () => {
  it('reads the storage key out of a request under the media base URL', () => {
    expect(variantKeyFromPath('/uploads/photos/sunset-w400.webp', '/uploads')).toBe('photos/sunset-w400.webp')
  })

  it('honours a configured base URL, and ignores the default one when another is configured', () => {
    expect(variantKeyFromPath('/assets/sunset-w400.webp', '/assets')).toBe('sunset-w400.webp')
    expect(variantKeyFromPath('/uploads/sunset-w400.webp', '/assets')).toBeNull()
  })

  it('falls back to /uploads when no base URL is configured', () => {
    expect(variantKeyFromPath('/uploads/sunset-w400.webp', undefined)).toBe('sunset-w400.webp')
  })

  // An empty base would strip to '' and make every dev GET a media request, each miss paying a derive attempt.
  it('treats an empty base URL as unconfigured rather than as "match everything"', () => {
    expect(variantKeyFromPath('/uploads/sunset-w400.webp', '')).toBe('sunset-w400.webp')
    expect(variantKeyFromPath('/some/page', '')).toBeNull()
  })

  it('tolerates a trailing slash on the configured base URL', () => {
    expect(variantKeyFromPath('/assets/sunset-w400.webp', '/assets/')).toBe('sunset-w400.webp')
  })

  it('decodes the key and drops the query string', () => {
    expect(variantKeyFromPath('/uploads/my%20folder/a-w400.webp?v=2', '/uploads')).toBe('my folder/a-w400.webp')
  })

  it('rejects a path outside the base and a malformed escape', () => {
    expect(variantKeyFromPath('/other/sunset-w400.webp', '/uploads')).toBeNull()
    expect(variantKeyFromPath('/uploads', '/uploads')).toBeNull()
    expect(variantKeyFromPath('/uploads/%E0%A4%A.webp', '/uploads')).toBeNull()
  })
})

describe('parseVariantName', () => {
  it('parses w<width> and c<w>x<h>[-fit]; rejects a bad fit / a named preset', () => {
    expect(parseVariantName('w320')).toEqual({ width: 320, height: null, fit: 'cover' })
    expect(parseVariantName('c320x320')).toEqual({ width: 320, height: 320, fit: 'cover' })
    expect(parseVariantName('c400x300-contain')).toEqual({ width: 400, height: 300, fit: 'contain' })
    expect(parseVariantName('c1x1-nope')).toBeNull()
    expect(parseVariantName('thumb')).toBeNull()
  })
})

describe('deriveOnDemand (dev miss → derive from the original, registry-independent)', () => {
  it('derives a missing jpeg variant for an existing media and caches it; refuses unresolvable keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-ondemand-'))
    try {
      const db = createTestDb()
      const driver = createLocalDriver({ dir, baseUrl: '/uploads' })
      const original = await sharp({ create: { width: 800, height: 600, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer()
      await driver.put('a/pic.png', original, 'image/png')
      db.run(sql`INSERT INTO media (storage_key, filename, mime, ext, size, width, height, derivatives, translations, created_at, updated_at) VALUES ('a/pic.png','pic.png','image/png','png',${original.length},800,600,'{}','{}',0,0)`)

      const r = await deriveOnDemand(asMediaDb(db), driver, DEFAULT_IMAGE_POLICY, 'a/pic.png-w320.jpeg')
      expect(r?.mime).toBe('image/jpeg')
      expect(await driver.exists!('a/pic.png-w320.jpeg')).toBe(true)

      expect(await deriveOnDemand(asMediaDb(db), driver, DEFAULT_IMAGE_POLICY, 'a/pic.png-thumb.jpeg')).toBeNull() // name not parseable
      expect(await deriveOnDemand(asMediaDb(db), driver, DEFAULT_IMAGE_POLICY, 'a/missing.png-w320.jpeg')).toBeNull() // no such original
      expect(await deriveOnDemand(asMediaDb(db), driver, DEFAULT_IMAGE_POLICY, 'a/pic.png-w320.avif')).toBeNull() // unsupported format
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
