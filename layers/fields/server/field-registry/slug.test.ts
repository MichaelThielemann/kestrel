import { describe, it, expect } from 'vitest'
import { getFieldType } from './index'
import type { FieldDef } from '../../../core/server/utils/defineCollection'

const slug = getFieldType('slug')
const def = { type: 'slug', options: { from: 'title' } } as unknown as FieldDef
const t = (value: unknown, record: Record<string, unknown>) => slug.transform!(value, record, def)

describe('slug field type — write transform', () => {
  it('slugifies an explicit value', () => {
    expect(t('My Cool Slug!', {})).toBe('my-cool-slug')
    expect(t('  Über Café  ', {})).toBe('uber-cafe')
  })

  it('derives from options.from when the value is blank', () => {
    expect(t('', { title: 'Hochzeit Müller' })).toBe('hochzeit-muller') // NFKD folds ü→u (no ue transliteration)
    expect(t(undefined, { title: 'Hello World' })).toBe('hello-world')
    expect(t(null, { title: 'A/B & C' })).toBe('a-b-c')
  })

  it('explicit value wins over the source', () => {
    expect(t('custom', { title: 'Ignored Title' })).toBe('custom')
  })

  it('leaves the value as-is when blank and the source is empty/missing', () => {
    expect(t('', {})).toBe('') // no source field present
    expect(t(null, { title: '' })).toBeNull() // empty source → keep the original value
  })

  it('still exposes column + validator like a normal text-backed type', () => {
    expect(slug.column).toBeTypeOf('function')
    expect(slug.validator).toBeTypeOf('function')
  })
})
