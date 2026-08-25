import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { clearPipelines, clearRegistry, defineCollection, desiredSchema, diffSchema, getResolvedKestrelConfig, registerCollection, registerPipeline, renderSqlite, resetDbInstance, setResolvedKestrelConfig, useDb, buildCollection  } from '@kestrel/core'
import { callPipelineRoute, usePipelineRouteDb } from '../../../../../test/helpers/pipeline-route.js'
import { buildLinkPipelines } from '../../../src/server/pipelines/links.js'

let db: BetterSQLite3Database

const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: false, pageLike: true, status: true, fields: { title: { type: 'text' } },
}))

Object.assign(globalThis, {
  useRuntimeConfig: () => ({ public: { locales: ['en'], primaryLocale: 'en', prefixPrimary: false } }),
})

const resolve = (refs: string, role = 'admin') =>
  callPipelineRoute('GET', `/api/resolveLinks?refs=${encodeURIComponent(refs)}`, { role }) as Promise<{ data: { collection: string; id: number; href: string }[] }>

beforeEach(() => {
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
  resetDbInstance()
  db = useDb() as unknown as BetterSQLite3Database
  usePipelineRouteDb(db)
  const sqlite = (db as unknown as { $client: Database.Database }).$client
  const desired = desiredSchema([pages.table], new Map([['pages', pages.def]]) as never)
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  sqlite.prepare('INSERT INTO pages (id, path, status, title, created_at, updated_at) VALUES (1, ?, ?, ?, 0, 0)').run('/live', 'published', 'Live')
  sqlite.prepare('INSERT INTO pages (id, path, status, title, created_at, updated_at) VALUES (2, ?, ?, ?, 0, 0)').run('/hidden', 'draft', 'Hidden')
  clearRegistry()
  clearPipelines()
  registerCollection(pages)
  for (const def of buildLinkPipelines()) registerPipeline(def)
})
afterEach(() => { clearRegistry(); clearPipelines() })

describe('GET /api/resolveLinks', () => {
  it('resolves a published target and omits a draft one, so the client renders "#"', async () => {
    const res = await resolve('pages:1,pages:2')
    expect(res.data).toEqual([{ collection: 'pages', id: 1, href: '/live' }])
  })

  it('skips a malformed ref instead of failing the batch', async () => {
    const res = await resolve('nonsense,pages:x,pages:1')
    expect(res.data).toEqual([{ collection: 'pages', id: 1, href: '/live' }])
  })

  it('401s an anonymous caller — the resolver enumerates targets the editor may see', async () => {
    await expect(resolve('pages:1', 'anonymous')).rejects.toMatchObject({ statusCode: 401 })
  })
})
