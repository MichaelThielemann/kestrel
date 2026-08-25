import { eq, getTableColumns } from 'drizzle-orm'
import { Effect } from 'effect'
import { Conflict, NotFound, ValidationFailed } from '@kestrel/contracts'
import { dbOf, definePipeline, requireRecordId } from '@kestrel/core'
import type { PipelineDef } from '@kestrel/core'
import { useStorageDriver } from '../utils/storage.js'
import { useMediaDbFor } from '../db/media-db.js'
import builtMedia, { media } from '../collections/media.js'
import { requireMediaCollection } from '../utils/media-enabled.js'
import { emitMediaOutbox, emitMediaWrite, type EmitFacts } from '../utils/media-write.js'
import { deleteAffected } from '../utils/media-ops.js'
import { mergeTranslations, type Translations } from '../utils/translations.js'
import { MEDIA_WRITE_ACCESS } from './shared.js'

const on = { collection: 'media' }

const AI_KEYS = ['aiSourceType', 'aiNote'] as const

/**
 * The EU AI Act disclosure columns are top-level (not per-locale), so they are patched as plain siblings of
 * `translations`. Only the keys the body actually sent are written — omitting one must not clear it. The
 * allow-list of source types is NOT duplicated here: the collection's own update schema (built from the
 * `choice` field's `choices`) is the single source of truth, so an unknown value 400s instead of storing.
 */
function readAiDisclosure(body: Record<string, unknown> | undefined | null): Effect.Effect<Record<string, unknown>, ValidationFailed> {
  const sent = AI_KEYS.filter((k) => Object.hasOwn(body ?? {}, k))
  if (!sent.length) return Effect.succeed({})
  const parsed = builtMedia.update.safeParse(Object.fromEntries(sent.map((k) => [k, body![k]])))
  if (!parsed.success) {
    return Effect.fail(new ValidationFailed({ issues: [{ path: ['aiSourceType'], message: parsed.error.issues[0]?.message ?? 'unknown value' }] }))
  }
  const value = parsed.data as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  for (const k of sent) patch[k] = value[k] ?? null
  // A blanked note must round-trip as "no note", not as an empty string a badge would render as blank text.
  if (patch.aiNote === '') patch.aiNote = null
  return Effect.succeed(patch)
}

/**
 *
 */
export function buildMediaAssetPipelines(): PipelineDef[] {
  return [
    definePipeline({
      name: 'updateAsset',
      on,
      access: MEDIA_WRITE_ACCESS,
      steps: [{
        name: 'updateAsset',
        fn: (ctx) => Effect.gen(function* () {
          requireMediaCollection()
          const id = yield* requireRecordId(ctx)
          const body = ctx.input as Record<string, unknown> | null | undefined
          const cols = getTableColumns(media) as Record<string, never>
          const db = useMediaDbFor(dbOf(ctx)).db
          const expectedUpdatedAt = ctx.work.expectedUpdatedAt as number | undefined
          const patch: Record<string, unknown> = { updatedAt: new Date(ctx.facts.now) }
          // `folder` is immutable here: relocating a file means moving its storage object and every
          // derivative, which belongs to the media-library slice. Writing only the column would desync it
          // from the folder baked into storageKey, which is what the public URL is built from.
          const translations = body?.translations
          const mergesTranslations = Boolean(translations) && typeof translations === 'object' && !Array.isArray(translations)
          const needsCurrent = expectedUpdatedAt !== undefined || mergesTranslations
          const current = needsCurrent
            ? db.select().from(media).where(eq(cols.id, id)).get() as { translations?: Translations; updatedAt?: Date } | undefined
            : undefined
          // Optimistic concurrency: honor the same X-Kestrel-If-Unmodified-Since precondition the collection CRUD
          // does, so two media-viewer tabs editing the same asset's alt text can't silently overwrite each other.
          if (expectedUpdatedAt !== undefined && current) {
            const cur = current.updatedAt instanceof Date ? current.updatedAt.getTime() : new Date(current.updatedAt as never).getTime()
            if (cur !== expectedUpdatedAt) {
              return yield* Effect.fail(new Conflict({
                field: 'updatedAt',
                value: String(cur),
                details: { kind: 'stale', expectedUpdatedAt: String(expectedUpdatedAt), actualUpdatedAt: String(cur) },
              }))
            }
          }
          if (mergesTranslations) {
            // Media keeps all locales in one JSON column. Deep-merge per locale so a partial patch (e.g. just
            // `en.alt` from the media viewer) keeps the other locales AND the locale's other fields intact.
            patch.translations = mergeTranslations(current?.translations, translations as Translations)
          }
          Object.assign(patch, yield* readAiDisclosure(body))
          const facts: EmitFacts = { occurredAt: ctx.facts.now, correlationId: ctx.facts.correlationId, causation: ctx.facts.causation }
          // The row update and its outbox row land or roll back together (see emitMediaOutbox's TSDoc).
          // The prior-row read is one extra indexed SELECT inside the same transaction — worth it for a
          // real `before` (contract uniformity with every other emitMediaOutbox call site) over an
          // identity-only stub.
          const row = db.transaction((tx) => {
            const before = tx.select().from(media).where(eq(cols.id, id)).get() as Record<string, unknown> | undefined
            const updated = tx.update(media).set(patch).where(eq(cols.id, id)).returning().get() as Record<string, unknown> | undefined
            if (updated) emitMediaOutbox(db, before ?? { id }, updated, facts)
            return updated
          })
          if (!row) return yield* Effect.fail(new NotFound({ collection: 'media', id }))
          emitMediaWrite({ id }, row) // alt/title/description changed → re-render embedding pages (fresh alt text)
          ctx.output = row
        }),
      }],
    }),
    definePipeline({
      name: 'deleteAsset',
      on,
      access: MEDIA_WRITE_ACCESS,
      steps: [{
        name: 'deleteAsset',
        fn: (ctx) => Effect.gen(function* () {
          requireMediaCollection()
          const id = yield* requireRecordId(ctx)
          const cols = getTableColumns(media) as Record<string, never>
          const db = useMediaDbFor(dbOf(ctx)).db
          // deleteAffected silently no-ops on a missing row, so keep an explicit 404 guard.
          const row = db.select({ id: cols.id }).from(media).where(eq(cols.id, id)).get() as { id: number } | undefined
          if (!row) return yield* Effect.fail(new NotFound({ collection: 'media', id }))
          yield* Effect.promise(() => deleteAffected(db, useStorageDriver(), [{ type: 'file', id }]))
          ctx.output = { deleted: true, id }
        }),
      }],
    }),
  ]
}
