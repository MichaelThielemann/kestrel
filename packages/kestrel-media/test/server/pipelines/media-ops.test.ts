import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from '../../../../../test/helpers/db.js'
import { runStepAsync } from '../../../../../test/helpers/run-effect.js'
import { DEFAULT_IMAGE_POLICY, createPipelineContext, getResolvedKestrelConfig, setResolvedKestrelConfig } from '@michaelthielemann/kestrel-core'
import { folders } from '../../../src/server/database/folders.js'
import { buildMediaOpPipelines } from '../../../src/server/pipelines/media-ops.js'

let db: ReturnType<typeof createTestDb>
let uploadsDir: string

const ORIG_CONFIG = getResolvedKestrelConfig()

const defs = buildMediaOpPipelines()
const run = async (name: string, input: unknown) => {
  const ctx = createPipelineContext({ op: name, db, input })
  await runStepAsync(defs.find((d) => d.name === name)!.steps![0]!.fn(ctx))
  return ctx.output
}

beforeEach(() => {
  db = createTestDb()
  uploadsDir = mkdtempSync(join(tmpdir(), 'kestrel-media-ops-'))
  setResolvedKestrelConfig({
    ...ORIG_CONFIG,
    media: { dir: uploadsDir, baseUrl: '/uploads', driver: 'local', maxUploadBytes: 10_000_000, allowedMimes: '', s3: { bucket: '', region: '', endpoint: '', prefix: '', publicBaseUrl: '' }, imagePolicy: DEFAULT_IMAGE_POLICY },
    collections: { pages: true, media: true },
  })
})
afterEach(() => {
  rmSync(uploadsDir, { recursive: true, force: true })
  setResolvedKestrelConfig(ORIG_CONFIG)
})

describe('POST /api/media/folders', () => {
  it('creates the directory on disk and the row together', async () => {
    await run('folders', { path: 'pics' })
    const rows = db.select().from(folders).all()
    expect(rows.map((r) => r.path)).toContain('pics')
  })

  it('does not leave a committed folder row when the on-disk mkdir fails', async () => {
    // 'blocked' is a plain FILE: mkdir(recursive) under it fails with ENOTDIR — a real, not simulated,
    // storage-driver error.
    writeFileSync(join(uploadsDir, 'blocked'), 'x')
    await expect(run('folders', { path: 'blocked/sub' })).rejects.toThrow()
    const rows = db.select().from(folders).all()
    expect(rows.map((r) => r.path)).not.toContain('blocked/sub')
    expect(rows.map((r) => r.path)).not.toContain('blocked')
  })
})

describe('POST /api/media/backfill', () => {
  it('reports a plan while the media built-in is enabled', async () => {
    await expect(run('backfill', { check: true })).resolves.toMatchObject({ rows: 0, check: true })
  })

  it('404s instead of querying a missing table when the media built-in is disabled', async () => {
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), collections: { pages: true, media: false } })
    await expect(run('backfill', { check: true })).rejects.toThrowError(expect.objectContaining({ statusCode: 404 }))
  })
})
