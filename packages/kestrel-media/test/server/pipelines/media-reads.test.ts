import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callPipelineRoute, usePipelineRouteDb } from '../../../../../test/helpers/pipeline-route.js'
import { createTestDb } from '../../../../../test/helpers/db.js'
import { DEFAULT_IMAGE_POLICY, clearPipelines, clearRegistry, create, ensureRevisionsTable, registerCollection, registerPipeline, sqliteClientOf } from '@michaelthielemann/kestrel-core'
import builtMedia from '../../../src/server/collections/media.js'
import { buildMediaPipelines } from '../../../src/server/pipelines/index.js'
let db: ReturnType<typeof createTestDb>
let uploadsDir: string
let runtime: Record<string, unknown>

Object.assign(globalThis, { useRuntimeConfig: () => runtime })

beforeEach(() => {
  clearRegistry()
  clearPipelines()
  db = createTestDb()
  ensureRevisionsTable(sqliteClientOf(db), 'media')
  usePipelineRouteDb(db)
  uploadsDir = mkdtempSync(join(tmpdir(), 'kestrel-media-reads-'))
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
  for (const def of buildMediaPipelines()) registerPipeline(def)
})
afterEach(() => {
  clearRegistry()
  clearPipelines()
  rmSync(uploadsDir, { recursive: true, force: true })
})

const enable = () => registerCollection(builtMedia)

describe('GET /api/media/readMany', () => {
  it('lists the library through the generic read pipeline', async () => {
    enable()
    await expect(callPipelineRoute('GET', '/api/media/readMany', { role: 'admin' })).resolves.toMatchObject({ data: [], total: 0 })
  })

  // With the built-in disabled `02.register-media` never registers the collection, so the router refuses
  // the URL before any step could query the table the schema engine deliberately never created.
  it('404s instead of querying a missing table while the media collection is not registered', async () => {
    await expect(callPipelineRoute('GET', '/api/media/readMany', { role: 'admin' })).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('the media read pipelines', () => {
  beforeEach(enable)

  it('answers the library listing for an admin', async () => {
    await expect(callPipelineRoute('GET', '/api/media/library?folder=', { role: 'admin' })).resolves.toMatchObject({ folder: '', files: [] })
  })

  it('refuses an anonymous library read', async () => {
    await expect(callPipelineRoute('GET', '/api/media/library', { role: 'anonymous' })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('is a read pipeline — a POST is refused with 405', async () => {
    await expect(callPipelineRoute('POST', '/api/media/library', { role: 'admin' })).rejects.toMatchObject({ statusCode: 405 })
  })

  it('resolves media ids from the query string', async () => {
    const row = create(db, builtMedia, { storageKey: 'a/one.png', folder: 'a', filename: 'one.png', mime: 'image/png', ext: 'png', size: 1 }) as { id: number }
    const result = await callPipelineRoute('GET', `/api/media/resolve?ids=${row.id}`, { role: 'admin' }) as { data: { id: number }[] }
    expect(result.data.map((m) => m.id)).toEqual([row.id])
  })

  it('reports a record\'s usages under its own id', async () => {
    const row = create(db, builtMedia, { storageKey: 'a/two.png', folder: 'a', filename: 'two.png', mime: 'image/png', ext: 'png', size: 1 }) as { id: number }
    await expect(callPipelineRoute('GET', `/api/media/usages/${row.id}`, { role: 'admin' })).resolves.toEqual({ id: row.id, usages: [] })
  })
})
