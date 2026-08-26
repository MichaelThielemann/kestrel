import { describe, it, expect, vi, beforeEach } from 'vitest'

const getCollection = vi.fn()
const select = vi.fn()

vi.mock('@michaelthielemann/kestrel-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@michaelthielemann/kestrel-core')>()
  return { ...actual, getCollection: (...args: unknown[]) => getCollection(...args), useDb: () => ({ select }) }
})

describe('liveRedirectFor / invalidateLiveRedirects', () => {
  beforeEach(() => {
    getCollection.mockReset().mockReturnValue(undefined)
    select.mockReset()
    vi.resetModules()
  })

  it('returns null (no match) when the redirects collection is not registered', async () => {
    const { liveRedirectFor } = await import('../../src/server/redirects.js')
    expect(liveRedirectFor('/anything')).toBeNull()
  })

  it('compiles from the DB only once, then serves subsequent lookups from cache', async () => {
    getCollection.mockReturnValue(undefined)
    const { liveRedirectFor } = await import('../../src/server/redirects.js')
    liveRedirectFor('/a')
    liveRedirectFor('/b')
    liveRedirectFor('/c')
    expect(getCollection).toHaveBeenCalledTimes(1)
  })

  it('invalidateLiveRedirects drops the cache, forcing the next lookup to recompile', async () => {
    getCollection.mockReturnValue(undefined)
    const { liveRedirectFor, invalidateLiveRedirects } = await import('../../src/server/redirects.js')
    liveRedirectFor('/a')
    expect(getCollection).toHaveBeenCalledTimes(1)
    invalidateLiveRedirects()
    liveRedirectFor('/b')
    expect(getCollection).toHaveBeenCalledTimes(2)
  })
})
