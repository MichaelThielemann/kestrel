import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { clearPipelines, desiredSchema, diffSchema, getResolvedKestrelConfig, registerPipeline, renderSqlite, resetDbInstance, setResolvedKestrelConfig, useDb } from '@kestrel/core'
import { runPipelineForEvent } from '@kestrel/access'
import { publishDeps, publishStatus, publishRuns, usePublishingDbFor, startPublishRun, buildPublishRunsPipelines } from '@kestrel/publishing'

/**
 * A tooling read pipeline exposes `publish_runs` state, gated like the `_outbox/dead` precedent
 * (`outboxDead` in `layers/core/server/pipelines/outbox.ts` / `outbox.test.ts`) — admin-only, anonymous
 * refused. The surface reports the orchestrator's persisted truth, not stale in-memory queue state: after
 * a run completes, nothing here reads "running".
 */

let db: BetterSQLite3Database

function seedDb(): BetterSQLite3Database {
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
  resetDbInstance()
  const db = useDb() as unknown as BetterSQLite3Database
  const sqlite = (db as unknown as { $client: { exec: (sql: string) => void } }).$client
  const desired = desiredSchema([publishDeps, publishStatus, publishRuns])
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  return db
}

function eventFor(role: string): H3Event {
  const event = createEvent(
    { method: 'GET', url: '/api/x', headers: {}, socket: { remoteAddress: '203.0.113.9' } } as never,
    { setHeader() {} } as never,
  )
  event.context.principal = { userId: role === 'admin' ? 'admin' : null, role } as never
  return event
}

// `op` guessed to match the pipeline's own `name` (mirrors `outboxDead`'s pipeline-name == op convention).
const readRuns = (role = 'admin') => runPipelineForEvent(eventFor(role), { op: 'publishRuns' })

beforeEach(() => {
  clearPipelines()
  for (const def of buildPublishRunsPipelines()) registerPipeline(def)
  db = seedDb()
})
afterEach(() => {
  clearPipelines()
})

describe('publishRuns admin progress pipeline', () => {
  it('refuses anonymous', () => {
    expect(() => readRuns('anonymous')).toThrow(expect.objectContaining({ _tag: 'Unauthorized' }))
  })

  it('allows an admin principal to read run state', () => {
    usePublishingDbFor(db).db.insert(publishRuns).values({ step: 'done', status: 'done' }).run()
    expect(() => readRuns('admin')).not.toThrow()
  })

  it('reports the persisted run rows (id/step/status/error) to an admin reader', () => {
    usePublishingDbFor(db).db.insert(publishRuns).values({ step: 'done', status: 'done' }).run()

    const result = readRuns('admin') as { data: { step: string; status: string }[] }
    expect(result.data).toHaveLength(1)
    expect(result.data[0]).toMatchObject({ step: 'done', status: 'done' })
  })
})

describe('publishRuns admin progress pipeline — badge truth', () => {
  it('after a completed run, the progress surface reports done, not a stale running state', async () => {
    await startPublishRun({ deliver: async () => {} })

    const result = readRuns('admin') as { data: { status: string }[] }
    expect(result.data.length).toBeGreaterThan(0)
    expect(result.data.every((r) => r.status !== 'running')).toBe(true)
    expect(result.data.some((r) => r.status === 'done')).toBe(true)
  })

  it('a run that failed is reported as failed, not as still in progress', async () => {
    await startPublishRun({ deliver: async () => { throw new Error('boom') } })

    const result = readRuns('admin') as { data: { status: string }[] }
    expect(result.data.some((r) => r.status === 'failed')).toBe(true)
    expect(result.data.every((r) => r.status !== 'running')).toBe(true)
  })

  it('with no run ever started, the surface reports an idle/empty state rather than throwing', () => {
    expect(() => readRuns('admin')).not.toThrow()
    const result = readRuns('admin') as { data: unknown[] }
    expect(Array.isArray(result.data)).toBe(true)
    expect(result.data).toEqual([])
  })
})
