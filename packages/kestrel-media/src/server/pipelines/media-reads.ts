import { Effect } from 'effect'
import { MAX_BULK_IDS, dbOf, definePipeline, parseIdList, primaryLocale, requireRecordId } from '@kestrel/core'
import type { PipelineDef } from '@kestrel/core'
import { useStorageDriver } from '../utils/storage.js'
import { useMediaDbFor } from '../db/media-db.js'
import { listLibrary } from '../utils/library.js'
import { requireMediaCollection } from '../utils/media-enabled.js'
import { resolveManyByIds } from '../utils/resolve.js'
import { findMediaUsages } from '../utils/usages.js'
import { MEDIA_READ_ACCESS } from './shared.js'

const on = { collection: 'media' }

/**
 *
 */
export function buildMediaReadPipelines(): PipelineDef[] {
  return [
    definePipeline({
      name: 'library',
      on,
      read: true,
      access: MEDIA_READ_ACCESS,
      steps: [{
        name: 'listLibrary',
        fn: (ctx) => Effect.sync(() => {
          requireMediaCollection()
          const query = ctx.input as Record<string, unknown>
          const driver = useStorageDriver()
          ctx.output = listLibrary(useMediaDbFor(dbOf(ctx)).db, {
            folder: typeof query.folder === 'string' ? query.folder : '',
            search: typeof query.search === 'string' ? query.search : undefined,
            type: query.type === 'image' ? 'image' : 'all',
            page: query.page ? Number(query.page) : undefined,
            perPage: query.perPage ? Number(query.perPage) : undefined,
            sort: typeof query.sort === 'string' ? query.sort : undefined,
          }, (key) => driver.publicUrl(key))
        }),
      }],
    }),
    definePipeline({
      name: 'resolve',
      on,
      read: true,
      access: MEDIA_READ_ACCESS,
      steps: [{
        name: 'resolveByIds',
        fn: (ctx) => Effect.sync(() => {
          requireMediaCollection()
          const q = ctx.input as Record<string, unknown>
          // Same id contract (dedupe, 400 on garbage, MAX_BULK_IDS cap) as every other bulk-id endpoint.
          const ids = q.ids ? parseIdList(q.ids, MAX_BULK_IDS) : []
          const locale = typeof q.locale === 'string' ? q.locale : primaryLocale()
          const driver = useStorageDriver()
          ctx.output = { data: resolveManyByIds(useMediaDbFor(dbOf(ctx)).db, ids, locale, (k) => driver.publicUrl(k)) }
        }),
      }],
    }),
    definePipeline({
      name: 'usages',
      on,
      read: true,
      access: MEDIA_READ_ACCESS,
      steps: [{
        name: 'findUsages',
        fn: (ctx) => Effect.gen(function* () {
          requireMediaCollection()
          const id = yield* requireRecordId(ctx)
          // Deliberately NOT useMediaDbFor(dbOf(ctx)): findMediaUsages scans every OTHER collection's
          // table by design (see usages.ts) — the media-scoped adapter would throw OwnershipViolation on
          // its very first (legitimate) foreign read.
          ctx.output = { id, usages: findMediaUsages(dbOf(ctx), id) }
        }),
      }],
    }),
  ]
}
