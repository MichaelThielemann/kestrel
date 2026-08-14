import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { emitWrite, clearWriteListeners } from '../../../core/server/utils/write-events'
import { usePublishRuntime, setPublishRuntime } from '../utils/publish/publish-runtime'
import type { Invalidation } from '../utils/publish/invalidation'

/**
 * Exercises the GLUE in zz.publish.ts — reading `output.publishOnSave` off `useRuntimeConfig()`,
 * defaulting it to false, and threading it into `planWrite` inside `registerWriteListener` — not the pure
 * planWrite/classifyWrite/planInvalidation logic itself (already pinned by invalidation.test.ts; not
 * re-mocked here, so this only passes if the real decision + the real wiring agree). `defineNitroPlugin`
 * is faked to a passthrough (mirrors 02.register-media.test.ts / 02.register-relation-populate.test.ts) so
 * the module's default export is the plugin body, callable directly in a node test with no Nitro boot.
 *
 * The publish queue's debounce timer runs under fake timers and is never advanced, so the actual
 * render/prune pass (which needs a live Nitro `localFetch`) never fires; only what reaches the real
 * `queue.enqueue` — spied on the queue instance the plugin actually builds — is asserted.
 */

let db: BetterSQLite3Database
let output: Record<string, unknown>

Object.assign(globalThis, {
  defineNitroPlugin: (fn: () => void) => fn,
  useRuntimeConfig: () => ({ kestrel: { output } }),
  useDb: () => db,
  primaryLocale: () => 'en',
  prefixPrimaryLocale: () => false,
})

const plugin = (await import('./zz.publish')).default as unknown as () => void

const page = { name: 'pages', pageLike: true, status: true }
const pub = (over: Record<string, unknown> = {}) => ({ id: 7, path: '/spk/a', locale: 'en', status: 'published', ...over })

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {}) // the deps-persistence probe warns: no publish_deps table in this bare db
  db = drizzle(new Database(':memory:'))
  output = { driver: 'local', dir: '', publicDir: '/kestrel-no-such-public-dir', auto: true, reconcileMinutes: 0, verbose: false, s3: {} }
  clearWriteListeners()
  setPublishRuntime(null)
})

afterEach(() => {
  clearWriteListeners()
  setPublishRuntime(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Boots the plugin, spies on the REAL queue it built (attached AFTER the boot full-publish enqueue, so
 *  only the write-listener's call is captured), fires one write through the real write-event bus, and
 *  returns exactly what reached `queue.enqueue`. */
function fireWrite(before: Record<string, unknown> | null, after: Record<string, unknown> | null): Invalidation {
  plugin()
  const spy = vi.spyOn(usePublishRuntime()!.queue, 'enqueue')
  emitWrite(page, before, after)
  expect(spy).toHaveBeenCalledTimes(1)
  return spy.mock.calls[0][0]
}

describe('zz.publish plugin — write-listener wiring (output.publishOnSave)', () => {
  it('builds no queue at all when output.auto is off (nothing to wire)', () => {
    output.auto = false
    plugin()
    expect(usePublishRuntime()).toBeNull()
  })

  describe('default (publishOnSave absent → false, ADR-0008)', () => {
    it('a plain content edit to a published record enqueues a NOOP — nothing rendered', () => {
      const inv = fireWrite(pub(), pub({ title: 'edited' }))
      expect(inv).toEqual({ type: 'noop' })
    })

    it('an unpublish of that record still enqueues a real invalidation with a prune', () => {
      const inv = fireWrite(pub({ status: 'published' }), pub({ status: 'draft' }))
      expect(inv).toEqual({ type: 'tags', tags: ['pages', 'pages:7'], render: [], prune: ['/spk/a'] })
    })
  })

  describe('publishOnSave: true (the pre-2.0 escape hatch)', () => {
    it('the same plain content edit enqueues a real render invalidation', () => {
      output.publishOnSave = true
      const inv = fireWrite(pub(), pub({ title: 'edited' }))
      expect(inv).toEqual({ type: 'tags', tags: ['pages', 'pages:7'], render: ['/spk/a'], prune: [] })
    })
  })
})
