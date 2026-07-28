import { describe, it, expect, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { create, update } from './crud'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { defineCollection } from './defineCollection'
import { createTestDb } from '../../../../test/helpers/db'
import { desiredSchema } from '../schema/desired'
import { diffSchema } from '../schema/diff'
import { renderSqlite } from '../schema/render-sqlite'

// A `unique` slug auto-derived from `title`: a duplicate is a HARD, field-scoped error (Pruvious-style,
// no silent dedup) so the editor must pick a different slug.
const galleries = buildCollection(defineCollection({
  name: 'gal',
  mode: 'multi',
  fields: {
    title: { type: 'text', required: true },
    slug: { type: 'slug', unique: true, options: { from: 'title' } },
  },
}))

// A 400 whose `data` carries the field-keyed issues the editor maps onto the slug widget.
const expectSlugConflict = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    const err = e as { statusCode?: number; data?: { path: string[]; message: string }[] }
    expect(err.statusCode).toBe(400)
    expect(err.data?.[0]?.path).toEqual(['slug'])
    expect(err.data?.[0]?.message).toMatch(/already exists/i)
    return
  }
  throw new Error('expected a slug-conflict error, but none was thrown')
}

let db: ReturnType<typeof createTestDb>
beforeEach(() => {
  db = createTestDb()
  for (const stmt of renderSqlite(diffSchema(desiredSchema([galleries.table]), {}))) db.run(sql.raw(stmt))
})

describe('crud — unique slug (hard error, no silent dedup)', () => {
  it('CREATE: a duplicate derived slug is rejected with a field-scoped 400', () => {
    const a = create(db, galleries, { title: 'Wedding' }) as Record<string, unknown>
    expect(a.slug).toBe('wedding')
    expectSlugConflict(() => create(db, galleries, { title: 'Wedding' }))
  })

  it('CREATE: an explicit colliding slug is rejected too', () => {
    create(db, galleries, { title: 'A', slug: 'shared' })
    expectSlugConflict(() => create(db, galleries, { title: 'B', slug: 'shared' }))
  })

  it('CREATE: distinct titles keep their own un-suffixed slug', () => {
    const a = create(db, galleries, { title: 'Wedding' }) as Record<string, unknown>
    const b = create(db, galleries, { title: 'Birthday' }) as Record<string, unknown>
    expect(a.slug).toBe('wedding')
    expect(b.slug).toBe('birthday')
  })

  it('UPDATE: re-saving a row with its own slug is NOT a collision (excludes self)', () => {
    const a = create(db, galleries, { title: 'Wedding' }) as Record<string, unknown>
    const again = update(db, galleries, a.id as number, { slug: 'wedding' }) as Record<string, unknown>
    expect(again.slug).toBe('wedding')
  })

  it('UPDATE: changing a slug to one another row holds is rejected', () => {
    create(db, galleries, { title: 'Wedding' }) // owns "wedding"
    const b = create(db, galleries, { title: 'Birthday' }) as Record<string, unknown>
    expectSlugConflict(() => update(db, galleries, b.id as number, { slug: 'wedding' }))
  })
})
