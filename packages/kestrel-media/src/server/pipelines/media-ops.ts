import { Effect } from 'effect'
import { ValidationFailed } from '@michaelthielemann/kestrel-contracts'
import { DEFAULT_IMAGE_POLICY, dbOf, definePipeline, eventOf } from '@michaelthielemann/kestrel-core'
import type { PipelineDef, StepDef } from '@michaelthielemann/kestrel-core'
import { useStorageDriver, mediaRuntimeConfig } from '../utils/storage.js'
import { useMediaDbFor } from '../db/media-db.js'
import { runBackfill } from '../utils/backfill.js'
import { ensureFolder } from '../utils/folders.js'
import { requireMediaCollection } from '../utils/media-enabled.js'
import { deleteAffected, previewDelete } from '../utils/media-ops.js'
import { sanitizeFolder } from '../utils/naming.js'
import { coerceOpItems, runRelocation, type MediaOp, type OpType } from '../utils/relocate-ops.js'
import { MEDIA_WRITE_ACCESS } from './shared.js'

const on = { collection: 'media' }

/** move/copy/rename differ only in the op they build from the same body — one delegate step each, straight
 *  onto the shared relocation runner. */
function relocateStep(type: OpType): StepDef {
  return {
    name: type,
    fn: (ctx) => Effect.gen(function* () {
      requireMediaCollection()
      const event = eventOf(ctx)
      ctx.output = yield* Effect.promise(() => runRelocation(event, (items, body): MediaOp => type === 'rename'
        ? { type, items, name: typeof body.name === 'string' ? body.name : '' }
        : { type, items, dest: typeof body.dest === 'string' ? body.dest : '' }))
    }),
  }
}

/**
 *
 */
export function buildMediaOpPipelines(): PipelineDef[] {
  return [
    ...(['move', 'copy', 'rename'] as const).map((type) => definePipeline({
      name: type,
      on,
      access: MEDIA_WRITE_ACCESS,
      steps: [relocateStep(type)],
    })),
    definePipeline({
      name: 'delete',
      on,
      access: MEDIA_WRITE_ACCESS,
      steps: [{
        name: 'deleteItems',
        fn: (ctx) => Effect.gen(function* () {
          requireMediaCollection()
          const body = ctx.input as Record<string, unknown> | null | undefined
          const items = coerceOpItems(body?.items)
          if (!items.length) return yield* Effect.fail(new ValidationFailed({ issues: [{ path: ['items'], message: 'No items to delete' }] }))
          const mediaDb = useMediaDbFor(dbOf(ctx)).db
          ctx.output = body?.dryRun === true
            ? previewDelete(mediaDb, dbOf(ctx), items)
            : yield* Effect.promise(() => deleteAffected(mediaDb, useStorageDriver(), items))
        }),
      }],
    }),
    definePipeline({
      name: 'folders',
      on,
      access: MEDIA_WRITE_ACCESS,
      steps: [{
        name: 'createFolder',
        fn: (ctx) => Effect.gen(function* () {
          requireMediaCollection()
          const body = ctx.input as Record<string, unknown> | null | undefined
          const path = sanitizeFolder(typeof body?.path === 'string' ? body.path : '')
          if (!path) return yield* Effect.fail(new ValidationFailed({ issues: [{ path: ['path'], message: 'A non-empty folder path is required' }] }))
          // ensureDir (mkdir, can throw ENAMETOOLONG/ENOTDIR/etc.) runs BEFORE the row commit — a folder row
          // with no backing directory would list forever with every upload/retry into it failing the same way.
          yield* Effect.promise(async () => useStorageDriver().ensureDir?.(path))
          ensureFolder(useMediaDbFor(dbOf(ctx)).db, path)
          ctx.output = { path }
        }),
      }],
    }),
    definePipeline({
      name: 'backfill',
      on,
      access: MEDIA_WRITE_ACCESS,
      steps: [{
        /**
         * Admin-triggered variant backfill/prune (the Mediathek "Regenerate/Prune" action). `{ check: true }`
         * is a dry-run reporting the plan (rows / would-generate / would-prune) — the UI shows it before
         * applying. Synchronous: fine for a dry-run and moderate libraries; a very large library should run
         * the `media:backfill` task on a schedule instead (a full-original GET + sharp per row).
         */
        name: 'runBackfill',
        fn: (ctx) => Effect.gen(function* () {
          requireMediaCollection()
          const body = ctx.input as { check?: boolean } | null | undefined
          const policy = mediaRuntimeConfig().imagePolicy ?? DEFAULT_IMAGE_POLICY
          ctx.output = yield* Effect.promise(() => runBackfill(useMediaDbFor(dbOf(ctx)).db, useStorageDriver(), policy, { check: !!body?.check }))
        }),
      }],
    }),
  ]
}
