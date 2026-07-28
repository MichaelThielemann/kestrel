import { describe, it, expect } from 'vitest'
import { createError } from 'h3'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { findReferrers, findReferrersForMany, maintainRecordRefs } from '../../utils/record-ref-index'
import { parseIdList } from '../../utils/http'
import { defineCollection } from '../../utils/defineCollection'
import { recordRefs } from '../../database/record-refs'
import { desiredSchema } from '../../schema/desired'
import { diffSchema } from '../../schema/diff'
import { renderSqlite } from '../../schema/render-sqlite'

interface FakeEvent { query: Record<string, unknown> }

let db: ReturnType<typeof drizzle>

Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  createError,
  getQuery: (event: FakeEvent) => event.query,
  useDb: () => db,
  findReferrers,
  findReferrersForMany,
  parseIdList,
})

const handler = (await import('./referrers.get')).default as unknown as (event: FakeEvent) => unknown
const get = (query: Record<string, unknown>) => handler({ query })

const nodes = defineCollection({
  name: 'nodes', mode: 'multi', translatable: false,
  fields: { parent: { type: 'relation', relation: { collection: 'nodes' } } },
})

describe('GET /api/references/referrers?ids=', () => {
  it('checked:true with the real counts when the index is migrated', () => {
    const sqlite = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desiredSchema([recordRefs]), {}))) sqlite.exec(stmt)
    db = drizzle(sqlite)
    maintainRecordRefs(db, { def: nodes, before: null, after: { id: 1, parentId: 2 } })
    expect(get({ collection: 'nodes', ids: '2' })).toEqual({ counts: { 2: 1 }, checked: true })
  })

  it('checked:false (not an empty-counts false-negative) when record_refs is not migrated yet', () => {
    db = drizzle(new Database(':memory:')) // no record_refs table
    expect(get({ collection: 'nodes', ids: '2,3' })).toEqual({ counts: {}, checked: false })
  })
})
