import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import { registerCollection, getCollection, allCollections, clearRegistry } from '../../../src/server/utils/registry.js'
import { clearPipelines, registerPipeline } from '../../../src/server/pipeline/registry.js'
import type { BuiltCollection } from '../../../src/index.js'

const fake = (name: string) => ({ name, def: { name } } as unknown as BuiltCollection)

describe('registry', () => {
  beforeEach(() => { clearRegistry(); clearPipelines() })

  it('refuses a collection whose name is already a collection-less pipeline', () => {
    registerPipeline({ name: 'collections', access: { role: 'admin' }, read: true, steps: [{ name: 'a', fn: () => Effect.void }] })
    expect(() => registerCollection(fake('collections'))).toThrowError(/collides with a registered pipeline/)
  })

  it('refuses a collection-less pipeline whose name is already a collection', () => {
    registerCollection(fake('collections'))
    expect(() => registerPipeline({ name: 'collections', access: { role: 'admin' }, read: true, steps: [{ name: 'a', fn: () => Effect.void }] }))
      .toThrowError(/collides with a registered collection/)
  })

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
