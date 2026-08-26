import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { callPipelineRoute, usePipelineRouteDb } from '../../../../test/helpers/pipeline-route'
import { buildCollection, buildIntrospectionPipelines, clearPipelines, clearRegistry, create, defaultCollectionOps, defineCollection, desiredSchema, diffSchema, outboxContent, registerCollection, registerPipeline, renderSqlite, revisionsTable, syncStep  } from '@michaelthielemann/kestrel-core'
import type { PipelineDescriptor } from '@michaelthielemann/kestrel-core'
const notes = buildCollection(defineCollection({
  name: 'notes', mode: 'multi', translatable: false, status: true,
  fields: { title: { type: 'text', required: true } },
}))

let db: ReturnType<typeof drizzle>
let noteId: number

beforeEach(() => {
  clearRegistry()
  clearPipelines()
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, notes.table, revisionsTable('notes')]), {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  usePipelineRouteDb(db)
  registerCollection(notes)
  noteId = (create(db, notes, { title: 'A' }) as Record<string, unknown>).id as number
  for (const def of buildIntrospectionPipelines()) registerPipeline(def)
  registerPipeline({
    name: 'archiveNote',
    on: { collection: 'notes' },
    access: { role: 'admin' },
    steps: [syncStep('archive', (ctx) => { ctx.output = { archived: true } })],
  })
})
afterEach(() => { clearRegistry(); clearPipelines() })

const list = (role?: string) => callPipelineRoute('GET', '/api/_pipelines', { role }) as Promise<{ pipelines: PipelineDescriptor[] }>

describe('GET /api/_pipelines', () => {
  it('401s an anonymous or principal-less caller', async () => {
    await expect(list()).rejects.toMatchObject({ statusCode: 401 })
    await expect(list('anonymous')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('lets an admin through', async () => {
    const { pipelines } = await list('admin')
    expect(pipelines.length).toBeGreaterThan(0)
  })

  it('describes a default collection pipeline with its steps and flags', async () => {
    const { pipelines } = await list('admin')
    const updateOne = pipelines.find((p) => p.collection === 'notes' && p.name === 'updateOne')
    expect(updateOne).toBeDefined()
    expect(updateOne!.route).toEqual({ url: '/api/notes/updateOne', method: 'POST' })
    expect(updateOne!.gates.access).toEqual({ role: 'admin' })
    expect(updateOne!.gates.csrf).toBe(true)
    const stepNames = updateOne!.steps.map((s) => s.name)
    expect(stepNames).toEqual(['loadBefore', 'checkConcurrency', 'validate', 'resolveLocale', 'resolveSlug', 'transform', 'assertUnique', 'persist', 'emitEvents'])
    const persist = updateOne!.steps.find((s) => s.name === 'persist')
    expect(persist).toMatchObject({ sync: true, sealed: true })
  })

  // The listing enumerates the built-in ops instead of reading them back from the registry (nothing
  // resolves a default op until a request asks for it), so it has to stay in step with the builders.
  it('lists every built-in op the defaults compose for a collection', async () => {
    const { pipelines } = await list('admin')
    const listed = pipelines.filter((p) => p.collection === 'notes').map((p) => p.name)
    expect(listed.sort()).toEqual([...defaultCollectionOps(), 'archiveNote'].sort())
  })

  it('describes a default read pipeline as GET with no CSRF', async () => {
    const { pipelines } = await list('admin')
    const readMany = pipelines.find((p) => p.collection === 'notes' && p.name === 'readMany')
    expect(readMany!.route).toEqual({ url: '/api/notes/readMany', method: 'GET' })
    expect(readMany!.gates.csrf).toBe(false)
  })

  it('describes a consumer-registered custom pipeline', async () => {
    const { pipelines } = await list('admin')
    const custom = pipelines.find((p) => p.name === 'archiveNote')
    expect(custom).toBeDefined()
    expect(custom!.collection).toBe('notes')
    expect(custom!.route).toEqual({ url: '/api/notes/archiveNote', method: 'POST' })
    expect(custom!.steps.map((s) => s.name)).toEqual(['archive'])
  })

  it('describes itself as an admin-only, collection-less, read pipeline', async () => {
    const { pipelines } = await list('admin')
    const self = pipelines.find((p) => p.name === '_pipelines')
    expect(self).toBeDefined()
    expect(self!.collection).toBeNull()
    expect(self!.route).toEqual({ url: '/api/_pipelines', method: 'GET' })
    expect(self!.gates.access).toEqual({ role: 'admin' })
  })
})

describe('?debug=pipeline trace embedding', () => {
  it('embeds $pipeline for an admin request', async () => {
    const row = await callPipelineRoute('GET', `/api/notes/readOne/${noteId}?debug=pipeline`, { role: 'admin' }) as Record<string, unknown>
    expect(row.id).toBe(noteId)
    const trace = row.$pipeline as { pipeline: string, steps: unknown[] }
    expect(trace.pipeline).toBe('readOne')
    expect(Array.isArray(trace.steps)).toBe(true)
    expect(trace.steps.length).toBeGreaterThan(0)
  })

  it('wraps an array result under `data` so the trace still has somewhere to attach', async () => {
    const created = await callPipelineRoute('POST', '/api/notes/createOne', { role: 'admin', body: { title: 'B' } }) as { id: number }
    const result = await callPipelineRoute('POST', `/api/notes/duplicate?debug=pipeline`, { role: 'admin', body: { ids: [created.id] } }) as { data: unknown[], $pipeline: unknown }
    expect(Array.isArray(result.data)).toBe(true)
    expect(result.$pipeline).toBeDefined()
  })

  it('never embeds the trace for a non-admin caller, even when debug is requested', async () => {
    const published = (create(db, notes, { title: 'Published', status: 'published' }) as Record<string, unknown>).id as number
    const row = await callPipelineRoute('GET', `/api/notes/readOne/${published}?debug=pipeline`, { role: 'renderer' }) as Record<string, unknown>
    expect(row.$pipeline).toBeUndefined()
  })

  it('does not embed the trace without the debug flag', async () => {
    const row = await callPipelineRoute('GET', `/api/notes/readOne/${noteId}`, { role: 'admin' }) as Record<string, unknown>
    expect(row.$pipeline).toBeUndefined()
  })
})

describe('dev logging', () => {
  it('never logs outside dev (the default in the test environment)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await callPipelineRoute('GET', `/api/notes/readOne/${noteId}`, { role: 'admin' })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
