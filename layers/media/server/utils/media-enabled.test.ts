import { describe, it, expect, afterEach } from 'vitest'
import { mediaCollectionEnabled, requireMediaCollection } from './media-enabled'

const original = globalThis.useRuntimeConfig
const stubRuntimeConfig = (value: unknown) => {
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => value
}
afterEach(() => { (globalThis as Record<string, unknown>).useRuntimeConfig = original })

describe('mediaCollectionEnabled', () => {
  it('is true by default (no toggles configured)', () => {
    stubRuntimeConfig({ kestrel: {} })
    expect(mediaCollectionEnabled()).toBe(true)
    expect(() => requireMediaCollection()).not.toThrow()
  })

  it('is false when the consumer disabled the built-in via kestrel.collections.media', () => {
    stubRuntimeConfig({ kestrel: { collections: { pages: true, media: false } } })
    expect(mediaCollectionEnabled()).toBe(false)
  })

  it('requireMediaCollection 404s when the built-in is disabled', () => {
    stubRuntimeConfig({ kestrel: { collections: { media: false } } })
    expect(() => requireMediaCollection()).toThrowError(expect.objectContaining({ statusCode: 404 }))
  })
})
