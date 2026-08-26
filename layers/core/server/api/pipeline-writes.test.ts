import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createError } from 'h3'
import { Effect } from 'effect'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { callPipelineRoute, pipelineEvent, pipelineRouteHandler, statusOf, usePipelineRouteDb } from '../../../../test/helpers/pipeline-route'
import { buildCollection, clearPipelines, clearRegistry, create, defineCollection, desiredSchema, diffSchema, outboxContent, registerAfterStep, registerCollection, renderSqlite, revisionsTable  } from '@michaelthielemann/kestrel-core'
import type { StepDef } from '@michaelthielemann/kestrel-core'
const notes = buildCollection(defineCollection({
  name: 'notes', mode: 'multi', translatable: false, status: true,
  fields: { title: { type: 'text', required: true } },
}))
const settings = buildCollection(defineCollection({
  name: 'settings', mode: 'single',
  fields: { title: { type: 'text', required: true } },
}))
const docs = buildCollection(defineCollection({
  name: 'docs', mode: 'multi', translatable: true,
  fields: { title: { type: 'text', required: true } },
}))

let db: ReturnType<typeof drizzle>
let noteId: number

beforeEach(() => {
  clearRegistry()
  clearPipelines()
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([
    outboxContent, notes.table, settings.table, docs.table,
    revisionsTable('notes'), revisionsTable('settings'), revisionsTable('docs'),
  ]), {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  usePipelineRouteDb(db)
  registerCollection(notes)
  registerCollection(settings)
  registerCollection(docs)
  noteId = (create(db, notes, { title: 'A' }) as Record<string, unknown>).id as number
})
afterEach(() => { clearRegistry(); clearPipelines() })

const afterStep = (name: string, fn: (ctx: Parameters<StepDef['fn']>[0]) => void): StepDef => ({ name, fn: (ctx) => Effect.sync(() => fn(ctx)) })

describe('pipeline route — URL resolution', () => {
  it('404s an unknown collection', async () => {
    await expect(callPipelineRoute('GET', '/api/nope/readMany', { role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 404, statusMessage: 'Unknown collection: nope' })
  })

  it('404s an unknown pipeline name on a known collection', async () => {
    await expect(callPipelineRoute('GET', '/api/notes/nonsense', { role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 404, statusMessage: 'Unknown pipeline: nonsense' })
  })

  it('404s a collection-less URL that names a collection operation', async () => {
    await expect(callPipelineRoute('POST', '/api/createOne', { role: 'admin', body: { title: 'B' } }))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('405s a read pipeline reached by POST and a write pipeline reached by GET', async () => {
    await expect(callPipelineRoute('POST', '/api/notes/readMany', { role: 'admin' })).rejects.toMatchObject({ statusCode: 405 })
    await expect(callPipelineRoute('GET', '/api/notes/createOne', { role: 'admin' })).rejects.toMatchObject({ statusCode: 405 })
    await expect(callPipelineRoute('DELETE', `/api/notes/deleteOne/${noteId}`, { role: 'admin' })).rejects.toMatchObject({ statusCode: 405 })
  })

  it('405s a batch write aimed at a singleton', async () => {
    await expect(callPipelineRoute('POST', '/api/settings/deleteMany', { role: 'admin', body: { ids: [1] } }))
      .rejects.toMatchObject({ statusCode: 405 })
  })
})

// The route carries no authorization check of its own — the pipeline's access gate is the enforcement
// point, and it must refuse every non-admin principal before a step touches the database.
describe('pipeline route — write access gate', () => {
  for (const role of ['anonymous', 'renderer', undefined]) {
    const who = role ?? 'a principal-less caller'

    it(`refuses a create by ${who}`, async () => {
      await expect(callPipelineRoute('POST', '/api/notes/createOne', { role, body: { title: 'B' } }))
        .rejects.toMatchObject({ statusCode: 401 })
    })

    it(`refuses a delete by ${who}`, async () => {
      await expect(callPipelineRoute('POST', `/api/notes/deleteOne/${noteId}`, { role }))
        .rejects.toThrowError(/Authentication required/)
    })

    it(`refuses a batch update by ${who}`, async () => {
      await expect(callPipelineRoute('POST', '/api/notes/updateMany', { role, body: { ids: [noteId], patch: { status: 'published' } } }))
        .rejects.toMatchObject({ statusCode: 401 })
    })
  }

  it('lets the admin through on each of them', async () => {
    await expect(callPipelineRoute('POST', '/api/notes/createOne', { role: 'admin', body: { title: 'B' } })).resolves.toMatchObject({ title: 'B' })
    await expect(callPipelineRoute('POST', '/api/notes/updateMany', { role: 'admin', body: { ids: [noteId], patch: { status: 'published' } } })).resolves.toMatchObject({ count: 1 })
    await expect(callPipelineRoute('POST', `/api/notes/deleteOne/${noteId}`, { role: 'admin' })).resolves.toMatchObject({ count: 1, ids: [noteId] })
  })

  it('rejects a cross-origin admin write with 403', async () => {
    await expect(callPipelineRoute('POST', '/api/notes/createOne', { role: 'admin', secFetchSite: 'cross-site', body: { title: 'B' } }))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('answers a create with 201', async () => {
    const event = pipelineEvent('POST', '/api/notes/createOne', { role: 'admin', body: { title: 'B' } })
    await pipelineRouteHandler(event)
    expect(statusOf(event)).toBe(201)
  })
})

describe('pipeline route — batch envelopes', () => {
  it('deleteMany and duplicate take { ids }', async () => {
    const created = await callPipelineRoute('POST', '/api/notes/duplicate', { role: 'admin', body: { ids: [noteId] } }) as { id: number }[]
    expect(created).toHaveLength(1)
    await expect(callPipelineRoute('POST', '/api/notes/deleteMany', { role: 'admin', body: { ids: [created[0]!.id] } }))
      .resolves.toMatchObject({ count: 1 })
  })

  it('enforces the shared id contract on the envelope', async () => {
    await expect(callPipelineRoute('POST', '/api/notes/deleteMany', { role: 'admin', body: { ids: [] } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(callPipelineRoute('POST', '/api/notes/deleteMany', { role: 'admin', body: { ids: [0] } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(callPipelineRoute('POST', '/api/notes/deleteMany', { role: 'admin', body: { ids: Array.from({ length: 501 }, (_, i) => i + 1) } }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s the whole batch when one id does not exist (all-or-nothing)', async () => {
    await expect(callPipelineRoute('POST', '/api/notes/deleteMany', { role: 'admin', body: { ids: [noteId, 9999] } }))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('400s a status patch on a collection without a status column', async () => {
    await expect(callPipelineRoute('POST', '/api/settings/updateMany', { role: 'admin', body: { ids: [1], patch: { status: 'published' } } }))
      .rejects.toMatchObject({ statusCode: 405 })
  })
})

describe('pipeline route — singleton save (updateOne without an id)', () => {
  const save = (body: unknown) => callPipelineRoute('POST', '/api/settings/updateOne', { role: 'admin', body })

  it('writes the row and returns it', async () => {
    await expect(save({ title: 'Hello' })).resolves.toMatchObject({ title: 'Hello' })
  })

  it('runs a critical after-step (like writeRedirects) with the saved row, and its rejection becomes the response', async () => {
    registerAfterStep({
      critical: true,
      ops: ['updateOne'],
      step: afterStep('writeRedirects', () => { throw createError({ statusCode: 500, statusMessage: 'artifact is stale' }) }),
    })
    await expect(save({ title: 'Hello' })).rejects.toMatchObject({ statusCode: 500, statusMessage: 'artifact is stale' })
  })

  it('does not run after-steps when validation rejects the body', async () => {
    let ran = false
    registerAfterStep({ critical: true, ops: ['updateOne'], step: afterStep('writeRedirects', () => { ran = true }) })
    await expect(save({ title: '' })).rejects.toMatchObject({ statusCode: 400 })
    expect(ran).toBe(false)
  })

  it('a non-critical after-step failure is swallowed — the save still succeeds', async () => {
    registerAfterStep({ critical: false, ops: ['updateOne'], step: afterStep('reindexRefs', () => { throw new Error('index down') }) })
    await expect(save({ title: 'Hello' })).resolves.toMatchObject({ title: 'Hello' })
  })
})

describe('pipeline route — optimistic concurrency', () => {
  it('409s an update whose baseline is stale', async () => {
    const row = await callPipelineRoute('POST', `/api/notes/updateOne/${noteId}`, { role: 'admin', body: { title: 'B' } }) as { updatedAt: number }
    await expect(callPipelineRoute('POST', `/api/notes/updateOne/${noteId}`, {
      role: 'admin', body: { title: 'C' }, expectedUpdatedAt: Number(row.updatedAt) - 1,
    })).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('pipeline route — UNIQUE-constraint conflict', () => {
  it('409s a duplicate locale within one translation group, as a tagged Conflict', async () => {
    const en = await callPipelineRoute('POST', '/api/docs/createOne', { role: 'admin', body: { title: 'A' } }) as { translationGroup: string }
    await expect(callPipelineRoute('POST', '/api/docs/createOne', {
      role: 'admin', body: { title: 'B', translationGroup: en.translationGroup },
    })).rejects.toMatchObject({ statusCode: 409, statusMessage: 'Conflict: duplicate locale "en"', data: { kind: 'duplicate' } })
  })
})

describe('updateMany — bulk patch validation', () => {
  it('400s a patch that fails the collection schema', async () => {
    await expect(callPipelineRoute('POST', '/api/notes/updateMany', {
      role: 'admin', body: { ids: [noteId], patch: { title: 123 } },
    })).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Invalid input: expected string, received number' })
  })

  it('strips guarded columns from a bulk patch instead of persisting them', async () => {
    await callPipelineRoute('POST', '/api/notes/updateMany', {
      role: 'admin', body: { ids: [noteId], patch: { title: 'B', id: 999 } },
    })
    const { data } = await callPipelineRoute('GET', '/api/notes/readMany', { role: 'admin' }) as { data: Array<Record<string, unknown>> }
    expect(data).toHaveLength(1)
    expect(data[0]!.id).toBe(noteId)
    expect(data[0]!.title).toBe('B')
  })
})
