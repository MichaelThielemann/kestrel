import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDb } from '../../../../../test/helpers/db.js'
import type { ResolvedVariant } from '@kestrel/core'
import { resolveActiveVariants, activeVariants, type StoredVariant } from '../../../src/server/utils/variants.js'
import type { MediaDb } from '../../../src/server/db/media-db.js'

function asMediaDb(db: ReturnType<typeof createTestDb>): MediaDb {
  return db as unknown as MediaDb
}

const fallback: ResolvedVariant[] = [
  { name: 'w320', width: 320, height: null, fit: 'cover', position: 'centre', formats: ['webp'] },
]
const sv = (o: Partial<StoredVariant> & { name: string; width: number }): StoredVariant => ({
  height: null, fit: 'cover', position: 'centre', formats: ['webp'], ...o,
})

describe('resolveActiveVariants (pure)', () => {
  it('returns the fallback (by reference) when the store is empty/absent', () => {
    expect(resolveActiveVariants(null, fallback).specs).toBe(fallback)
    expect(resolveActiveVariants(undefined, fallback).specs).toBe(fallback)
    expect(resolveActiveVariants([], fallback).specs).toBe(fallback)
  })

  it('returns the stored set, stripped of source/pinned provenance', () => {
    const stored = [sv({ name: 'thumb', width: 320, height: 320, formats: ['webp', 'jpeg'], source: 'scan' })]
    expect(resolveActiveVariants(stored, fallback).specs).toEqual([
      { name: 'thumb', width: 320, height: 320, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] },
    ])
  })

  it('dedupes by name — a manual/pinned entry wins a collision with a scan entry', () => {
    expect(resolveActiveVariants([
      sv({ name: 'thumb', width: 320, source: 'scan' }),
      sv({ name: 'thumb', width: 999, source: 'manual' }),
    ], fallback).specs).toEqual([{ name: 'thumb', width: 999, height: null, fit: 'cover', position: 'centre', formats: ['webp'] }])
    // order-independent: pinned wins even when it comes first
    expect(resolveActiveVariants([
      sv({ name: 'hero', width: 1, pinned: true }),
      sv({ name: 'hero', width: 2, source: 'scan' }),
    ], fallback).specs).toEqual([{ name: 'hero', width: 1, height: null, fit: 'cover', position: 'centre', formats: ['webp'] }])
  })

  it('drops malformed entries (missing name / width < 1) rather than deriving a broken variant', () => {
    const stored = [sv({ name: '', width: 320 }), sv({ name: 'zero', width: 0 }), sv({ name: 'good', width: 100 })]
    expect(resolveActiveVariants(stored, fallback).specs.map((v) => v.name)).toEqual(['good'])
  })

  it('drops a hand-authored name outside the derivative-key charset (space / % / slash)', () => {
    const stored = [
      sv({ name: 'my thumb', width: 100 }), sv({ name: 'a%b', width: 100 }),
      sv({ name: 'a/b', width: 100 }), sv({ name: 'ok_1-2', width: 100 }),
    ]
    expect(resolveActiveVariants(stored, fallback).specs.map((v) => v.name)).toEqual(['ok_1-2'])
  })

  it('coerces a non-positive-integer stored height to null (a bad crop dim never reaches deriveImage)', () => {
    expect(resolveActiveVariants([sv({ name: 'a', width: 320, height: '' as unknown as number })], fallback).specs[0]!.height).toBeNull()
    expect(resolveActiveVariants([sv({ name: 'b', width: 320, height: 0 })], fallback).specs[0]!.height).toBeNull()
    expect(resolveActiveVariants([sv({ name: 'c', width: 320, height: 200 })], fallback).specs[0]!.height).toBe(200) // valid box kept
  })

  it('falls back to cover/centre for an out-of-enum fit/position instead of passing it through to sharp unchecked', () => {
    const stored = [sv({ name: 'bad', width: 320, fit: 'top-left' as never, position: 'top-left' })]
    expect(resolveActiveVariants(stored, fallback).specs[0]).toMatchObject({ fit: 'cover', position: 'centre' })
    const good = [sv({ name: 'ok', width: 320, fit: 'contain' as never, position: 'north' })]
    expect(resolveActiveVariants(good, fallback).specs[0]).toMatchObject({ fit: 'contain', position: 'north' })
  })
})

