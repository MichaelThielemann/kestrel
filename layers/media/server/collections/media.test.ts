import { describe, it, expect } from 'vitest'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import built from './media'

describe('media collection', () => {
  it('is a non-localized multi collection (no locale/translation_group)', () => {
    expect(built.def.mode).toBe('multi')
    expect(built.def.translatable).toBe(false)
    const names = getTableConfig(built.table).columns.map((c) => c.name)
    expect(names).not.toContain('locale')
    expect(names).not.toContain('translation_group')
    expect(names).toEqual(expect.arrayContaining(['id', 'storage_key', 'folder', 'mime', 'derivatives', 'translations', 'created_at', 'updated_at']))
  })
  it('insert requires storageKey/filename/mime/ext/size; accepts a bare valid row', () => {
    expect(built.insert.safeParse({ storageKey: 'a/b.webp', filename: 'b.webp', mime: 'image/webp', ext: 'webp', size: 10 }).success).toBe(true)
    expect(built.insert.safeParse({ filename: 'b.webp' }).success).toBe(false)
  })
})
