import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getFieldPopulator, clearFieldPopulators, getResolvedKestrelConfig, setResolvedKestrelConfig, resolveKestrel } from '@michaelthielemann/kestrel-core'

// The plugin is a Nitro plugin: its auto-imported helpers are plain globals in a node test.
Object.assign(globalThis, {
  defineNitroPlugin: (fn: unknown) => fn,
  useDb: () => { throw new Error('useDb() reached — the populator must not query a disabled built-in') },
})

const plugin = (await import('./02.register-media')).default as unknown as () => void

const ORIG_CONFIG = getResolvedKestrelConfig()
beforeEach(() => {
  clearFieldPopulators()
  setResolvedKestrelConfig(resolveKestrel({}, process.env, process.cwd()))
})
afterEach(() => { setResolvedKestrelConfig(ORIG_CONFIG) })

describe('02.register-media', () => {
  it('registers the media field populator while the built-in is enabled', () => {
    plugin()
    expect(getFieldPopulator('media')).toBeTypeOf('function')
  })

  it('registers nothing when the media built-in is disabled (its table does not exist)', () => {
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), collections: { pages: true, media: false } })
    plugin()
    expect(getFieldPopulator('media')).toBeUndefined()
  })
})
