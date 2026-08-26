// Row and bulk actions for the collection list: a row action is one id, the bulk bar is N — the server
// does the batching, so both go through the same calls.
//
// Destructive → confirm dialog. Reversible → run, toast, refetch (the ops composable's onChanged).
import { ref, type ComputedRef } from 'vue'
import { resolveLocalized } from '../../../ui/app/utils/localized'
import type { BatchDeleteReport } from '../utils/collection-ops'
import type { SerializedAction } from '@michaelthielemann/kestrel-core'

export function useListBatchActions(collection: ComputedRef<string>, refetch: () => void | Promise<void>) {
  const { t, lang } = useT()
  const toast = useToast()
  const { busy, error, previewDelete, confirmDelete: runDelete, duplicate: runDuplicate, setStatus: runSetStatus, runCustomAction } =
    useCollectionOps(collection, () => refetch())

  const deleteOpen = ref(false)
  const deleteReport = ref<BatchDeleteReport | null>(null)
  const deleteIds = ref<number[]>([])

  // The referrer preview is best-effort: if it fails we still open the dialog with a bare summary (never
  // block a delete on the warning lookup).
  async function askDelete(ids: number[]) {
    if (!ids.length) return
    deleteIds.value = ids
    deleteReport.value = null
    deleteOpen.value = true
    try {
      deleteReport.value = await previewDelete(ids)
    } catch {
      // The referrer lookup FAILED — do not fabricate a "no inbound links" report (that would look exactly
      // like a verified-safe delete). Flag `checked: false` so the dialog cautions the check couldn't run.
      deleteReport.value = { count: ids.length, referencedCount: 0, referenced: [], checked: false }
      error.value = null
    }
  }
  async function confirmDelete() {
    try {
      await runDelete(deleteIds.value)
      toast.success(t('toast.deleted'))
      deleteOpen.value = false
    } catch {
      // error stays surfaced in the dialog via `error`
    }
  }
  async function duplicate(id: number) {
    try {
      await runDuplicate([id])
      toast.success(t('toast.duplicated'))
    } catch {
      toast.error(error.value ?? t('list.opFailed'))
    }
  }
  async function setStatus(ids: number[], status: 'published' | 'draft') {
    try {
      await runSetStatus(ids, status)
      toast.success(status === 'published' ? t('toast.published') : t('toast.unpublished'))
    } catch {
      toast.error(error.value ?? t('list.opFailed'))
    }
  }

  /** A schema-driven custom action: label falls back to the pipeline name, and an `ui.confirm` flag gates
   *  on a plain confirm prompt (the built-ins get the richer dialog above; a generic action has no report to
   *  preview). */
  async function runAction(action: SerializedAction, ids: number[]) {
    if (!ids.length) return
    const label = resolveLocalized(action.label, lang.value) ?? action.name
    if (action.confirm && !confirm(t('list.actionConfirm', { name: label, n: ids.length }))) return
    try {
      await runCustomAction(action, ids)
      toast.success(t('list.actionDone', { name: label }))
    } catch {
      toast.error(error.value ?? t('list.opFailed'))
    }
  }

  return { busy, error, deleteOpen, deleteReport, askDelete, confirmDelete, duplicate, setStatus, runAction }
}
