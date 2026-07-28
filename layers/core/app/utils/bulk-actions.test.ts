import { describe, it, expect } from 'vitest'
import { BULK_ACTIONS, isBulkAction } from './bulk-actions'

describe('isBulkAction', () => {
  it('accepts exactly the four known actions', () => {
    for (const a of BULK_ACTIONS) expect(isBulkAction(a)).toBe(true)
    expect(BULK_ACTIONS).toEqual(['delete', 'publish', 'unpublish', 'duplicate'])
  })
  it('rejects unknown strings and non-strings (→ the handler 400s)', () => {
    for (const bad of ['', 'DELETE', 'remove', 'drop', 'nope']) expect(isBulkAction(bad)).toBe(false)
    for (const bad of [undefined, null, 0, {}, [], true]) expect(isBulkAction(bad)).toBe(false)
  })
  it('is prototype-safe (no inherited property is treated as an action)', () => {
    expect(isBulkAction('toString')).toBe(false)
    expect(isBulkAction('constructor')).toBe(false)
  })
})