describe('resolveActiveVariants — config presets stay active through narrowing', () => {
  const preset: ResolvedVariant = { name: 'thumb', width: 320, height: 320, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] }
  it('unions config presets with a non-empty (scan) registry so they survive usage-driven narrowing', () => {
    const out = resolveActiveVariants([sv({ name: 'w640', width: 640, source: 'scan' })], fallback, [preset]).specs
    expect(out.map((v) => v.name).sort()).toEqual(['thumb', 'w640'])
    expect(out.find((v) => v.name === 'thumb')).toEqual(preset)
  })
  it('a config preset wins a name collision with a scanned entry', () => {
    expect(resolveActiveVariants([sv({ name: 'thumb', width: 999, source: 'scan' })], fallback, [preset]).specs).toEqual([preset])
  })
  it('empty registry still returns the fallback by reference (already includes presets)', () => {
    expect(resolveActiveVariants([], fallback, [preset]).specs).toBe(fallback)
  })
})

describe('resolveActiveVariants — the fromRegistry verdict (what a caller may delete against)', () => {
  const preset: ResolvedVariant = { name: 'thumb', width: 320, height: 320, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] }

  it('reports fromRegistry for a set built out of validated stored entries', () => {
    expect(resolveActiveVariants([sv({ name: 'w640', width: 640, source: 'scan' })], fallback).fromRegistry).toBe(true)
  })

  it('reports a fallback for an unread or empty registry', () => {
    expect(resolveActiveVariants(null, fallback).fromRegistry).toBe(false)
    expect(resolveActiveVariants(undefined, fallback).fromRegistry).toBe(false)
    expect(resolveActiveVariants([], fallback).fromRegistry).toBe(false)
  })

  it('reports a fallback when every stored entry is rejected — a rejected registry is not a narrowed one', () => {
    const out = resolveActiveVariants([sv({ name: 'a/b', width: 100 }), sv({ name: 'ok', width: '400' as unknown as number })], fallback)
    expect(out.specs).toBe(fallback)
    expect(out.fromRegistry).toBe(false)
  })

  it('a config preset never makes a rejected registry look registered', () => {
    expect(resolveActiveVariants([sv({ name: 'a/b', width: 100 })], fallback, [preset]).fromRegistry).toBe(false)
  })
})

describe('activeVariants (reads the media_settings singleton)', () => {
  it('falls back to the given default when the singleton row is absent', () => {
    expect(activeVariants(asMediaDb(createTestDb()), fallback)).toBe(fallback)
  })

  it('degrades to the fallback (no throw) when the media_settings table has not been migrated', () => {
    const db = createTestDb()
    db.run(sql`DROP TABLE media_settings`)
    expect(activeVariants(asMediaDb(db), fallback)).toBe(fallback)
  })

  it('reads and resolves the stored variants json when the row is present', () => {
    const db = createTestDb()
    const variants = JSON.stringify([
      { name: 'hero', width: 1280, height: null, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'], source: 'scan' },
    ])
    db.run(sql`INSERT INTO media_settings (singleton_key, variants, created_at, updated_at) VALUES ('media_settings', ${variants}, 0, 0)`)
    expect(activeVariants(asMediaDb(db), fallback)).toEqual([
      { name: 'hero', width: 1280, height: null, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] },
    ])
  })

  it('keeps config presets active even when the stored registry is a narrowed scan set', () => {
    const db = createTestDb()
    const variants = JSON.stringify([{ name: 'w640', width: 640, height: null, fit: 'cover', position: 'centre', formats: ['webp'], source: 'scan' }])
    db.run(sql`INSERT INTO media_settings (singleton_key, variants, created_at, updated_at) VALUES ('media_settings', ${variants}, 0, 0)`)
    const preset: ResolvedVariant = { name: 'thumb', width: 320, height: 320, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] }
    expect(activeVariants(asMediaDb(db), fallback, [preset]).map((v) => v.name).sort()).toEqual(['thumb', 'w640'])
  })
})
