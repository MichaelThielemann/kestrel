import { describe, it, expect, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDb } from '../../../../../test/helpers/db.js'
import { recordVariants, collectVariants, clearVariants, saveDiscoveredVariants } from '../../../src/server/utils/variant-capture.js'
import { activeVariants } from '../../../src/server/utils/variants.js'
import type { ResolvedVariant } from '@michaelthielemann/kestrel-core'
import type { MediaDb } from '../../../src/server/db/media-db.js'

function asMediaDb(db: ReturnType<typeof createTestDb>): MediaDb {
  return db as unknown as MediaDb
}

const spec = (name: string, width: number, formats: ('webp' | 'jpeg')[] = ['webp']): ResolvedVariant =>
  ({ name, width, height: null, fit: 'cover', position: 'centre', formats })

beforeEach(() => clearVariants())

describe('variant-capture accumulator', () => {
  it('accumulates declared specs, unioning formats for the same name across usages', () => {
    recordVariants([spec('w320', 320, ['webp']), spec('w640', 640, ['webp'])])
    recordVariants([spec('w320', 320, ['jpeg'])]) // same name, another format
    const found = collectVariants().sort((a, b) => a.width - b.width)
    expect(found).toHaveLength(2)
    expect(found[0]).toMatchObject({ name: 'w320', formats: ['webp', 'jpeg'] })
    expect(found[1]).toMatchObject({ name: 'w640', formats: ['webp'] })
  })

  it('clearVariants empties the accumulator', () => {
    recordVariants([spec('w320', 320)])
    clearVariants()
    expect(collectVariants()).toEqual([])
  })
})

describe('saveDiscoveredVariants (reconcile into media_settings)', () => {
  function seed(variants?: unknown[]) {
    const db = createTestDb()
    db.run(sql`CREATE TABLE IF NOT EXISTS media_settings (id integer PRIMARY KEY AUTOINCREMENT, singleton_key text NOT NULL, variants text, created_at integer NOT NULL, updated_at integer NOT NULL)`)
    if (variants) db.run(sql`INSERT INTO media_settings (singleton_key, variants, created_at, updated_at) VALUES ('media_settings', ${JSON.stringify(variants)}, 0, 0)`)
    return db
  }
  const fallback: ResolvedVariant[] = [spec('config-default', 999)]

  it('writes the discovered set (source:scan) and drains the accumulator', () => {
    const db = seed()
    recordVariants([spec('w320', 320, ['webp', 'jpeg'])])
    saveDiscoveredVariants(db)
    expect(collectVariants()).toEqual([])
    expect(activeVariants(asMediaDb(db), fallback)).toEqual([{ name: 'w320', width: 320, height: null, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] }])
  })

  it('keeps manual/pinned entries and replaces stale scan entries (narrowing)', () => {
    const db = seed([
      { name: 'thumb', width: 100, height: 100, fit: 'cover', position: 'centre', formats: ['webp'], source: 'manual' },
      { name: 'w960', width: 960, height: null, fit: 'cover', position: 'centre', formats: ['webp'], source: 'scan' }, // no longer used
    ])
    recordVariants([spec('w320', 320)]) // the only variant still rendered
    saveDiscoveredVariants(db)
    const names = activeVariants(asMediaDb(db), fallback).map((v) => v.name).sort()
    expect(names).toEqual(['thumb', 'w320']) // manual kept, w960 dropped, w320 added
  })

  it('leaves the registry untouched when nothing was discovered (guards against a capture gap wiping it)', () => {
    const db = seed([{ name: 'w320', width: 320, height: null, fit: 'cover', position: 'centre', formats: ['webp'], source: 'scan' }])
    saveDiscoveredVariants(db) // accumulator empty
    expect(activeVariants(asMediaDb(db), fallback).map((v) => v.name)).toEqual(['w320'])
  })

  it('recovers from a row whose variants column holds the JSON-default object shape `{}` (a PUT that omitted variants), instead of permanently skipping discovery', () => {
    const db = seed([])
    // Overwrite the seeded row's variants with the object-default shape a generic singleton PUT can leave
    // behind (json field type defaults to '{}', not '[]') — reconcileVariants must tolerate this, not throw.
    db.run(sql`UPDATE media_settings SET variants = '{}' WHERE singleton_key = 'media_settings'`)
    recordVariants([spec('w320', 320)])
    saveDiscoveredVariants(db)
    expect(activeVariants(asMediaDb(db), fallback).map((v) => v.name)).toEqual(['w320'])
  })

  it('with { clear: false } keeps the accumulator so repeated calls converge (the generate/prerender topology)', () => {
    const db = seed()
    recordVariants([spec('w320', 320)])
    saveDiscoveredVariants(db, { clear: false })
    expect(collectVariants().map((v) => v.name)).toEqual(['w320']) // NOT drained
    recordVariants([spec('crop-400x300', 400)]) // a later prerendered route declares another
    saveDiscoveredVariants(db, { clear: false })
    // the registry reflects the accumulated union of all prerendered routes so far
    expect(activeVariants(asMediaDb(db), fallback).map((v) => v.name).sort()).toEqual(['crop-400x300', 'w320'])
  })
})
