import { describe, it, expect, afterEach } from 'vitest'
import { getResolvedKestrelConfig, setResolvedKestrelConfig } from '@kestrel/core'
import { mediaCollectionEnabled, requireMediaCollection } from '../../../src/server/utils/media-enabled.js'

const ORIG = getResolvedKestrelConfig()
const stubCollections = (collections: { pages?: boolean; media?: boolean }) => {
  setResolvedKestrelConfig({
    ...getResolvedKestrelConfig(),
    collections: { pages: collections.pages ?? true, media: collections.media ?? true },
  })
}
afterEach(() => { setResolvedKestrelConfig(ORIG) })

describe('mediaCollectionEnabled', () => {
  it('is true by default (no toggles configured)', () => {
    stubCollections({})
    expect(mediaCollectionEnabled()).toBe(true)
    expect(() => requireMediaCollection()).not.toThrow()
  })

  it('is false when the consumer disabled the built-in via kestrel.collections.media', () => {
    stubCollections({ pages: true, media: false })
    expect(mediaCollectionEnabled()).toBe(false)
  })

  it('requireMediaCollection 404s when the built-in is disabled', () => {
    stubCollections({ media: false })
    expect(() => requireMediaCollection()).toThrowError(expect.objectContaining({ statusCode: 404 }))
  })
})
