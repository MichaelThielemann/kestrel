<script setup lang="ts">
import { reactive, watch } from 'vue'
import type { UploadItem } from '../composables/useMediaUpload'

const { t } = useT()

const props = defineProps<{ conflicts: UploadItem[]; open: boolean }>()
const emit = defineEmits<{
  resolve: [string, 'overwrite' | 'rename' | 'skip', string?]
  'resolve-all': ['overwrite' | 'rename' | 'skip']
  'update:open': [boolean]
}>()

// Per-row editable rename, seeded from each item's server suggestion.
const names = reactive<Record<string, string>>({})
watch(
  () => props.conflicts,
  (list) => {
    for (const c of list) if (!(c.id in names)) names[c.id] = c.suggestion ?? c.filename
  },
  { immediate: true, deep: true },
)

function rename(c: UploadItem) {
  emit('resolve', c.id, 'rename', names[c.id] ?? c.suggestion ?? c.filename)
}
</script>

<template>
  <KestrelUiDialog
    :open="open"
    :title="t('media.conflicts.title')"
    :description="t('media.conflicts.desc', { count: conflicts.length })"
    @update:open="(v) => emit('update:open', v)"
  >
    <div class="media-conflicts__all">
      <span>{{ t('media.conflicts.applyAll') }}</span>
      <KestrelUiButton @click="emit('resolve-all', 'overwrite')">{{ t('media.conflicts.overwriteAll') }}</KestrelUiButton>
      <KestrelUiButton @click="emit('resolve-all', 'rename')">{{ t('media.conflicts.renameAll') }}</KestrelUiButton>
      <KestrelUiButton @click="emit('resolve-all', 'skip')">{{ t('media.conflicts.skipAll') }}</KestrelUiButton>
    </div>
    <ul class="media-conflicts__list">
      <li v-for="c in conflicts" :key="c.id" class="media-conflicts__row">
        <span class="media-conflicts__name">{{ c.filename }}</span>
        <KestrelUiTextInput v-model="names[c.id]" :aria-label="t('media.conflicts.newName', { name: c.filename })" />
        <div class="media-conflicts__actions">
          <KestrelUiButton @click="emit('resolve', c.id, 'overwrite', undefined)">{{ t('media.conflicts.overwrite') }}</KestrelUiButton>
          <KestrelUiButton variant="primary" @click="rename(c)">{{ t('media.conflicts.rename') }}</KestrelUiButton>
          <KestrelUiButton @click="emit('resolve', c.id, 'skip', undefined)">{{ t('media.conflicts.skip') }}</KestrelUiButton>
        </div>
      </li>
    </ul>
  </KestrelUiDialog>
</template>

<style lang="scss" scoped>
.media-conflicts__all {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}
.media-conflicts__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.media-conflicts__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.media-conflicts__name {
  font-weight: var(--weight-medium);
  min-width: 8rem;
}
.media-conflicts__actions {
  display: flex;
  gap: var(--space-2);
  margin-left: auto;
}
</style>
