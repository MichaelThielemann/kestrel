import { describe, it, expect } from 'vitest'
import { createError } from 'h3'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { findBrokenRefs, maintainRecordRefs } from '../../utils/record-ref-index'
import { defineCollection } from '../../utils/defineCollection'
import { recordRefs } from '../../database/record-refs'
import { desiredSchema } from '../../schema/desired'
import { diffSchema } from '../../schema/diff'
import { renderSqlite } from '../../schema/render-sqlite'

let db: ReturnType<typeof drizzle>

Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  createError,
  useDb: () => db,
  findBrokenRefs,
})

const handler = (await import('./broken.get')).default as unknown as () => unknown

const nodes = defineCollection({
  name: 'nodes', mode: 'multi', translatable: false,
  fields: { parent: { type: 'relation', relation: { collection: 'nodes' } } },
})

describe('GET /api/references/broken', () => {
  it('reports the dead edges when the index is migrated', () => {
    const sqlite = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desiredSchema([recordRefs]), {}))) sqlite.exec(stmt)
    db = drizzle(sqlite)
    maintainRecordRefs(db, { def: nodes, before: null, after: { id: 1, parentId: 2 } })
    expect(handler()).toEqual([
      { source: { collection: 'nodes', id: 1 }, target: { collection: 'nodes', id: 2 }, reason: 'missing' },
    ])
  })

  it('503s rather than answering "clean" when record_refs is not migrated yet', () => {
    db = drizzle(new Database(':memory:'))
    let thrown: { statusCode?: number } | undefined
    try { handler() } catch (error) { thrown = error as { statusCode?: number } }
    expect(thrown?.statusCode).toBe(503)
  })
})
