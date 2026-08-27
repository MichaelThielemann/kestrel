import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import { sql } from 'drizzle-orm'
import { buildDefaultWritePipelines, resolveReadPipeline, resolveWritePipeline, runWrite } from '../../../src/server/pipeline/defaults.js'
import { clearPipelines, registerAfterStep } from '../../../src/server/pipeline/registry.js'
import { clearRegistry, registerCollection } from '../../../src/server/utils/registry.js'
import { createPipelineContext } from '../../../src/server/pipeline/context.js'
import { runPipelineSync } from '../../../src/server/pipeline/runner.js'
import { buildCollection } from '../../../src/server/schema/buildCollection.js'
import { defineCollection } from '../../../src/index.js'
import { duplicateMany, list } from '../../../src/server/utils/crud.js'
import { createTestDb } from '../../../../../test/helpers/db.js'
import { eventsOf, type WriteEvent } from '../../../src/server/pipeline/steps/shared.js'
import { desiredSchema } from '../../../src/server/schema/desired.js'
import { diffSchema } from '../../../src/server/schema/diff.js'
import { renderSqlite } from '../../../src/server/schema/render-sqlite.js'
import { revisionsTable } from '../../../src/server/db/revisions.js'
import type { StepDef } from '../../../src/server/pipeline/types.js'

type Row = Record<string, unknown>

// Not pageLike — so a createOne run must SKIP `resolveSlug` on its condition rather than run it.
const notes = buildCollection(defineCollection({
  name: 'notes', mode: 'multi', status: true,
  fields: { title: { type: 'text', required: true }, code: { type: 'text', unique: true } },
}))

// A `unique` slug derived from the title — the duplicate pipeline must see each committed copy when it
// de-dupes the next one.
const galleries = buildCollection(defineCollection({
  name: 'gal', mode: 'multi',
  fields: { title: { type: 'text', required: true }, slug: { type: 'slug', unique: true, options: { from: 'title' } } },
}))

// `notes` is admin-only, so a run driven through the engine's own (non-trusted) evaluators needs a principal.
const ADMIN = { userId: 'admin', role: 'admin' }

const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', status: true, pageLike: true,
  fields: { title: { type: 'text', required: true } },
}))

const SEALED = ['validate', 'checkConcurrency', 'assertAllExist', 'assertUnique', 'persist', 'emitEvents', 'loadRollbackTarget']

const stepsOf = (op: string): StepDef[] => resolveWritePipeline('notes', op).steps
const namesOf = (op: string): string[] => stepsOf(op).map((s) => s.name)

let db: ReturnType<typeof createTestDb>
let events: WriteEvent[]

beforeEach(() => {
  clearPipelines()
  clearRegistry()
  db = createTestDb()
  for (const stmt of renderSqlite(diffSchema(desiredSchema([notes.table, galleries.table, revisionsTable('notes'), revisionsTable('gal')]), {}))) db.run(sql.raw(stmt))
  events = []
  registerAfterStep({
    critical: false,
    step: {
      name: 'probe',
      fn: (ctx) => Effect.sync(() => {
        for (const e of eventsOf(ctx)) {
          events.push({ def: e.def, before: e.before ? { ...e.before } : null, after: e.after ? { ...e.after } : null })
        }
      }),
    },
  })
})

