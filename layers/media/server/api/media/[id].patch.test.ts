import { describe, it, expect, beforeEach } from 'vitest'
import { eq, getTableColumns } from 'drizzle-orm'
import { createError } from 'h3'
import { createTestDb } from '../../../../../test/helpers/db'
import { create } from '../../../../core/server/utils/crud'
import builtMedia, { media } from '../../collections/media'

interface FakeEvent { body: Record<string, unknown> }

let db: ReturnType<typeof createTestDb>
let id: number

// The handler is a Nitro route: its auto-imported helpers are plain globals in a node test.
Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  requireAdmin: () => {},
  createError,
  requireId: () => id,
  readIfUnmodifiedSince: () => undefined,
  readBody: async (event: FakeEvent) => event.body,
  useDb: () => db,
  useRuntimeConfig: () => ({ kestrel: {} }),
})

const handler = (await import('./[id].patch')).default as unknown as (event: FakeEvent) => Promise<Record<string, unknown>>
const patch = (body: Record<string, unknown>) => handler({ body })

const cols = getTableColumns(media) as Record<string, never>
const row = () => db.select().from(media).where(eq(cols.id, id)).get() as Record<string, unknown>

beforeEach(() => {
  db = createTestDb()
  const created = create(db, builtMedia, { storageKey: 'a/one.png', folder: 'a', filename: 'one.png', mime: 'image/png', ext: 'png', size: 1 }) as { id: number }
  id = created.id
})

describe('PATCH /api/media/:id — EU AI Act disclosure', () => {
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
    await expect(patch({ aiSourceType: 'nonsense' })).rejects.toThrowError(expect.objectContaining({ statusCode: 400 }))
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
