import { describe, it, expect } from 'vitest'
import { toSnakeCase, resolveColumnName } from './naming'
import type { FieldDef } from '../../../core/server/utils/defineCollection'

describe('toSnakeCase', () => {
  it('camelCase → snake_case', () => {
    expect(toSnakeCase('title')).toBe('title')
    expect(toSnakeCase('heroImage')).toBe('hero_image')
  })
})

describe('resolveColumnName', () => {
  it('plain field keeps its key', () => {
    expect(resolveColumnName('title', { type: 'text' } as FieldDef)).toEqual({ jsKey: 'title', dbName: 'title' })
  })
  it('single relation / media (single) → <name>Id', () => {
    expect(resolveColumnName('author', { type: 'relation', relation: { collection: 'users' } } as FieldDef))
      .toEqual({ jsKey: 'authorId', dbName: 'author_id' })
    expect(resolveColumnName('cover', { type: 'media' } as FieldDef))
      .toEqual({ jsKey: 'coverId', dbName: 'cover_id' })
  })
  it('many relation / media (multiple) stay under the field name (json)', () => {
    expect(resolveColumnName('tags', { type: 'relation', relation: { collection: 't', many: true } } as FieldDef))
      .toEqual({ jsKey: 'tags', dbName: 'tags' })
    expect(resolveColumnName('gallery', { type: 'media', options: { multiple: true } } as FieldDef))
      .toEqual({ jsKey: 'gallery', dbName: 'gallery' })
  })
})
