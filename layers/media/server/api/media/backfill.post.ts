import { runBackfill } from '../../utils/backfill'
import { useStorageDriver, mediaRuntimeConfig } from '../../../../core/server/utils/storage'
import { DEFAULT_IMAGE_POLICY } from '../../../../core/server/utils/kestrel-config'
import { requireMediaCollection } from '../../utils/media-enabled'

/**
 * Admin-triggered variant backfill/prune (the Mediathek "Regenerate/Prune" action). `{ check: true }` is a
 * dry-run reporting the plan (rows / would-generate / would-prune) — the UI shows it before applying.
 * Synchronous: fine for a dry-run and moderate libraries; a very large library should run the
 * `media:backfill` task on a schedule instead (a full-original GET + sharp per row).
 */
export default defineEventHandler(async (event) => {
  requireAdmin(event)
  requireMediaCollection()
  const body = (await readBody(event).catch(() => ({}))) as { check?: boolean }
  const policy = mediaRuntimeConfig().imagePolicy ?? DEFAULT_IMAGE_POLICY
  return runBackfill(useDb(), useStorageDriver(), policy, { check: !!body?.check })
})
