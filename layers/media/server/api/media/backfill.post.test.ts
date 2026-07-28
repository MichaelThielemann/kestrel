import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createError } from 'h3'
import { createTestDb } from '../../../../../test/helpers/db'
import { DEFAULT_IMAGE_POLICY } from '../../../../core/server/utils/kestrel-config'

interface FakeEvent { body?: unknown }

let db: ReturnType<typeof createTestDb>
let uploadsDir: string
let runtime: Record<string, unknown>

// The handler is a Nitro route: its auto-imported helpers are plain globals in a node test.
Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  requireAdmin: () => {},
  createError,
  readBody: async (event: FakeEvent) => event.body ?? {},
  useDb: () => db,
  useRuntimeConfig: () => runtime,
})

const handler = (await import('./backfill.post')).default as unknown as (event: FakeEvent) => Promise<{ rows: number }>

beforeEach(() => {
  db = createTestDb()
  uploadsDir = mkdtempSync(join(tmpdir(), 'kestrel-backfill-'))
  runtime = {
    media: {
      driver: 'local',
      maxUploadBytes: 10_000_000,
      imagePolicy: DEFAULT_IMAGE_POLICY,
      local: { dir: uploadsDir, baseUrl: '/uploads' },
      s3: {},
    },
    kestrel: {},
  }
})
afterEach(() => rmSync(uploadsDir, { recursive: true, force: true }))

describe('POST /api/media/backfill', () => {
  it('reports a plan while the media built-in is enabled', async () => {
    await expect(handler({ body: { check: true } })).resolves.toMatchObject({ rows: 0, check: true })
  })

  it('404s instead of querying a missing table when the media built-in is disabled', async () => {
    runtime.kestrel = { collections: { media: false } }
    await expect(handler({ body: { check: true } })).rejects.toThrowError(expect.objectContaining({ statusCode: 404 }))
  })
})
