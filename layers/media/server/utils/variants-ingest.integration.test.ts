import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import sharp from 'sharp'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { createTestDb } from '../../../../test/helpers/db'
import { DEFAULT_IMAGE_POLICY } from '../../../core/server/utils/kestrel-config'
import { activeVariants } from './variants'
import { deriveImage } from './derive'
import { buildMediaValues } from './record'

// The behaviour the upload handler wires up: derive exactly the media_settings registry set (narrow
// generation), falling back to the config ladder when nothing is registered yet. The route itself needs
// the full Nitro context (verified by the maintainer's e2e run); this locks the load-bearing composition.
const makePng = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer()

function seed(variants?: unknown[]): BetterSQLite3Database {
  const db = createTestDb()
  db.run(sql`CREATE TABLE IF NOT EXISTS media_settings (id integer PRIMARY KEY AUTOINCREMENT, singleton_key text NOT NULL, variants text, created_at integer NOT NULL, updated_at integer NOT NULL)`)
  if (variants) db.run(sql`INSERT INTO media_settings (singleton_key, variants, created_at, updated_at) VALUES ('media_settings', ${JSON.stringify(variants)}, 0, 0)`)
  return db
}

async function manifestKeys(db: BetterSQLite3Database): Promise<string[]> {
  const policy = DEFAULT_IMAGE_POLICY
  const derived = await deriveImage(await makePng(800, 600), { ...policy, variants: activeVariants(db, policy.variants) })
  const values = buildMediaValues({ storageKey: 'a/pic.png', folder: 'a', filename: 'pic.png', mime: 'image/png', ext: 'png', size: 1, checksum: 'c', derived })
  return Object.keys(values.derivatives as object).sort()
}

describe('upload derives the registered variant set (narrow generation)', () => {
  it('derives exactly the media_settings registry set (crop × both formats), not the full config ladder', async () => {
    const db = seed([{ name: 'thumb', width: 100, height: 100, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'], source: 'scan' }])
    expect(await manifestKeys(db)).toEqual(['thumb.jpeg', 'thumb.webp'])
  })

  it('falls back to the config default ladder when the registry is empty', async () => {
    expect(await manifestKeys(seed())).toEqual(['w320.webp', 'w640.webp']) // 960+ skipped (> 800)
  })
})
