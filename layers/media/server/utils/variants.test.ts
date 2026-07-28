import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDb } from '../../../../test/helpers/db'
import type { ResolvedVariant } from '../../../core/server/utils/kestrel-config'
import { resolveActiveVariants, activeVariants, type StoredVariant } from './variants'

const fallback: ResolvedVariant[] = [
  { name: 'w320', width: 320, height: null, fit: 'cover', position: 'centre', formats: ['webp'] },
]
const sv = (o: Partial<StoredVariant> & { name: string; width: number }): StoredVariant => ({
  height: null, fit: 'cover', position: 'centre', formats: ['webp'], ...o,
})

describe('resolveActiveVariants (pure)', () => {
  it('returns the fallback (by reference) when the store is empty/absent', () => {
    expect(resolveActiveVariants(null, fallback)).toBe(fallback)
    expect(resolveActiveVariants(undefined, fallback)).toBe(fallback)
    expect(resolveActiveVariants([], fallback)).toBe(fallback)
  })

  it('returns the stored set, stripped of source/pinned provenance', () => {
    const stored = [sv({ name: 'thumb', width: 320, height: 320, formats: ['webp', 'jpeg'], source: 'scan' })]
    expect(resolveActiveVariants(stored, fallback)).toEqual([
      { name: 'thumb', width: 320, height: 320, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] },
    ])
  })

  it('dedupes by name — a manual/pinned entry wins a collision with a scan entry', () => {
    expect(resolveActiveVariants([
      sv({ name: 'thumb', width: 320, source: 'scan' }),
      sv({ name: 'thumb', width: 999, source: 'manual' }),
    ], fallback)).toEqual([{ name: 'thumb', width: 999, height: null, fit: 'cover', position: 'centre', formats: ['webp'] }])
    // order-independent: pinned wins even when it comes first
    expect(resolveActiveVariants([
      sv({ name: 'hero', width: 1, pinned: true }),
      sv({ name: 'hero', width: 2, source: 'scan' }),
    ], fallback)).toEqual([{ name: 'hero', width: 1, height: null, fit: 'cover', position: 'centre', formats: ['webp'] }])
  })

  it('drops malformed entries (missing name / width < 1) rather than deriving a broken variant', () => {
    const stored = [sv({ name: '', width: 320 }), sv({ name: 'zero', width: 0 }), sv({ name: 'good', width: 100 })]
    expect(resolveActiveVariants(stored, fallback).map((v) => v.name)).toEqual(['good'])
  })

  it('drops a hand-authored name outside the derivative-key charset (space / % / slash)', () => {
    const stored = [
      sv({ name: 'my thumb', width: 100 }), sv({ name: 'a%b', width: 100 }),
      sv({ name: 'a/b', width: 100 }), sv({ name: 'ok_1-2', width: 100 }),
    ]
    expect(resolveActiveVariants(stored, fallback).map((v) => v.name)).toEqual(['ok_1-2'])
  })

  it('coerces a non-positive-integer stored height to null (a bad crop dim never reaches deriveImage)', () => {
    expect(resolveActiveVariants([sv({ name: 'a', width: 320, height: '' as unknown as number })], fallback)[0]!.height).toBeNull()
    expect(resolveActiveVariants([sv({ name: 'b', width: 320, height: 0 })], fallback)[0]!.height).toBeNull()
    expect(resolveActiveVariants([sv({ name: 'c', width: 320, height: 200 })], fallback)[0]!.height).toBe(200) // valid box kept
  })

  it('falls back to cover/centre for an out-of-enum fit/position instead of passing it through to sharp unchecked', () => {
    const stored = [sv({ name: 'bad', width: 320, fit: 'top-left' as never, position: 'top-left' })]
    expect(resolveActiveVariants(stored, fallback)[0]).toMatchObject({ fit: 'cover', position: 'centre' })
    const good = [sv({ name: 'ok', width: 320, fit: 'contain' as never, position: 'north' })]
    expect(resolveActiveVariants(good, fallback)[0]).toMatchObject({ fit: 'contain', position: 'north' })
  })
})

describe('resolveActiveVariants — config presets stay active through narrowing', () => {
  const preset: ResolvedVariant = { name: 'thumb', width: 320, height: 320, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] }
  it('unions config presets with a non-empty (scan) registry so they survive usage-driven narrowing', () => {
    const out = resolveActiveVariants([sv({ name: 'w640', width: 640, source: 'scan' })], fallback, [preset])
    expect(out.map((v) => v.name).sort()).toEqual(['thumb', 'w640'])
    expect(out.find((v) => v.name === 'thumb')).toEqual(preset)
  })
  it('a config preset wins a name collision with a scanned entry', () => {
    expect(resolveActiveVariants([sv({ name: 'thumb', width: 999, source: 'scan' })], fallback, [preset])).toEqual([preset])
  })
  it('empty registry still returns the fallback by reference (already includes presets)', () => {
    expect(resolveActiveVariants([], fallback, [preset])).toBe(fallback)
  })
})

describe('activeVariants (reads the media_settings singleton)', () => {
  function seedTable() {
    const db = createTestDb()
    db.run(sql`CREATE TABLE IF NOT EXISTS media_settings (id integer PRIMARY KEY AUTOINCREMENT, singleton_key text NOT NULL, variants text, created_at integer NOT NULL, updated_at integer NOT NULL)`)
    return db
  }

  it('falls back to the given default when the singleton row is absent', () => {
    const db = seedTable()
    expect(activeVariants(db, fallback)).toBe(fallback)
  })

  it('degrades to the fallback (no throw) when the media_settings table has not been migrated', () => {
    const db = createTestDb() // committed migrations only — no media_settings table
    expect(activeVariants(db, fallback)).toBe(fallback)
  })

  it('reads and resolves the stored variants json when the row is present', () => {
    const db = seedTable()
    const variants = JSON.stringify([
      { name: 'hero', width: 1280, height: null, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'], source: 'scan' },
    ])
    db.run(sql`INSERT INTO media_settings (singleton_key, variants, created_at, updated_at) VALUES ('media_settings', ${variants}, 0, 0)`)
    expect(activeVariants(db, fallback)).toEqual([
      { name: 'hero', width: 1280, height: null, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] },
    ])
  })

  it('keeps config presets active even when the stored registry is a narrowed scan set', () => {
    const db = seedTable()
    const variants = JSON.stringify([{ name: 'w640', width: 640, height: null, fit: 'cover', position: 'centre', formats: ['webp'], source: 'scan' }])
    db.run(sql`INSERT INTO media_settings (singleton_key, variants, created_at, updated_at) VALUES ('media_settings', ${variants}, 0, 0)`)
    const preset: ResolvedVariant = { name: 'thumb', width: 320, height: 320, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] }
    expect(activeVariants(db, fallback, [preset]).map((v) => v.name).sort()).toEqual(['thumb', 'w640'])
  })
})
