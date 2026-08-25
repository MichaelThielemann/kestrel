import { describe, it, expect } from 'vitest'
import { escapeLike } from '../../../src/server/utils/sql.js'

describe('escapeLike', () => {
  it('escapes LIKE metacharacters so they match literally (paired with ESCAPE \\)', () => {
    expect(escapeLike('a_b')).toBe('a\\_b')
    expect(escapeLike('50%')).toBe('50\\%')
    expect(escapeLike('a\\b')).toBe('a\\\\b')
    expect(escapeLike('%_\\')).toBe('\\%\\_\\\\')
  })
  it('leaves plain strings untouched', () => {
    expect(escapeLike('plain text')).toBe('plain text')
  })
})
