import { runBackfill } from '../../utils/backfill'
import { useStorageDriver, mediaRuntimeConfig } from '../../../../core/server/utils/storage'
import { DEFAULT_IMAGE_POLICY } from '../../../../core/server/utils/kestrel-config'

/**
 * Reconcile every media row's derivatives to the active variant registry: generate the missing sizes/formats
 * (from the stored original) and prune the deregistered ones. `{check:true}` is a dry-run (report only).
 * Trigger (like `db:migrate` — no `nuxi task run`): dev `GET /_nitro/tasks/media:backfill`; prod `runTask(
 * 'media:backfill', { payload })` from the admin endpoint (`POST /api/media/backfill`) or a cron scheduledTask.
 */
export default defineTask({
  meta: { name: 'media:backfill', description: 'Generate missing image variants + prune deregistered ones; {check:true}=dry-run' },
  async run({ payload }) {
    const policy = mediaRuntimeConfig().imagePolicy ?? DEFAULT_IMAGE_POLICY
    const result = await runBackfill(useDb(), useStorageDriver(), policy, { check: !!(payload as { check?: boolean })?.check })
    return { result }
  },
})
