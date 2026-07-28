import { ref } from 'vue'
import type { OpItem, DeleteReport } from '../utils/ops'

export function useMediaOps(onChanged?: () => void) {
  const busy = ref(false)
  const error = ref<string | null>(null)

  async function previewDelete(items: OpItem[]): Promise<DeleteReport> {
    error.value = null
    try {
      return await $fetch<DeleteReport>('/api/media/delete', { method: 'POST', body: { items, dryRun: true } })
    } catch (e) {
      error.value = (e as { statusMessage?: string })?.statusMessage ?? 'Could not prepare delete'
      throw e
    }
  }

  async function confirmDelete(items: OpItem[]): Promise<void> {
    busy.value = true
    error.value = null
    try {
      await $fetch('/api/media/delete', { method: 'POST', body: { items } })
      onChanged?.()
    } catch (e) {
      error.value = (e as { statusMessage?: string })?.statusMessage ?? 'Delete failed'
      throw e
    } finally {
      busy.value = false
    }
  }

  async function rename(item: OpItem, name: string): Promise<void> {
    busy.value = true
    error.value = null
    try {
      await $fetch('/api/media/rename', { method: 'POST', body: { items: [item], name, onConflict: 'abort' } })
      onChanged?.()
    } catch (e) {
      const err = e as { statusCode?: number; statusMessage?: string }
      error.value = err.statusCode === 409
        ? 'A file or folder with this name already exists'
        : err.statusMessage ?? 'Rename failed'
      throw e
    } finally {
      busy.value = false
    }
  }

  return { busy, error, previewDelete, confirmDelete, rename }
}
