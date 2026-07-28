import { describe, it, expect, beforeEach } from 'vitest'
import { createError } from 'h3'
import { createTestDb } from '../../../../../test/helpers/db'
import { list, parseFilter } from '../../../../core/server/utils/crud'

interface FakeEvent { query: Record<string, unknown> }

let db: ReturnType<typeof createTestDb>
let runtime: Record<string, unknown>

// The handler is a Nitro route: its auto-imported helpers are plain globals in a node test.
Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  createError,
  getQuery: (event: FakeEvent) => event.query,
  useDb: () => db,
  useRuntimeConfig: () => runtime,
  list,
  parseFilter,
})

const handler = (await import('./index.get')).default as unknown as (event: FakeEvent) => { data: unknown[]; total: number }

beforeEach(() => { db = createTestDb(); runtime = { kestrel: {} } })

describe('GET /api/media', () => {
  it('lists the library while the media built-in is enabled', () => {
    expect(handler({ query: {} })).toMatchObject({ data: [], total: 0 })
  })

  it('404s instead of querying a missing table when the media built-in is disabled', () => {
    runtime.kestrel = { collections: { media: false } }
    expect(() => handler({ query: {} })).toThrowError(expect.objectContaining({ statusCode: 404 }))
  })
})
