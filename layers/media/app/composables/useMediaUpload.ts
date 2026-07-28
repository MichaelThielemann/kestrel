import { ref, computed } from 'vue'
import type { PendingUpload } from '../utils/dnd'

export interface UploadItem {
  id: string; file: File; filename: string; folder: string
  status: 'queued' | 'uploading' | 'done' | 'error' | 'conflict' | 'skipped'
  message?: string; suggestion?: string; existingId?: number
}

export interface UploadCallbacks {
  /** Fired once a batch has fully settled (no active uploads, no unresolved conflicts). */
  onSettled?: () => void
  /** Fired for each item that fails (non-conflict). The component surfaces the reason (`item.message`). */
  onError?: (item: UploadItem) => void
}

export function useMediaUpload(cb: UploadCallbacks = {}) {
  const queue = ref<UploadItem[]>([])
  let seq = 0
  const conflicts = computed(() => queue.value.filter((i) => i.status === 'conflict'))
  const active = computed(() => queue.value.some((i) => i.status === 'queued' || i.status === 'uploading'))
  const counts = computed(() => ({
    total: queue.value.length,
    done: queue.value.filter((i) => i.status === 'done').length,
    error: queue.value.filter((i) => i.status === 'error').length,
    conflict: conflicts.value.length,
    skipped: queue.value.filter((i) => i.status === 'skipped').length,
  }))

  async function uploadItem(item: UploadItem, opts: { overwrite?: boolean; filename?: string } = {}) {
    item.status = 'uploading'
    const fd = new FormData()
    fd.append('file', item.file)
    if (item.folder) fd.append('folder', item.folder)
    fd.append('filename', opts.filename ?? item.filename)
    if (opts.overwrite) fd.append('overwrite', 'true')
    try {
      await $fetch('/api/media', { method: 'POST', body: fd })
      item.status = 'done'
    } catch (e) {
      type ConflictData = { suggestion?: string; existingId?: number }
      const err = e as { statusCode?: number; statusMessage?: string; data?: ConflictData & { statusMessage?: string; data?: ConflictData } }
      if (err.statusCode === 409) {
        // $fetch wraps the thrown H3 error: the original payload is nested under data.data over HTTP.
        const payload = err.data?.data ?? err.data
        item.status = 'conflict'; item.suggestion = payload?.suggestion; item.existingId = payload?.existingId
      } else if (err.statusCode === 401) {
        // A mid-session 401 is owned by the re-auth interceptor (it redirects to login) — don't also
        // raise a per-item toast for the same event.
        item.status = 'error'
      } else {
        // Prefer the server reason from the JSON body (transport-independent) over `statusMessage`,
        // which mirrors `response.statusText` — blank on HTTP/2 and rewritten by proxies. The component
        // localizes a fallback when neither is present.
        item.status = 'error'; item.message = err.data?.statusMessage ?? err.statusMessage
        cb.onError?.(item)
      }
    }
  }

  function settle() { if (!active.value && !conflicts.value.length) cb.onSettled?.() }

  async function run() {
    for (const item of queue.value) if (item.status === 'queued') await uploadItem(item)
    settle()
  }

  function enqueueUploads(uploads: PendingUpload[]) {
    for (const u of uploads) queue.value.push({ id: `u${++seq}`, file: u.file, filename: u.file.name, folder: u.folder, status: 'queued' })
    return run()
  }

  function enqueue(files: File[], folder: string) {
    return enqueueUploads(files.map((file) => ({ file, folder })))
  }

  async function resolve(id: string, action: 'overwrite' | 'rename' | 'skip', name?: string) {
    const item = queue.value.find((i) => i.id === id)
    if (!item || item.status !== 'conflict') return
    if (action === 'skip') item.status = 'skipped'
    else if (action === 'overwrite') await uploadItem(item, { overwrite: true })
    else { item.filename = name ?? item.suggestion ?? item.filename; await uploadItem(item, { filename: item.filename }) }
    settle()
  }

  async function resolveAll(action: 'overwrite' | 'rename' | 'skip') {
    for (const item of [...conflicts.value]) await resolve(item.id, action, action === 'rename' ? item.suggestion : undefined)
  }

  function reset() { queue.value = [] }

  return { queue, conflicts, active, counts, enqueue, enqueueUploads, resolve, resolveAll, reset }
}
