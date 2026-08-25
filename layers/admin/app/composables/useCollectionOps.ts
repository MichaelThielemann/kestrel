import { ref, toValue, type MaybeRefOrGetter } from 'vue'
import { buildDeleteReport, type BatchAction, type BatchDeleteReport, type BatchPipelineResult, type BulkResult, type ReferrerCounts } from '../utils/collection-ops'
import type { SerializedAction } from '@kestrel/core'

/** Which write pipeline each batch action runs, and the body it takes. A publish/unpublish is an
 *  `updateMany` with a status patch — the same pipeline any other field-wide edit would use. */
const BATCH_PIPELINE: Record<BatchAction, { op: string, patch?: { status: 'published' | 'draft' } }> = {
  delete: { op: 'deleteMany' },
  duplicate: { op: 'duplicate' },
  publish: { op: 'updateMany', patch: { status: 'published' } },
  unpublish: { op: 'updateMany', patch: { status: 'draft' } },
}

/**
 * Client orchestration for the collection batch operations — ONE module, two entry points: a row action
 * passes a single id, the bulk bar passes many. Every mutating call runs a batch pipeline
 * (`POST /api/{collection}/{pipeline}`); the server does the batching, the client never loops N requests.
 * Mirrors media/useMediaOps (busy/error + an onChanged refetch hook).
 */
export function useCollectionOps(collection: MaybeRefOrGetter<string>, onChanged?: () => void | Promise<void>) {
  const { t } = useT()
  const busy = ref(false)
  const error = ref<string | null>(null)
  const name = () => toValue(collection)

  async function bulk(action: BatchAction, ids: number[]): Promise<BulkResult> {
    busy.value = true
    error.value = null
    try {
      const { op, patch } = BATCH_PIPELINE[action]
      const res = await $fetch<BatchPipelineResult>(`/api/${name()}/${op}`, { method: 'POST', body: { ids, ...(patch ? { patch } : {}) } })
      await onChanged?.()
      // `duplicate` answers with the CREATED rows, the two batch ops with a count + the ids they touched;
      // both fold into the one shape the list UI reports.
      return Array.isArray(res)
        ? { action, count: res.length, ids: res.map((row) => Number(row.id)) }
        : { action, count: res.count, ids: res.ids }
    } catch (e) {
      error.value = (e as { statusMessage?: string })?.statusMessage ?? t('list.opFailed')
      throw e
    } finally {
      busy.value = false
    }
  }

  /** Read-only pre-delete summary (referrer aggregate). Best-effort: sets `error` and rethrows on failure
   *  so the caller can decide whether to still proceed (deletion is not blocked on the warning lookup). */
  async function previewDelete(ids: number[]): Promise<BatchDeleteReport> {
    error.value = null
    try {
      const res = await $fetch<ReferrerCounts>(`/api/${name()}/referrers`, { query: { ids: ids.join(',') } })
      // The endpoint flags whether the index lookup ran; carry that through rather than inferring safety from
      // an empty `counts`. A missing body is indeterminate too — it is no evidence that nothing links here.
      return buildDeleteReport(ids, res?.counts ?? {}, res != null && res.checked !== false)
    } catch (e) {
      error.value = (e as { statusMessage?: string })?.statusMessage ?? t('list.refCheckFailed')
      throw e
    }
  }

  /**
   * Run a schema-driven custom action (a consumer's `definePipeline` beyond the built-in bulk set). The
   * response shape is whatever that pipeline answers with — unlike the built-ins, generic rendering has no
   * contract to decode, so the reported result is simply the ids the caller asked to act on.
   */
  async function runCustomAction(action: SerializedAction, ids: number[]): Promise<BulkResult> {
    busy.value = true
    error.value = null
    try {
      const record = action.kind === 'record'
      const url = record ? `/api/${name()}/${action.name}/${ids[0]}` : `/api/${name()}/${action.name}`
      await $fetch(url, { method: 'POST', body: record ? undefined : { ids } })
      await onChanged?.()
      return { action: action.name, count: ids.length, ids }
    } catch (e) {
      error.value = (e as { statusMessage?: string })?.statusMessage ?? t('list.opFailed')
      throw e
    } finally {
      busy.value = false
    }
  }

  const confirmDelete = (ids: number[]) => bulk('delete', ids)
  const duplicate = (ids: number[]) => bulk('duplicate', ids)
  /**
   * Persist a new status and, for a publish, write the static output too (ADR-0008). Two calls because
   * they are two things: `updateMany` owns the DB write (validation, all-or-nothing, write events),
   * `/api/publish` owns the render. Unpublishing needs no second call — the write event prunes the pages
   * on its own, since taking a page offline must never wait for a separate action.
   */
  const setStatus = async (ids: number[], status: 'published' | 'draft'): Promise<BulkResult> => {
    const res = await bulk(status === 'published' ? 'publish' : 'unpublish', ids)
    if (status === 'published') {
      // Best-effort: the records ARE published (the state the list shows); a failed render surfaces on the
      // record's own status lamp, and re-pressing Publish retries it.
      await $fetch('/api/publish', { method: 'POST', body: { collection: name(), ids } }).catch(() => null)
    }
    return res
  }

  return { busy, error, previewDelete, confirmDelete, duplicate, setStatus, runCustomAction }
}
