<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { humanizeSize, type LibraryFile } from '../utils/library'

// Fullscreen-ish preview + general info for a single file. Images additionally expose an editable alt
// text (the only field worth maintaining from the library); everything else is read-only metadata.
const props = defineProps<{ open: boolean; file: LibraryFile | null; busy?: boolean; error?: string | null }>()
const emit = defineEmits<{ 'update:open': [boolean]; save: [string] }>()
const { t, lang } = useT()

const isImage = computed(() => props.file?.mime.startsWith('image/') ?? false)
const ext = computed(() => (props.file?.filename.split('.').pop() ?? '').toUpperCase())
const dims = computed(() => (props.file?.width && props.file?.height ? `${props.file.width}×${props.file.height}` : '—'))
const uploaded = computed(() => {
  const c = props.file?.createdAt
  if (!c) return '—'
  const d = new Date(c)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(lang.value)
})

const alt = ref('')
// Seed (and re-seed) the draft whenever the dialog opens — immediate so a viewer mounted already-open
// (or re-opened on a different file) shows the current alt rather than a stale/empty value.
watch(() => props.open, (o) => { if (o) alt.value = props.file?.alt ?? '' }, { immediate: true })
const dirty = computed(() => isImage.value && alt.value !== (props.file?.alt ?? ''))
function save() { if (dirty.value && !props.busy) emit('save', alt.value) }
</script>

<template>
  <UiDialog :open="open" size="xl" :title="file?.filename ?? ''" @update:open="(v) => emit('update:open', v)">
    <div v-if="file" class="media-viewer">
      <div class="media-viewer__preview">
        <img v-if="isImage" :src="file.src" :srcset="file.srcset" sizes="(max-width: 60rem) 100vw, 60rem" :alt="file.alt ?? file.filename" />
        <span v-else class="media-viewer__ext" aria-hidden="true">{{ ext }}</span>
      </div>
      <aside class="media-viewer__details">
        <dl class="media-viewer__info">
          <div><dt>{{ t('media.colType') }}</dt><dd>{{ file.mime }}</dd></div>
          <div><dt>{{ t('media.colSize') }}</dt><dd>{{ humanizeSize(file.size) }}</dd></div>
          <div v-if="isImage"><dt>{{ t('media.colDimensions') }}</dt><dd>{{ dims }}</dd></div>
          <div><dt>{{ t('mediaViewer.folder') }}</dt><dd>{{ file.folder || '/' }}</dd></div>
          <div><dt>{{ t('mediaViewer.uploaded') }}</dt><dd>{{ uploaded }}</dd></div>
        </dl>
        <UiField v-if="isImage" :label="t('mediaViewer.alt')" :hint="t('mediaViewer.altHint')">
          <template #default="f">
            <UiTextInput v-model="alt" v-bind="f" @keydown.enter="save" />
          </template>
        </UiField>
        <UiAlert v-if="error" variant="error">{{ error }}</UiAlert>
        <!-- Optional per-file extra panel (e.g. proofing comments). Empty by default. -->
        <slot name="extra" :file="file" />
      </aside>
    </div>
    <template v-if="file" #footer>
      <UiButton :disabled="busy" @click="emit('update:open', false)">{{ t('common.close') }}</UiButton>
      <UiButton v-if="isImage" variant="primary" :disabled="busy || !dirty" @click="save">{{ t('common.save') }}</UiButton>
    </template>
  </UiDialog>
</template>

<style lang="scss" scoped>
.media-viewer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 18rem);
  gap: var(--space-4);
  align-items: start;
}
@media (max-width: 48rem) {
  .media-viewer { grid-template-columns: 1fr; }
}
.media-viewer__preview {
  display: grid;
  place-items: center;
  min-height: 16rem;
  max-height: 70svh;
  overflow: hidden;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.media-viewer__preview img { max-width: 100%; max-height: 70svh; object-fit: contain; }
.media-viewer__ext { padding: var(--space-7); font-size: var(--text-xl); font-weight: var(--weight-bold); color: var(--color-text-muted); }
.media-viewer__details { display: flex; flex-direction: column; gap: var(--space-4); }
.media-viewer__info { display: flex; flex-direction: column; gap: var(--space-2); margin: 0; }
.media-viewer__info > div { display: flex; justify-content: space-between; gap: var(--space-3); font-size: var(--text-sm); }
.media-viewer__info dt { color: var(--color-text-muted); }
.media-viewer__info dd { margin: 0; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
