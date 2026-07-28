import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createError } from 'h3'
import { createTestDb } from '../../../../../test/helpers/db'
import { folders } from '../../database/folders'
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

const handler = (await import('./folders.post')).default as unknown as (event: FakeEvent) => Promise<{ path: string }>

beforeEach(() => {
  db = createTestDb()
  uploadsDir = mkdtempSync(join(tmpdir(), 'kestrel-folders-'))
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

describe('POST /api/media/folders', () => {
  it('creates the directory on disk and the row together', async () => {
    await handler({ body: { path: 'pics' } })
    const rows = db.select().from(folders).all()
    expect(rows.map((r) => r.path)).toContain('pics')
  })

  it('does not leave a committed folder row when the on-disk mkdir fails', async () => {
    // 'blocked' is a plain FILE: mkdir(recursive) under it fails with ENOTDIR — a real, not simulated,
    // storage-driver error.
    writeFileSync(join(uploadsDir, 'blocked'), 'x')
    await expect(handler({ body: { path: 'blocked/sub' } })).rejects.toThrow()
    const rows = db.select().from(folders).all()
    expect(rows.map((r) => r.path)).not.toContain('blocked/sub')
    expect(rows.map((r) => r.path)).not.toContain('blocked')
  })
})
