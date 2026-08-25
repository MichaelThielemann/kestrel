import { describe, it, expect, beforeEach } from 'vitest'
import type { ValidationFailed } from '@kestrel/contracts'
import { eq, getTableColumns } from 'drizzle-orm'
import { createTestDb } from '../../../../../test/helpers/db.js'
import { runStepAsync } from '../../../../../test/helpers/run-effect.js'
import { create, createPipelineContext, ensureRevisionsTable, sqliteClientOf } from '@kestrel/core'
import builtMedia, { media } from '../../../src/server/collections/media.js'
import { buildMediaAssetPipelines } from '../../../src/server/pipelines/media-assets.js'
let db: ReturnType<typeof createTestDb>
let id: number

Object.assign(globalThis, { useRuntimeConfig: () => ({ kestrel: {} }), useDb: () => db })

const step = buildMediaAssetPipelines().find((d) => d.name === 'updateAsset')!.steps![0]!

const patch = async (body: Record<string, unknown>, expectedUpdatedAt?: number) => {
  const ctx = createPipelineContext({ op: 'updateAsset', id, db, input: body, work: { expectedUpdatedAt } })
  await runStepAsync(step.fn(ctx))
  return ctx.output as Record<string, unknown>
}

const cols = getTableColumns(media) as Record<string, never>
const row = () => db.select().from(media).where(eq(cols.id, id)).get() as Record<string, unknown>

beforeEach(() => {
  db = createTestDb()
  ensureRevisionsTable(sqliteClientOf(db), 'media')
  const created = create(db, builtMedia, { storageKey: 'a/one.png', folder: 'a', filename: 'one.png', mime: 'image/png', ext: 'png', size: 1 }) as { id: number }
  id = created.id
})

describe('POST /api/media/updateAsset/:id — EU AI Act disclosure', () => {
  it('persists both disclosure columns', async () => {
    await patch({ aiSourceType: 'algorithmicallyEnhanced', aiNote: 'upscaled' })
    expect(row()).toMatchObject({ aiSourceType: 'algorithmicallyEnhanced', aiNote: 'upscaled' })
  })

  it('clears the classification with an explicit null', async () => {
    await patch({ aiSourceType: 'trainedAlgorithmicMedia', aiNote: 'Midjourney v7' })
    await patch({ aiSourceType: null })
    expect(row().aiSourceType).toBeNull()
    expect(row().aiNote).toBe('Midjourney v7') // untouched — only the sent keys are written
  })

  it('rejects an unknown source type with a 400 instead of writing it', async () => {
    await expect(patch({ aiSourceType: 'nonsense' })).rejects.toThrowError(expect.objectContaining({ _tag: 'ValidationFailed' }) as ValidationFailed)
    expect(row().aiSourceType).toBeNull()
  })

  it('stores a blanked note as null rather than an empty string a badge would render', async () => {
    await patch({ aiSourceType: 'trainedAlgorithmicMedia', aiNote: 'Midjourney v7' })
    await patch({ aiNote: '   ' })
    expect(row().aiNote).toBeNull()
  })

  it('leaves the columns alone when the body does not mention them', async () => {
    await patch({ aiSourceType: 'trainedAlgorithmicMedia', aiNote: 'note' })
    await patch({ translations: { en: { alt: 'a kitten' } } })
    expect(row()).toMatchObject({ aiSourceType: 'trainedAlgorithmicMedia', aiNote: 'note' })
  })
})

describe('POST /api/media/updateAsset/:id — optimistic concurrency', () => {
  const updatedAt = () => new Date(row().updatedAt as never).getTime()

  it('accepts a save carrying the baseline it loaded', async () => {
    await expect(patch({ translations: { en: { alt: 'fresh' } } }, updatedAt())).resolves.toMatchObject({ id })
  })

  it('409s a save whose baseline is stale', async () => {
    await expect(patch({ translations: { en: { alt: 'stale' } } }, updatedAt() - 1000))
      .rejects.toThrowError(expect.objectContaining({ _tag: 'Conflict' }))
  })
})
