import { describe, it, expect } from 'vitest'
import { jsKey } from './field-keys'
import type { SerializedField } from '../../../core/server/utils/serialize-collection'

function f(partial: Partial<SerializedField> & Pick<SerializedField, 'type'>): SerializedField {
  return { required: false, translatable: false, unique: false, ...partial }
}

describe('jsKey', () => {
  it('suffixes a field the server marked `single` with Id', () => {
    expect(jsKey('author', f({ type: 'relation', single: true }))).toBe('authorId')
    expect(jsKey('cover', f({ type: 'media', single: true }))).toBe('coverId')
  })

  it('keeps the field name when not single (many relation, multiple media, scalars)', () => {
    expect(jsKey('tags', f({ type: 'relation' }))).toBe('tags')
    expect(jsKey('gallery', f({ type: 'media' }))).toBe('gallery')
    expect(jsKey('title', f({ type: 'text' }))).toBe('title')
    expect(jsKey('data', f({ type: 'json' }))).toBe('data')
  })
})
