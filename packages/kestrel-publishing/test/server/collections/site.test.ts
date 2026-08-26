import { describe, it, expect } from 'vitest'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import built from '../../../src/server/collections/site.js'
import { collectionEnabled } from '@michaelthielemann/kestrel-core'

const cols = () => getTableConfig(built.table).columns

describe('site singleton', () => {
  it('is a translatable single collection, so its values are per locale', () => {
    expect(built.def.mode).toBe('single')
    expect(built.def.translatable).toBe(true)
    const names = cols().map((c) => c.name)
    expect(names).toContain('singleton_key')
    expect(names).toContain('locale')
  })

  it('stores the media field under its id column', () => {
    expect(cols().map((c) => c.name)).toContain('image_id')
  })

  it('leaves every field optional, so an untouched row emits no head values at all', () => {
    expect(built.insert.safeParse({ singletonKey: 'site', locale: 'en' }).success).toBe(true)
    for (const c of cols()) {
      if (['id', 'singleton_key', 'locale', 'created_at', 'updated_at'].includes(c.name)) continue
      expect(c.notNull, `${c.name} must stay nullable`).toBe(false)
    }
  })

  it('validates the title position against its two choices', () => {
    expect(built.update.safeParse({ titlePosition: 'before' }).success).toBe(true)
    expect(built.update.safeParse({ titlePosition: 'after' }).success).toBe(true)
    expect(built.update.safeParse({ titlePosition: 'AFTER' }).success).toBe(false)
  })

  it('can be switched off by a consumer, like every other built-in', () => {
    expect(collectionEnabled(built.def, { site: false })).toBe(false)
    expect(collectionEnabled(built.def, {})).toBe(true)
  })
})
