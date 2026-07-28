import { describe, it, expect } from 'vitest'
import { deadBlockIds, deadFieldsAt, type DeadRef } from './dead-refs'

const refs: DeadRef[] = [
  { field: 'author', collection: 'users', id: 1, reason: 'missing' },
  { field: 'cta', blockId: 'b1', collection: 'pages', id: 2, reason: 'unpublished' },
  { field: 'img', blockId: 'b1', collection: 'media', id: 3, reason: 'missing' },
  { field: 'ref', blockId: 'b2', collection: 'posts', id: 4, reason: 'missing' },
]

describe('deadBlockIds', () => {
  it('collects the distinct block ids that directly hold a dead ref (root refs excluded)', () => {
    expect([...deadBlockIds(refs)].sort()).toEqual(['b1', 'b2'])
  })
  it('is empty when nothing is dead', () => {
    expect(deadBlockIds([]).size).toBe(0)
  })
})

describe('deadFieldsAt', () => {
  it('returns the root field keys for blockId=null', () => {
    expect([...deadFieldsAt(refs, null)]).toEqual(['author'])
  })
  it('returns a given block\'s dead field keys', () => {
    expect([...deadFieldsAt(refs, 'b1')].sort()).toEqual(['cta', 'img'])
    expect([...deadFieldsAt(refs, 'b2')]).toEqual(['ref'])
  })
  it('is empty for a block with no dead refs', () => {
    expect(deadFieldsAt(refs, 'b3').size).toBe(0)
  })
})
