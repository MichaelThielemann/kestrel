<script setup lang="ts">
import { computed } from 'vue'
import type { Conflict } from '../utils/ops'

const props = defineProps<{ open: boolean; conflicts: Conflict[]; type: 'move' | 'copy'; dest: string; busy?: boolean; error?: string | null }>()
const emit = defineEmits<{ resolve: ['skip' | 'overwrite' | 'rename']; 'update:open': [boolean] }>()

const { t } = useT()
const title = computed(() => props.type === 'move' ? t('media.conflictTitleMove') : t('media.conflictTitleCopy'))
</script>

<template>
  <UiDialog :open="open" :title="title" @update:open="(v) => emit('update:open', v)">
    <p>{{ t('media.conflictItems', { count: conflicts.length, dest: dest || t('media.rootFolder') }) }}</p>
    <ul class="media-conflict__list">
      <li v-for="c in conflicts" :key="c.targetPath">{{ c.targetPath }} — {{ c.type === 'folder-exists' ? t('media.conflictFolderExists') : t('media.conflictFileExists') }}</li>
    </ul>
    <UiAlert v-if="error" variant="error">{{ error }}</UiAlert>
    <template #footer>
      <UiButton :disabled="busy" @click="emit('update:open', false)">{{ t('common.cancel') }}</UiButton>
      <UiButton :disabled="busy" @click="emit('resolve', 'skip')">{{ t('media.skip') }}</UiButton>
      <UiButton :disabled="busy" @click="emit('resolve', 'overwrite')">{{ t('media.replace') }}</UiButton>
      <UiButton variant="primary" :disabled="busy" @click="emit('resolve', 'rename')">{{ t('media.keepBoth') }}</UiButton>
    </template>
  </UiDialog>
</template>

<style lang="scss" scoped>
.media-conflict__list {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
</style>
