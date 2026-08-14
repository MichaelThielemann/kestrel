import { describe, it, expect, beforeEach } from 'vitest'
import { createError } from 'h3'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { buildCollection } from '../../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../utils/defineCollection'
import { putSingleton } from '../../utils/crud'
import { requireCollection } from '../../utils/http'
import { clearRegistry, registerCollection } from '../../utils/registry'
import { clearWriteListeners } from '../../utils/write-events'
import { registerWriteEffect, clearWriteEffects, runWriteEffects } from '../../utils/write-effects'
import { desiredSchema } from '../../schema/desired'
import { diffSchema } from '../../schema/diff'
import { renderSqlite } from '../../schema/render-sqlite'

const settings = buildCollection(defineCollection({
  name: 'settings', mode: 'single',
  fields: { title: { type: 'text', required: true } },
}))

interface FakeEvent { query: Record<string, unknown>; body: unknown; context: { params: Record<string, string> } }

let db: ReturnType<typeof drizzle>

// Bind the auto-imported helpers to the REAL implementations, so this proves the actual wiring rather
// than a stub (same rationale as options.get.test.ts).
Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  createError,
  getQuery: (event: FakeEvent) => event.query,
  readBody: (event: FakeEvent) => Promise.resolve(event.body),
  useDb: () => db,
  requireAdmin: () => {},
  requireCollection,
  readIfUnmodifiedSince: () => undefined,
  putSingleton,
  runWriteEffects,
})

const handler = (await import('./index.put')).default as unknown as (event: FakeEvent) => Promise<Record<string, unknown>>
const put = (collection: string, body: unknown) => handler({ query: {}, body, context: { params: { collection } } })

beforeEach(() => {
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([settings.table]), {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  clearRegistry()
  registerCollection(settings)
  clearWriteListeners()
  clearWriteEffects()
})

describe('PUT /api/[collection] — singleton save', () => {
  it('writes the row and returns it', async () => {
    await expect(put('settings', { title: 'Hello' })).resolves.toMatchObject({ title: 'Hello' })
  })

  it('runs post-write effects with the saved row', async () => {
    const seen: unknown[] = []
    registerWriteEffect((e) => { seen.push([e.def.name, e.row.title]) })
    await put('settings', { title: 'Hello' })
    expect(seen).toEqual([['settings', 'Hello']])
  })

  it('fails the save when an effect rejects — a stale side effect must not report success', async () => {
    registerWriteEffect(() => { throw createError({ statusCode: 500, statusMessage: 'artifact is stale' }) })
    await expect(put('settings', { title: 'Hello' })).rejects.toMatchObject({ statusCode: 500, statusMessage: 'artifact is stale' })
  })

  it('does not run effects when validation rejects the body', async () => {
    let ran = false
    registerWriteEffect(() => { ran = true })
    await expect(put('settings', { title: '' })).rejects.toMatchObject({ statusCode: 400 })
    expect(ran).toBe(false)
  })
})
