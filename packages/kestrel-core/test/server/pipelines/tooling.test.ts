import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
// This suite exercises the real cross-package flow through `access`'s `runPipelineForEvent` (not yet
// moved into this package), which imports `@michaelthielemann/kestrel-core` by its bare specifier — mirrored here (instead
// of the relative `src/` paths most other suites in this package use) for readability; the package's own
// `vitest.config.ts` aliases the bare specifier to `src/index.ts`, so both resolve to the identical module
// regardless.
import {
  clearPipelines, registerPipeline, clearRegistry, registerCollection, buildCollection, defineCollection,
  maintainRecordRefs, desiredSchema, diffSchema, renderSqlite, recordRefs, buildToolingPipelines,
  useDb, getResolvedKestrelConfig, setResolvedKestrelConfig,
} from '@michaelthielemann/kestrel-core'
import { runPipelineForEvent } from '@michaelthielemann/kestrel-access'
// Must come through the same `@michaelthielemann/kestrel-core` specifier as `maintainRecordRefs` above — a relative `src/`
// import resolves a different compiled instance, whose `ModuleDbBrand` unique symbol then fails the cast below.
import type { ContentDb } from '@michaelthielemann/kestrel-core'

// `pipelines/tooling.ts` reads the shared `useDb()` singleton (its own real dependency, not an injectable
// port) — no clean seam to swap it per-test, so this suite points the singleton at an in-memory db by
// overriding the resolved config's `dbPath` (read once, on `useDb()`'s first call, then cached for the
// rest of this file) instead of mocking it.
setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
const db = useDb() as unknown as BetterSQLite3Database

const nodes = buildCollection(defineCollection({
  name: 'nodes', mode: 'multi', translatable: false,
  fields: { parent: { type: 'relation', relation: { collection: 'nodes' } } },
}))

function eventFor(role: string): H3Event {
  const event = createEvent(
    { method: 'GET', url: '/api/x', headers: {}, socket: { remoteAddress: '203.0.113.9' } } as never,
    { setHeader() {} } as never,
  )
  event.context.principal = { userId: role === 'admin' ? 'admin' : null, role } as never
  return event
}

const listCollections = (role = 'admin') => runPipelineForEvent(eventFor(role), { op: 'collections' })
const brokenRefs = (role = 'admin') => runPipelineForEvent(eventFor(role), { op: 'brokenRefs' })

beforeEach(() => {
  clearPipelines()
  clearRegistry()
  for (const def of buildToolingPipelines()) registerPipeline(def)
})
afterEach(() => clearPipelines())

describe('collections pipeline', () => {
  it('is admin-only and lists the registered collections, serialized', () => {
    registerCollection(nodes)
    expect(() => listCollections('anonymous')).toThrow(expect.objectContaining({ _tag: 'Unauthorized' }))
    const result = listCollections('admin') as { data: { name: string }[] }
    expect(result.data.map((c) => c.name)).toEqual(['nodes'])
  })
})

describe('brokenRefs pipeline', () => {
  // Both tests share the process-wide `useDb()` singleton (see the note above) — this one MUST run
  // before the migration test below, since there is no way to un-migrate the shared in-memory db.
  it('503s rather than answering "clean" when record_refs is not migrated yet', () => {
    let thrown: { statusCode?: number } | undefined
    try { brokenRefs('admin') } catch (error) { thrown = error as { statusCode?: number } }
    expect(thrown?.statusCode).toBe(503)
  })

  it('is admin-only and reports dead edges when the index is migrated', () => {
    const sqlite = (db as unknown as { $client: Database.Database }).$client
    for (const stmt of renderSqlite(diffSchema(desiredSchema([recordRefs]), {}))) sqlite.exec(stmt)
    expect(() => brokenRefs('anonymous')).toThrow(expect.objectContaining({ _tag: 'Unauthorized' }))
    // `maintainRecordRefs` takes the branded `ContentDb`; this cast vouches for it directly.
    maintainRecordRefs(drizzle(sqlite) as unknown as ContentDb, { def: nodes.def, before: null, after: { id: 1, parentId: 2 } })
    expect(brokenRefs('admin')).toEqual([
      { source: { collection: 'nodes', id: 1 }, target: { collection: 'nodes', id: 2 }, reason: 'missing' },
    ])
  })
})
