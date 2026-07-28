import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerCollection, getCollection, allCollections, clearRegistry } from './registry'
import type { BuiltCollection } from './collection-types'

const fake = (name: string) => ({ name, def: { name } } as unknown as BuiltCollection)

describe('registry', () => {
  beforeEach(() => clearRegistry())

  it('registers and retrieves by name', () => {
    registerCollection(fake('pages'))
    expect(getCollection('pages')?.name).toBe('pages')
  })

  it('returns undefined for unknown names', () => {
    expect(getCollection('nope')).toBeUndefined()
  })

  it('lists all registered collections', () => {
    registerCollection(fake('pages'))
    registerCollection(fake('posts'))
    expect(allCollections().map((c) => c.name).sort()).toEqual(['pages', 'posts'])
  })

  it('warns on a name collision but lets the later definition win', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerCollection(fake('pages'))
    registerCollection(fake('pages'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"pages" is registered more than once'))
    expect(allCollections()).toHaveLength(1)
    warn.mockRestore()
  })
})