describe('default write pipelines — composition', () => {
  it('composes each standard write op from the declared step list', () => {
    expect(namesOf('createOne')).toEqual(['validate', 'resolveLocale', 'resolveSlug', 'transform', 'assertUnique', 'persist', 'emitEvents'])
    expect(namesOf('createMany')).toEqual(['validate', 'resolveLocale', 'resolveSlug', 'transform', 'assertUnique', 'persist', 'emitEvents'])
    expect(namesOf('updateOne')).toEqual(['loadBefore', 'checkConcurrency', 'validate', 'resolveLocale', 'resolveSlug', 'transform', 'assertUnique', 'persist', 'emitEvents'])
    expect(namesOf('updateMany')).toEqual(['loadBefore', 'assertAllExist', 'validate', 'persist', 'emitEvents'])
    expect(namesOf('deleteMany')).toEqual(['loadBefore', 'assertAllExist', 'persist', 'emitEvents'])
  })

  it('gives deleteOne deleteMany‘s own step list — one delete implementation, one flat trace', () => {
    expect(namesOf('deleteOne')).toEqual(namesOf('deleteMany'))
    expect(stepsOf('deleteOne').map((s) => s.fn)).toEqual(stepsOf('deleteMany').map((s) => s.fn))
  })

  it('ships `duplicate` and `rollback` as custom pipelines alongside the standard ops', () => {
    expect(buildDefaultWritePipelines().map((d) => d.name)).toEqual([
      'createOne', 'createMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'rollback', 'duplicate',
    ])
    expect(namesOf('duplicate')).toEqual(['duplicateRecords'])
    expect(namesOf('rollback')).toEqual(['loadRollbackTarget', 'persist', 'emitEvents'])
  })

  it('keeps every write step synchronous and seals the ones the engine relies on', () => {
    for (const op of ['createOne', 'createMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'rollback', 'duplicate']) {
      for (const step of stepsOf(op)) {
        expect(step.sync, `${op}.${step.name} must be sync`).toBe(true)
        expect(Boolean(step.sealed), `${op}.${step.name} sealed`).toBe(SEALED.includes(step.name))
      }
    }
  })

  it('declares an access gate on every write pipeline (the engine denies a pipeline without one)', () => {
    for (const def of buildDefaultWritePipelines()) expect(def.access).toEqual({ role: 'admin' })
  })
})

describe('default write pipelines — trace', () => {
  it('records the createOne step sequence and why resolveSlug was skipped', () => {
    const ctx = createPipelineContext({ op: 'createOne', collection: notes, db, input: { title: 'A' } })
    runWrite<Row>('createOne', { collection: notes, db, input: { title: 'A' }, trace: ctx.trace })
    const trace = ctx.trace.toJSON()

    // The probe after-step (registered in beforeEach) also lands in the trace — filter to the main phase.
    expect(trace.steps.filter((s) => s.phase === 'main').map((s) => s.name))
      .toEqual(['validate', 'resolveLocale', 'resolveSlug', 'transform', 'assertUnique', 'persist', 'emitEvents'])
    const slug = trace.steps.find((s) => s.name === 'resolveSlug')!
    expect(slug.status).toBe('skipped-condition')
    expect(slug.reason).toBe('collection is pageLike')
    expect(trace.steps.filter((s) => s.name !== 'resolveSlug').every((s) => s.status === 'ok')).toBe(true)
    expect(trace.gates.map((g) => g.gate)).toEqual(['ipAllowlist', 'csrf', 'access'])
  })
})

describe('createMany', () => {
  it('inserts every element in ONE atomic block and emits after it', () => {
    const rows = runWrite<Row[]>('createMany', { collection: notes, db, input: [{ title: 'A' }, { title: 'B' }] })
    expect(rows.map((r) => r.title)).toEqual(['A', 'B'])
    expect(list(db, notes, { locale: 'all' }).total).toBe(2)
    expect(events).toHaveLength(2)
    for (const e of events) expect(e.before).toBeNull()
  })

  it('rolls the whole batch back when one element fails, and emits nothing', () => {
    runWrite<Row>('createOne', { collection: notes, db, input: { title: 'Taken', code: 'x' } })
    events.length = 0

    expect(() => runWrite<Row[]>('createMany', { collection: notes, db, input: [{ title: 'A', code: 'a' }, { title: 'B', code: 'x' }] }))
      .toThrowError(expect.objectContaining({ _tag: 'Conflict', field: 'code', value: 'x' }))
    expect(list(db, notes, { locale: 'all' }).total).toBe(1) // only the pre-existing row
    expect(events).toHaveLength(0)
  })

  it('rejects a non-array payload with a 400', () => {
    expect(() => runWrite<Row[]>('createMany', { collection: notes, db, input: { title: 'A' } }))
      .toThrowError(/array of records|400/)
  })
})

describe('duplicate pipeline', () => {
  it('copies each id sequentially, so a later copy de-dupes against the ones already committed', async () => {
    const src = runWrite<Row>('createOne', { collection: galleries, db, input: { title: 'Wedding' } })
    events.length = 0

    const copies = await duplicateMany(db, galleries, [src.id as number, src.id as number])
    expect(copies.map((r) => r.slug)).toEqual(['wedding-copy', 'wedding-copy-2'])
    expect(copies.map((r) => r.title)).toEqual(['Wedding (copy)', 'Wedding (copy)'])
    expect(events).toHaveLength(2) // each copy goes through createOne's emitEvents
  })

  it('is best-effort: the first failing id throws its own status', async () => {
    await expect(duplicateMany(db, galleries, [999_999])).rejects.toThrowError(/not found|404/)
  })
})

describe('default read pipelines — composition', () => {
  it('composes readMany and readOne from their declared step lists', () => {
    expect(resolveReadPipeline('notes', 'readMany').steps.map((s) => s.name))
      .toEqual(['parseQuery', 'fetch', 'attachMeta', 'populate', 'validateOut'])
    expect(resolveReadPipeline('notes', 'readOne').steps.map((s) => s.name))
      .toEqual(['fetch', 'populate', 'validateOut'])
  })

  it('seals fetch, populate and validateOut — the steps that enforce publishedOnly/publicOnly scoping and the select-schema guarantee', () => {
    for (const op of ['readMany', 'readOne']) {
      for (const step of resolveReadPipeline('notes', op).steps) {
        const shouldBeSealed = step.name === 'fetch' || step.name === 'populate' || step.name === 'validateOut'
        expect(Boolean(step.sealed), `${op}.${step.name} sealed`).toBe(shouldBeSealed)
      }
    }
  })

  it('declares admin-only access for a collection that is not publicly routable', () => {
    expect(resolveReadPipeline('notes', 'readMany').gates.access).toEqual({ role: 'admin', scope: 'all' })
    expect(resolveReadPipeline('notes', 'readOne').gates.access).toEqual({ role: 'admin', scope: 'all' })
  })

  it('declares public published-only access for a pageLike collection', () => {
    registerCollection(pages)
    expect(resolveReadPipeline('pages', 'readMany').gates.access).toEqual({ public: true, scope: 'published' })
    expect(resolveReadPipeline('pages', 'readOne').gates.access).toEqual({ public: true, scope: 'published' })
  })
})

describe('default read pipelines — trace', () => {
  it('records the readMany step sequence and skips populate at depth 0', () => {
    runWrite<Row>('createOne', { collection: notes, db, input: { title: 'A' } })
    const ctx = createPipelineContext({ op: 'readMany', collection: notes, db, input: { locale: 'all' }, principal: ADMIN })
    runPipelineSync(resolveReadPipeline('notes', 'readMany'), ctx)
    const trace = ctx.trace.toJSON()

    expect(trace.steps.map((s) => s.name)).toEqual(['parseQuery', 'fetch', 'attachMeta', 'populate', 'validateOut'])
    const populateEntry = trace.steps.find((s) => s.name === 'populate')!
    expect(populateEntry.status).toBe('skipped-condition')
    expect(populateEntry.reason).toBe('depth > 0')
    expect(trace.steps.filter((s) => s.name !== 'populate').every((s) => s.status === 'ok')).toBe(true)
    expect((ctx.output as { data: unknown[] }).data).toHaveLength(1)
  })

  it('runs populate (not skipped) once depth > 0', () => {
    const ctx = createPipelineContext({ op: 'readMany', collection: notes, db, input: { locale: 'all', depth: 1 }, principal: ADMIN })
    runPipelineSync(resolveReadPipeline('notes', 'readMany'), ctx)
    expect(ctx.trace.toJSON().steps.find((s) => s.name === 'populate')!.status).toBe('ok')
  })
})

describe('default write pipelines — timestamps', () => {
  it('stamps createdAt and updatedAt from the one pipeline clock, not from separate column defaults', () => {
    // Every argument-less `new Date()` lands one millisecond later than the previous one, so any two
    // independent clock reads inside the write are guaranteed to disagree.
    const RealDate = Date
    let tick = 0
    vi.stubGlobal('Date', class extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length) super(...(args as [string | number | Date]))
        else super(RealDate.now() + tick++)
      }
    })
    try {
      const row = runWrite<Row>('createOne', { collection: notes, db, input: { title: 'A' } })
      expect(row.createdAt).toBeInstanceOf(RealDate)
      expect(row.updatedAt).toEqual(row.createdAt)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
