import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { usePublishRuntime, setPublishRuntime } from '@kestrel/publishing'

/**
 * Exercises what zz.publish.ts still owns directly: building (or not building) the publish runtime off
 * `output.auto`/dev.
 *
 * `defineNitroPlugin` is faked to a passthrough so the module's default export is the plugin body,
 * callable directly in a node test with no Nitro boot.
 */

let db: BetterSQLite3Database
let output: Record<string, unknown>

Object.assign(globalThis, {
  defineNitroPlugin: (fn: () => void) => fn,
  useRuntimeConfig: () => ({ kestrel: { output } }),
  useDb: () => db,
})

const plugin = (await import('./zz.publish')).default as unknown as () => void

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {}) // the deps-persistence probe warns: no publish_deps table in this bare db
  db = drizzle(new Database(':memory:'))
  output = { driver: 'local', dir: '', publicDir: '/kestrel-no-such-public-dir', auto: true, reconcileMinutes: 0, verbose: false, s3: {} }
  setPublishRuntime(null)
})

afterEach(() => {
  setPublishRuntime(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('zz.publish plugin', () => {
  it('builds no queue at all when output.auto is off (nothing to wire)', () => {
    output.auto = false
    plugin()
    expect(usePublishRuntime()).toBeNull()
  })

  it('publishes a runtime (queue + deps) when output.auto is on', () => {
    plugin()
    expect(usePublishRuntime()).not.toBeNull()
  })
})
