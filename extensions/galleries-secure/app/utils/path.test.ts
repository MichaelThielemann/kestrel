import { describe, it, expect } from 'vitest'
import { segments, joinFolder, parentFolder, isUnder, childFolders } from './path'

describe('gallery path helpers', () => {
  it('segments cleans + splits', () => {
    expect(segments('/a//b/')).toEqual(['a', 'b'])
    expect(segments('')).toEqual([])
    expect(segments('a')).toEqual(['a'])
  })

  it('joinFolder drops empties', () => {
    expect(joinFolder('a', '', 'b/c')).toBe('a/b/c')
    expect(joinFolder('/x/', 'y')).toBe('x/y')
    expect(joinFolder('')).toBe('')
  })

  it('parentFolder', () => {
    expect(parentFolder('')).toBeNull()
    expect(parentFolder('a')).toBe('')
    expect(parentFolder('a/b')).toBe('a')
  })

  it('isUnder (no prefix-collision)', () => {
    expect(isUnder('a/b', 'a')).toBe(true)
    expect(isUnder('a', 'a')).toBe(true)
    expect(isUnder('ab', 'a')).toBe(false)
    expect(isUnder('anything', '')).toBe(true)
  })

  it('childFolders: immediate children, ancestors synthesized from file dirs, sorted', () => {
    // root children from an explicit empty folder + files nested deeper
    expect(childFolders('', ['Trauung'], ['Party/Tag1', 'Trauung'])).toEqual(['Party', 'Trauung'])
    // immediate children of "Party"
    expect(childFolders('Party', [], ['Party/Tag1', 'Party/Tag2/x'])).toEqual(['Party/Tag1', 'Party/Tag2'])
    // prefix-collision sibling is not a child
    expect(childFolders('a', ['ab', 'a/b'], [])).toEqual(['a/b'])
  })
})
