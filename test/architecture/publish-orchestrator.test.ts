import { describe, it, expect } from 'vitest'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { desiredSchema, diffSchema, getResolvedKestrelConfig, renderSqlite, resetDbInstance, setResolvedKestrelConfig, useDb } from '@kestrel/core'
import { publishDeps, publishStatus, publishRuns, usePublishingDbFor, startPublishRun, resumePublishRuns, type PublishRunRecord, type PublishDelivery } from '@kestrel/publishing'

/**
 * A publish run is an owned sequence — command -> snapshot -> delivery -> done — persisted in
 * `publish_runs` so it survives a crash. `publisher.ts` needs a live Nitro build and is documented as not
 * unit-testable, so every test here drives the sequence through an injectable `PublishDelivery` port
 * instead of the real renderer.
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

function rows(): PublishRunRecord[] {
  return usePublishingDbFor(db).db.select().from(publishRuns).all() as unknown as PublishRunRecord[]
}

describe('publish orchestrator — owned sequence', () => {
  it('startPublishRun advances command -> snapshot -> delivery -> done, and the delivery step itself observes a running/delivery row already persisted', async () => {
    db = seedDb()

    let sawDuringDelivery: PublishRunRecord | undefined
    const delivery: PublishDelivery = {
      deliver: async (run) => {
        // Observed from a SEPARATE read (not the `run` argument) — pins that the sequence is durable,
        // not just an in-memory object the caller happens to hold.
        sawDuringDelivery = rows().find((r) => r.id === run.id)
      },
    }

    const result = await startPublishRun(delivery)

    expect(sawDuringDelivery?.step).toBe('delivery')
    expect(sawDuringDelivery?.status).toBe('running')
    expect(result.step).toBe('done')
    expect(result.status).toBe('done')

    const persisted = rows()
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ step: 'done', status: 'done', error: null })
  })

  it('exactly one publish_runs row exists per run — the sequence updates the same row across steps rather than appending one per step', async () => {
    db = seedDb()

    await startPublishRun({ deliver: async () => {} })
    expect(rows()).toHaveLength(1)
  })
})

describe('publish orchestrator — crash resume (supersede, not redeliver)', () => {
  it('a run left status=running at a non-terminal step is marked failed with a superseded-by-boot-publish reason, never staying stuck running', async () => {
    db = seedDb()
    const pubDb = usePublishingDbFor(db).db
    // Simulate what a killed process leaves behind: a mid-run row, no process to finish it.
    pubDb.insert(publishRuns).values({ step: 'delivery', status: 'running' }).run()

    await resumePublishRuns()

    const after = rows()
    expect(after).toHaveLength(1)
    expect(after[0]!.status).toBe('failed')
    // The literal reason, not just "not running" — a mutant that marked the row done/no-error instead of
    // failed/superseded must fail this test.
    expect(after[0]!.error).toContain('superseded by the boot publish')
    expect(after.every((r) => r.status !== 'running')).toBe(true)
  })

  it('resuming a crashed run never redelivers it — it is marked failed directly, with no delivery port involved at all', async () => {
    db = seedDb()
    const pubDb = usePublishingDbFor(db).db
    const [crashed] = pubDb.insert(publishRuns).values({ step: 'delivery', status: 'running' }).returning().all()

    await resumePublishRuns()

    const after = rows().find((r) => r.id === crashed!.id)
    expect(after?.status).toBe('failed')
    expect(after?.error).toContain('superseded by the boot publish')
  })

  it('resuming with nothing crashed is a no-op — a fully done run is left exactly as it was', async () => {
    db = seedDb()
    await startPublishRun({ deliver: async () => {} })
    const before = rows()

    await resumePublishRuns()

    expect(rows()).toEqual(before)
  })
})

describe('publish orchestrator — failure honesty', () => {
  it('a run whose delivery throws lands in status=failed with the error recorded, not swallowed', async () => {
    db = seedDb()
    const failing: PublishDelivery = { deliver: async () => { throw new Error('boom: delivery unreachable') } }

    const result = await startPublishRun(failing)

    expect(result.status).toBe('failed')
    expect(result.error).toBeTruthy()
    expect(String(result.error)).toContain('boom')

    const persisted = rows().find((r) => r.id === result.id)
    expect(persisted?.status).toBe('failed')
    expect(persisted?.error).toBeTruthy()
  })

  it('a subsequent new run proceeds after a prior failure — no permanent lock', async () => {
    db = seedDb()
    await startPublishRun({ deliver: async () => { throw new Error('first run fails') } })

    const second = await startPublishRun({ deliver: async () => {} })
    expect(second.status).toBe('done')
  })
})
