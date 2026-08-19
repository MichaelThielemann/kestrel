<script setup lang="ts">
import type { BatchDeleteReport } from '../utils/collection-ops'

// The destructive-action confirm (replaces window.confirm). Shows how many rows will be deleted and, when
// any are still referenced by other records, the aggregated "left with a broken link" warning fetched from
// the referrer endpoint. Mirrors media/MediaDeleteDialog one layer over.
defineProps<{ open: boolean; report: BatchDeleteReport | null; busy?: boolean; error?: string | null }>()
const emit = defineEmits<{ confirm: []; 'update:open': [boolean] }>()

const { t } = useT()
</script>

<template>
  <KestrelUiDialog :open="open" :title="t('common.delete')" @update:open="(v) => emit('update:open', v)">
    <p v-if="report">{{ t('list.deleteSummary', { n: report.count }) }}</p>
    <div v-if="report && report.referencedCount > 0" class="collection-delete__warn">
      <p>{{ t('list.deleteReferrersWarn', { n: report.referencedCount }) }}</p>
    </div>
    <!-- The referrer lookup FAILED (not "none found"): inbound links are unknown, so caution rather than
         imply a safe delete. Distinct from the reference warning above, which needs a successful check. -->
    <KestrelUiAlert v-if="report && report.checked === false" variant="warning" class="collection-delete__caution">
      {{ t('list.deleteRefsUnverified') }}
    </KestrelUiAlert>
    <KestrelUiAlert v-if="error" variant="error">{{ error }}</KestrelUiAlert>
    <template #footer>
      <KestrelUiButton variant="ghost" :disabled="busy" @click="emit('update:open', false)">{{ t('common.cancel') }}</KestrelUiButton>
      <KestrelUiButton variant="danger" :disabled="busy" @click="emit('confirm')">{{ t('common.delete') }}</KestrelUiButton>
    </template>
  </KestrelUiDialog>
</template>

<style lang="scss" scoped>
.collection-delete__warn {
  margin-top: var(--space-3);
  color: var(--color-danger);
  font-size: var(--text-sm);
}
</style>
