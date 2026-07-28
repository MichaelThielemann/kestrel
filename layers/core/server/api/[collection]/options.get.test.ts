import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createError } from 'h3'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { buildCollection } from '../../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../utils/defineCollection'
import { create } from '../../utils/crud'
import { requireCollection, parseIdList } from '../../utils/http'
import { clearRegistry, registerCollection } from '../../utils/registry'
import { pickerOptions } from '../../utils/picker'
import { desiredSchema } from '../../schema/desired'
import { diffSchema } from '../../schema/diff'
import { renderSqlite } from '../../schema/render-sqlite'

const posts = buildCollection(defineCollection({
  name: 'posts', mode: 'multi', translatable: false,
  fields: { title: { type: 'text', required: true } },
}))

interface FakeEvent { query: Record<string, unknown>; context: { params: Record<string, string>; readScope?: string } }

let db: ReturnType<typeof drizzle>

// Same rationale as translations.get.test.ts: bind the handler's auto-imported helpers to the REAL
// implementations so this proves the actual wiring, not a stub the server does not have.
Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  createError,
  getQuery: (event: FakeEvent) => event.query,
  useDb: () => db,
  requireCollection,
  parseIdList,
  pickerOptions,
  publishedOnlyForScope: () => false,
})

const handler = (await import('./options.get')).default as unknown as (event: FakeEvent) => ReturnType<typeof pickerOptions>
const get = (collection: string, query: Record<string, unknown>) => handler({ query, context: { params: { collection } } })

beforeEach(() => {
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([posts.table]), {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  clearRegistry()
  registerCollection(posts)
})
afterEach(() => clearRegistry())

describe('GET /api/{collection}/options?ids=', () => {
  it('resolves more than 100 ids in one request instead of truncating', () => {
    const ids = Array.from({ length: 150 }, (_, i) => (create(db, posts, { title: `T${i}` }) as { id: number }).id)
    const r = get('posts', { ids: ids.join(',') })
    expect(r.data.length).toBe(150)
  })

  it('400s (never silently truncates) an ids list over the shared bulk cap', () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1)
    expect(() => get('posts', { ids: ids.join(',') })).toThrowError(expect.objectContaining({ statusCode: 400 }))
  })
})
