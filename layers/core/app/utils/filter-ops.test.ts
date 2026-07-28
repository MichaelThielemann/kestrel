import { describe, it, expect } from 'vitest'
import { fieldFilterKind, OPS_BY_KIND, DEFAULT_OP, META_FILTER_KIND, isFilterOp, opAllowed, type FilterKind } from './filter-ops'
import type { SerializedField } from '../../server/utils/serialize-collection'

// Minimal SerializedField builder (only the fields fieldFilterKind reads matter).
const sf = (type: string, extra: Partial<SerializedField> = {}): SerializedField =>
  ({ type, required: false, translatable: false, unique: false, ...extra })

describe('fieldFilterKind', () => {
  it('maps every built-in field type to its kind (incl. multiple/single/range variants)', () => {
    expect(fieldFilterKind(sf('text'))).toBe('text')
    expect(fieldFilterKind(sf('slug'))).toBe('text')
    expect(fieldFilterKind(sf('richtext'))).toBe('richtext')
    expect(fieldFilterKind(sf('number'))).toBe('number')
    expect(fieldFilterKind(sf('boolean'))).toBe('boolean')
    expect(fieldFilterKind(sf('datetime'))).toBe('datetime')
    expect(fieldFilterKind(sf('datetime', { options: { range: true } }))).toBe(null) // range → JSON, not filterable
    expect(fieldFilterKind(sf('choice', { options: { multiple: false } }))).toBe('enum')
    expect(fieldFilterKind(sf('choice', { options: { multiple: true } }))).toBe('stringSet')
    expect(fieldFilterKind(sf('relation', { single: true }))).toBe('ref')
    expect(fieldFilterKind(sf('relation'))).toBe('idSet') // many-relation (no `single` flag)
    expect(fieldFilterKind(sf('media', { single: true }))).toBe('ref')
    expect(fieldFilterKind(sf('media'))).toBe('idSet') // multiple media
    expect(fieldFilterKind(sf('link'))).toBe(null)
    expect(fieldFilterKind(sf('json'))).toBe(null)
    expect(fieldFilterKind(sf('repeater'))).toBe(null)
  })

  it('falls back to text for an unknown consumer field type', () => {
    expect(fieldFilterKind(sf('color'))).toBe('text')
    expect(fieldFilterKind(sf('rating'))).toBe('text')
  })
})

describe('OPS_BY_KIND / opAllowed', () => {
  it('number + datetime allow the full comparison set', () => {
    for (const k of ['number', 'datetime'] as FilterKind[]) {
      expect(OPS_BY_KIND[k]).toEqual(['eq', 'ne', 'lt', 'lte', 'gt', 'gte'])
    }
  })

  it('text allows eq/ne/contains; richtext only contains; ref/boolean/enum only eq/ne', () => {
    expect(OPS_BY_KIND.text).toEqual(['eq', 'ne', 'contains'])
    expect(OPS_BY_KIND.richtext).toEqual(['contains'])
    expect(OPS_BY_KIND.boolean).toEqual(['eq', 'ne'])
    expect(OPS_BY_KIND.enum).toEqual(['eq', 'ne'])
    expect(OPS_BY_KIND.ref).toEqual(['eq', 'ne'])
  })

  it('stringSet + idSet allow only contains/notContains', () => {
    expect(OPS_BY_KIND.stringSet).toEqual(['contains', 'notContains'])
    expect(OPS_BY_KIND.idSet).toEqual(['contains', 'notContains'])
  })

  it('opAllowed reflects the table', () => {
    expect(opAllowed('number', 'lt')).toBe(true)
    expect(opAllowed('text', 'lt')).toBe(false)
    expect(opAllowed('text', 'contains')).toBe(true)
    expect(opAllowed('richtext', 'eq')).toBe(false)
    expect(opAllowed('stringSet', 'contains')).toBe(true)
    expect(opAllowed('stringSet', 'eq')).toBe(false)
    expect(opAllowed('ref', 'gt')).toBe(false)
  })
})

describe('DEFAULT_OP', () => {
  it('is eq for equality/comparison kinds and contains for the substring/membership kinds', () => {
    expect(DEFAULT_OP.text).toBe('eq')
    expect(DEFAULT_OP.number).toBe('eq')
    expect(DEFAULT_OP.datetime).toBe('gte') // eq never matches a ms timestamp — "on or after" is the useful default
    expect(DEFAULT_OP.boolean).toBe('eq')
    expect(DEFAULT_OP.enum).toBe('eq')
    expect(DEFAULT_OP.ref).toBe('eq')
    expect(DEFAULT_OP.richtext).toBe('contains')
    expect(DEFAULT_OP.stringSet).toBe('contains')
    expect(DEFAULT_OP.idSet).toBe('contains')
  })

  it('every default op is itself allowed for its kind', () => {
    for (const kind of Object.keys(DEFAULT_OP) as FilterKind[]) {
      expect(opAllowed(kind, DEFAULT_OP[kind])).toBe(true)
    }
  })
})

describe('isFilterOp', () => {
  it('accepts the known operator tokens and rejects everything else', () => {
    for (const op of ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'notContains']) expect(isFilterOp(op)).toBe(true)
    expect(isFilterOp('bogus')).toBe(false)
    expect(isFilterOp('__proto__')).toBe(false)
    expect(isFilterOp('')).toBe(false)
  })
})

describe('META_FILTER_KIND', () => {
  it('maps each filterable meta column to its kind', () => {
    expect(META_FILTER_KIND).toEqual({ id: 'number', path: 'text', status: 'enum', createdAt: 'datetime', updatedAt: 'datetime' })
  })
})
