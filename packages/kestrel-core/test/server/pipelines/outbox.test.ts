import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
// This suite exercises the real cross-package flow through `access`'s `runPipelineForEvent` (not yet
// moved into this package), which imports `@michaelthielemann/kestrel-core` by its bare specifier — mirrored here (instead
// of the relative `src/` paths most other suites in this package use) for readability; the package's own
// `vitest.config.ts` aliases the bare specifier to `src/index.ts`, so both resolve to the identical module
// regardless.
import { clearPipelines, registerPipeline, insertOutboxRow, buildEnvelope, ensureOutboxTable, buildOutboxPipelines, useDb, getResolvedKestrelConfig, setResolvedKestrelConfig } from '@michaelthielemann/kestrel-core'
import { runPipelineForEvent } from '@michaelthielemann/kestrel-access'

// `pipelines/outbox.ts` reads the shared `useDb()` singleton (its own real dependency, not an injectable
// port) — no clean seam to swap it per-test, so this suite points the singleton at an in-memory db by
// overriding the resolved config's `dbPath` (read once, on `useDb()`'s first call, then cached for the
// rest of this file) instead of mocking it.
setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
const db = useDb() as unknown as BetterSQLite3Database

function eventFor(role: string): H3Event {
  const event = createEvent(
    { method: 'GET', url: '/api/x', headers: {}, socket: { remoteAddress: '203.0.113.9' } } as never,
    { setHeader() {} } as never,
  )
  event.context.principal = { userId: role === 'admin' ? 'admin' : null, role } as never
  return event
}

const outboxDead = (role = 'admin') => runPipelineForEvent(eventFor(role), { op: 'outboxDead' })

beforeEach(() => {
  clearPipelines()
  for (const def of buildOutboxPipelines()) registerPipeline(def)
  const sqlite = (db as unknown as { $client: Database.Database }).$client
  ensureOutboxTable(sqlite, 'content')
  sqlite.exec('DELETE FROM outbox_content')
})
afterEach(() => clearPipelines())

describe('outboxDead pipeline', () => {
  it('refuses anonymous, allows admin, and lists only dead-lettered rows', () => {
    expect(() => outboxDead('anonymous')).toThrow(expect.objectContaining({ _tag: 'Unauthorized' }))

    const sqlite = (db as unknown as { $client: Database.Database }).$client
    const live = buildEnvelope({
      name: 'pages.created', version: 1, aggregate: { collection: 'pages', recordId: 1 }, sequence: 1,
      correlationId: 'c1', causation: { pipeline: 'createOne', op: 'createOne' }, occurredAt: new Date().toISOString(),
      payload: { id: 1 },
    })
    insertOutboxRow(sqlite, 'content', live)
    const dead = buildEnvelope({
      name: 'pages.updated', version: 1, aggregate: { collection: 'pages', recordId: 2 }, sequence: 1,
      correlationId: 'c2', causation: { pipeline: 'updateOne', op: 'updateOne' }, occurredAt: new Date().toISOString(),
      payload: { id: 2 },
    })
    insertOutboxRow(sqlite, 'content', dead)
    sqlite.prepare('UPDATE outbox_content SET dead = 1 WHERE aggregate_key = ?').run('pages:2')

    const result = outboxDead('admin') as { data: { aggregateKey: string, dead: boolean }[] }
    expect(result.data).toHaveLength(1)
    expect(result.data[0]!.aggregateKey).toBe('pages:2')
    expect(result.data[0]!.dead).toBe(true)
  })

  it('also lets a renderer principal through — POLICY.renderer holds a resource wildcard read grant, and there is no cheaper way to carve this one resource out of it', () => {
    expect(() => outboxDead('renderer')).not.toThrow()
  })
})
