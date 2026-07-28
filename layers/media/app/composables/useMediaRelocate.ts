import { ref } from 'vue'
import type { OpItem, RelocationReport } from '../utils/ops'

type Strategy = 'abort' | 'skip' | 'overwrite' | 'rename'

export function useMediaRelocate(onChanged?: () => void) {
  const { t } = useT()
  const busy = ref(false)
  const error = ref<string | null>(null)

  async function preview(type: 'move' | 'copy', items: OpItem[], dest: string): Promise<RelocationReport> {
    error.value = null
    try {
      return await $fetch<RelocationReport>(`/api/media/${type}`, { method: 'POST', body: { items, dest, dryRun: true } })
    } catch (e) {
      error.value = (e as { statusMessage?: string })?.statusMessage ?? t('media.error.relocate')
      throw e
    }
  }

  async function execute(type: 'move' | 'copy', items: OpItem[], dest: string, onConflict: Strategy): Promise<void> {
    busy.value = true
    error.value = null
    try {
      await $fetch(`/api/media/${type}`, { method: 'POST', body: { items, dest, onConflict } })
      onChanged?.()
    } catch (e) {
      const err = e as { statusCode?: number; statusMessage?: string }
      error.value = err.statusCode === 409
        ? t('media.error.relocateConflict')
        : err.statusMessage ?? t('media.error.relocate')
      throw e
    } finally {
      busy.value = false
    }
  }

  return { busy, error, preview, execute }
}
