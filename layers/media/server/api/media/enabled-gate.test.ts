import { describe, it, expect, beforeEach } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createError } from 'h3'

interface FakeEvent { query: Record<string, unknown>; body: Record<string, unknown> }

let runtime: Record<string, unknown>

// Reaching the DB means the gate did not run: with the built-in disabled the `media` table does not exist,
// so any query is the 500 the gate exists to prevent.
const DB_REACHED = new Error('useDb() reached — the media built-in gate must run before any query')

// The handlers are Nitro routes: their auto-imported helpers are plain globals in a node test.
Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  createError,
  getQuery: (event: FakeEvent) => event.query,
  readBody: async (event: FakeEvent) => event.body,
  requireAdmin: () => {},
  requireId: () => 1,
  readIfUnmodifiedSince: () => undefined,
  getRequestHeader: () => '0',
  readMultipartFormData: async () => [],
  setResponseStatus: () => {},
  getOne: () => ({}),
  list: () => ({ data: [], total: 0 }),
  parseFilter: () => undefined,
  useRuntimeConfig: () => runtime,
  useDb: () => { throw DB_REACHED },
})

const routes: Record<string, () => Promise<{ default: unknown }>> = {
  'backfill.post.ts': () => import('./backfill.post'),
  'copy.post.ts': () => import('./copy.post'),
  'delete.post.ts': () => import('./delete.post'),
  'folders.post.ts': () => import('./folders.post'),
  'index.get.ts': () => import('./index.get'),
  'index.post.ts': () => import('./index.post'),
  'library.get.ts': () => import('./library.get'),
  'move.post.ts': () => import('./move.post'),
  'rename.post.ts': () => import('./rename.post'),
  'resolve.get.ts': () => import('./resolve.get'),
  '[id].delete.ts': () => import('./[id].delete'),
  '[id].get.ts': () => import('./[id].get'),
  '[id].patch.ts': () => import('./[id].patch'),
  '[id]/usages.get.ts': () => import('./[id]/usages.get'),
}

const dir = fileURLToPath(new URL('.', import.meta.url))
const isRoute = (f: string) => f.endsWith('.ts') && !f.endsWith('.test.ts')

const call = async (load: () => Promise<{ default: unknown }>) => {
  const handler = (await load()).default as (event: FakeEvent) => unknown
  try {
    await handler({ query: {}, body: {} })
    return undefined
  } catch (error) {
    return error as { statusCode?: number }
  }
}

beforeEach(() => { runtime = { kestrel: {} } })

describe('the media built-in gate covers every /api/media route', () => {
  it('knows about every route file on disk', () => {
    const onDisk = [
      ...readdirSync(dir).filter(isRoute),
      ...readdirSync(join(dir, '[id]')).filter(isRoute).map((f) => `[id]/${f}`),
    ]
    expect(onDisk.sort()).toEqual(Object.keys(routes).sort())
  })

  for (const [name, load] of Object.entries(routes)) {
    it(`${name} 404s instead of querying a missing table when the built-in is disabled`, async () => {
      runtime.kestrel = { collections: { media: false } }
      expect(await call(load)).toMatchObject({ statusCode: 404 })
    })

    it(`${name} does not 404 while the built-in is enabled`, async () => {
      expect((await call(load))?.statusCode).not.toBe(404)
    })
  }
})
