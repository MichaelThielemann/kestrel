import { describe, it, expect, beforeEach } from 'vitest'
import { getFieldPopulator, clearFieldPopulators } from '../../../core/server/utils/populate'

let runtime: Record<string, unknown>

// The plugin is a Nitro plugin: its auto-imported helpers are plain globals in a node test.
Object.assign(globalThis, {
  defineNitroPlugin: (fn: unknown) => fn,
  useRuntimeConfig: () => runtime,
  useDb: () => { throw new Error('useDb() reached — the populator must not query a disabled built-in') },
})

const plugin = (await import('./02.register-media')).default as unknown as () => void

beforeEach(() => { clearFieldPopulators(); runtime = { kestrel: {} } })

describe('02.register-media', () => {
  it('registers the media field populator while the built-in is enabled', () => {
    plugin()
    expect(getFieldPopulator('media')).toBeTypeOf('function')
  })

  it('registers nothing when the media built-in is disabled (its table does not exist)', () => {
    runtime.kestrel = { collections: { media: false } }
    plugin()
    expect(getFieldPopulator('media')).toBeUndefined()
  })
})
