import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { callPipelineRoute, usePipelineRouteDb } from '../../../../../../test/helpers/pipeline-route.js'
import { buildCollection } from '../../../../src/server/schema/buildCollection.js'
import { defineCollection } from '../../../../src/index.js'
import { clearRegistry, registerCollection } from '../../../../src/server/utils/registry.js'
import { clearPipelines } from '../../../../src/server/pipeline/registry.js'
import { maintainRecordRefs } from '../../../../src/server/utils/record-ref-index.js'
import { recordRefs } from '../../../../src/server/database/record-refs.js'
import { desiredSchema } from '../../../../src/server/schema/desired.js'
import { diffSchema } from '../../../../src/server/schema/diff.js'
import { renderSqlite } from '../../../../src/server/schema/render-sqlite.js'
import type { ContentDb } from '../../../../src/server/db/content-db.js'

const nodes = buildCollection(defineCollection({
  name: 'nodes', mode: 'multi', translatable: false,
  fields: { parent: { type: 'relation', relation: { collection: 'nodes' } } },
}))

let db: ReturnType<typeof drizzle>

beforeEach(() => {
  clearRegistry()
  clearPipelines()
  registerCollection(nodes)
})
afterEach(() => { clearRegistry(); clearPipelines() })

function migratedDb(): ReturnType<typeof drizzle> {
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([nodes.table, recordRefs]), {}))) sqlite.exec(stmt)
  return drizzle(sqlite)
}

// `usePipelineRouteDb` takes the bare `BetterSQLite3Database<Record<string, never>>` — a schema-less
// `drizzle(sqlite)` infers `Record<string, unknown>` instead, so cast at the crossing.
function asRouteDb(db: ReturnType<typeof drizzle>): BetterSQLite3Database {
  return db as unknown as BetterSQLite3Database
}

describe('GET /api/{collection}/referrers?id=', () => {
  it('answers the referrer list for a single target', async () => {
    db = migratedDb()
    usePipelineRouteDb(asRouteDb(db))
    maintainRecordRefs(db as unknown as ContentDb, { def: nodes.def, before: null, after: { id: 1, parentId: 2 } })
    await expect(callPipelineRoute('GET', '/api/nodes/referrers?id=2', { role: 'admin' }))
      .resolves.toEqual([{ collection: 'nodes', id: 1 }])
  })

  it('400s (id query param is required) without a valid id', async () => {
    db = migratedDb()
    usePipelineRouteDb(asRouteDb(db))
    await expect(callPipelineRoute('GET', '/api/nodes/referrers', { role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 400, statusMessage: 'id query param is required', data: [{ path: ['id'], message: 'id query param is required' }] })
    await expect(callPipelineRoute('GET', '/api/nodes/referrers?id=0', { role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 400, statusMessage: 'id query param is required', data: [{ path: ['id'], message: 'id query param is required' }] })
  })

  it('refuses an anonymous read', async () => {
    db = migratedDb()
    usePipelineRouteDb(asRouteDb(db))
    await expect(callPipelineRoute('GET', '/api/nodes/referrers?id=1', { role: 'anonymous' }))
      .rejects.toMatchObject({ statusCode: 401 })
  })
})

describe('GET /api/{collection}/referrers?ids=', () => {
  it('checked:true with the real counts when the index is migrated', async () => {
    db = migratedDb()
    usePipelineRouteDb(asRouteDb(db))
    maintainRecordRefs(db as unknown as ContentDb, { def: nodes.def, before: null, after: { id: 1, parentId: 2 } })
    await expect(callPipelineRoute('GET', '/api/nodes/referrers?ids=2', { role: 'admin' }))
      .resolves.toEqual({ counts: { 2: 1 }, checked: true })
  })

  it('checked:false (not an empty-counts false-negative) when record_refs is not migrated yet', async () => {
    db = drizzle(new Database(':memory:')) // no record_refs table
    usePipelineRouteDb(asRouteDb(db))
    await expect(callPipelineRoute('GET', '/api/nodes/referrers?ids=2,3', { role: 'admin' }))
      .resolves.toEqual({ counts: {}, checked: false })
  })

  it('400s over the shared bulk cap (MAX_BULK_IDS)', async () => {
    db = migratedDb()
    usePipelineRouteDb(asRouteDb(db))
    const ids = Array.from({ length: 501 }, (_, i) => i + 1).join(',')
    await expect(callPipelineRoute('GET', `/api/nodes/referrers?ids=${ids}`, { role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 400 })
  })
})
