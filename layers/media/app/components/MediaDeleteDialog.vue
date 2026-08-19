<script setup lang="ts">
import { computed } from 'vue'
import { humanizeSize } from '../utils/library'
import type { DeleteReport } from '../utils/ops'

const props = defineProps<{ open: boolean; report: DeleteReport | null; names: Record<number, string>; busy?: boolean; error?: string | null }>()
const emit = defineEmits<{ confirm: []; 'update:open': [boolean] }>()

const { t } = useT()

const usageLines = computed(() => {
  const out: { file: string; refs: string }[] = []
  for (const [id, refs] of Object.entries(props.report?.usages ?? {})) {
    if (refs.length) out.push({ file: props.names[Number(id)] ?? `#${id}`, refs: refs.map((u) => `${u.collection} #${u.recordId} (${u.field})`).join(', ') })
  }
  return out
})
</script>

<template>
  <KestrelUiDialog :open="open" :title="t('common.delete')" @update:open="(v) => emit('update:open', v)">
    <p v-if="report">
      {{ t('media.deleteSummary', {
        files: report.summary.files,
        filesUnit: report.summary.files === 1 ? t('media.file') : t('media.files'),
        folders: report.summary.folders,
        foldersUnit: report.summary.folders === 1 ? t('media.folder') : t('media.folders'),
        size: humanizeSize(report.summary.totalBytes)
      }) }}
    </p>
    <div v-if="usageLines.length" class="media-delete__usages">
      <p>{{ t('media.usageWarning') }}</p>
      <ul>
        <li v-for="u in usageLines" :key="u.file">{{ u.file }} → {{ u.refs }}</li>
      </ul>
    </div>
    <KestrelUiAlert v-if="error" variant="error">{{ error }}</KestrelUiAlert>
    <template #footer>
      <KestrelUiButton variant="ghost" :disabled="busy" @click="emit('update:open', false)">{{ t('common.cancel') }}</KestrelUiButton>
      <KestrelUiButton variant="danger" :disabled="busy" @click="emit('confirm')">{{ t('common.delete') }}</KestrelUiButton>
    </template>
  </KestrelUiDialog>
</template>

<style lang="scss" scoped>
.media-delete__usages {
  margin-top: var(--space-3);
  color: var(--color-danger);
  font-size: var(--text-sm);
  ul { margin: var(--space-1) 0 0; padding-left: var(--space-4); }
}
</style>
