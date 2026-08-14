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

  describe('EU AI Act disclosure columns', () => {
    const validRow = { storageKey: 'a/b.webp', filename: 'b.webp', mime: 'image/webp', ext: 'webp', size: 10 }

    it('adds nullable ai_source_type / ai_note columns', () => {
      const columns = getTableConfig(built.table).columns
      const byName = Object.fromEntries(columns.map((c) => [c.name, c]))
      expect(Object.keys(byName)).toEqual(expect.arrayContaining(['ai_source_type', 'ai_note']))
      expect(byName.ai_source_type!.notNull).toBe(false)
      expect(byName.ai_note!.notNull).toBe(false)
    })

    it('accepts the disclosure vocabulary, rejects an unknown value, and stays optional', () => {
      expect(built.insert.safeParse({ ...validRow, aiSourceType: 'trainedAlgorithmicMedia' }).success).toBe(true)
      expect(built.insert.safeParse({ ...validRow, aiSourceType: 'compositeWithTrainedAlgorithmicMedia' }).success).toBe(true)
      expect(built.insert.safeParse({ ...validRow, aiSourceType: 'algorithmicallyEnhanced', aiNote: 'upscaled' }).success).toBe(true)
      expect(built.insert.safeParse({ ...validRow, aiSourceType: 'not-a-real-value' }).success).toBe(false)
      expect(built.insert.safeParse(validRow).success).toBe(true)
    })
  })
})
