import { ref, toValue, type MaybeRefOrGetter } from 'vue'
import { buildDeleteReport, type BatchAction, type BatchDeleteReport, type BulkResult, type ReferrerCounts } from '../utils/collection-ops'

/**
 * Client orchestration for the collection batch operations — ONE module, two entry points: a row action
 * passes a single id, the bulk bar passes many. Every mutating call hits the one command endpoint
 * (`POST /api/{collection}/bulk`); the server does the batching, the client never loops N requests.
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
      const res = await $fetch<BulkResult>(`/api/${name()}/bulk`, { method: 'POST', body: { action, ids } })
      await onChanged?.()
      return res
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
      const res = await $fetch<ReferrerCounts>('/api/references/referrers', { query: { collection: name(), ids: ids.join(',') } })
      // The endpoint flags whether the index lookup ran; carry that through rather than inferring safety from
      // an empty `counts`. A missing body is indeterminate too — it is no evidence that nothing links here.
      return buildDeleteReport(ids, res?.counts ?? {}, res != null && res.checked !== false)
    } catch (e) {
      error.value = (e as { statusMessage?: string })?.statusMessage ?? t('list.refCheckFailed')
      throw e
    }
  }

  const confirmDelete = (ids: number[]) => bulk('delete', ids)
  const duplicate = (ids: number[]) => bulk('duplicate', ids)
  /** Persist a new status; the server's write pipeline (emitWrite) turns that into a publish/unpublish. */
  const setStatus = (ids: number[], status: 'published' | 'draft') =>
    bulk(status === 'published' ? 'publish' : 'unpublish', ids)

  return { busy, error, previewDelete, confirmDelete, duplicate, setStatus }
}
