<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { humanizeSize, type LibraryFile } from '../utils/library'

// Fullscreen-ish preview + general info for a single file. Images additionally expose an editable alt
// text (the only field worth maintaining from the library) and — when the consumer switched the feature
// on — the EU AI Act Art. 50 disclosure; everything else is read-only metadata.
const props = defineProps<{ open: boolean; file: LibraryFile | null; busy?: boolean; error?: string | null }>()
// The disclosure rides along as a SECOND positional argument rather than reshaping the first: an outside
// consumer (`extensions/galleries-secure`) handles `save` as `(alt: string)` and simply ignores the extra.
const emit = defineEmits<{
  'update:open': [boolean]
  save: [alt: string, ai?: { aiSourceType: string | null; aiNote: string | null }]
}>()
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

// Gates the disclosure controls only — the data is always resolved server-side, so a consumer who turns
// the flag back off keeps whatever was recorded, it just stops being editable here.
const aiEnabled = computed(() => useRuntimeConfig().public.aiDisclosureEnabled === true)
const showAi = computed(() => isImage.value && aiEnabled.value)
const AI_SOURCE_TYPES = ['trainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia', 'algorithmicallyEnhanced'] as const
// A leading empty option is what makes "no disclosure recorded" both representable and clearable
// (mirrors how `field/Choice.vue` renders a non-required single choice).
const aiSourceTypeOptions = computed(() => [
  { label: '—', value: '' },
  ...AI_SOURCE_TYPES.map((v) => ({ label: t(`mediaViewer.aiSourceType.${v}`), value: v })),
])

const alt = ref('')
const aiSourceType = ref('')
const aiNote = ref('')
const fileAlt = computed(() => props.file?.alt ?? '')
const fileAiSourceType = computed(() => props.file?.aiDisclosure?.sourceType ?? '')
const fileAiNote = computed(() => props.file?.aiDisclosure?.note ?? '')
// Seed (and re-seed) the drafts whenever the dialog opens — immediate so a viewer mounted already-open
// (or re-opened on a different file) shows the current values rather than stale/empty ones.
watch(() => props.open, (o) => {
  if (!o) return
  alt.value = fileAlt.value
  aiSourceType.value = fileAiSourceType.value
  aiNote.value = fileAiNote.value
}, { immediate: true })

const aiDirty = computed(() => showAi.value && (aiSourceType.value !== fileAiSourceType.value || aiNote.value !== fileAiNote.value))
const dirty = computed(() => isImage.value && (alt.value !== fileAlt.value || aiDirty.value))
function save() {
  if (!dirty.value || props.busy) return
  // With the feature off the payload is omitted entirely, so an alt-only save can never blank a
  // disclosure the consumer recorded while it was on.
  if (!showAi.value) { emit('save', alt.value); return }
  emit('save', alt.value, { aiSourceType: aiSourceType.value || null, aiNote: aiNote.value.trim() || null })
}
</script>

<template>
  <KestrelUiDialog :open="open" size="xl" :title="file?.filename ?? ''" @update:open="(v) => emit('update:open', v)">
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
        <KestrelUiField v-if="isImage" :label="t('mediaViewer.alt')" :hint="t('mediaViewer.altHint')">
          <template #default="f">
            <KestrelUiTextInput v-model="alt" v-bind="f" @keydown.enter="save" />
          </template>
        </KestrelUiField>
        <div v-if="showAi" class="media-viewer__ai">
          <KestrelUiField :label="t('mediaViewer.aiSourceTypeLabel')" :hint="t('mediaViewer.aiSourceTypeHint')">
            <template #default="f">
              <KestrelUiSelect v-model="aiSourceType" :options="aiSourceTypeOptions" v-bind="f" />
            </template>
          </KestrelUiField>
          <KestrelUiField :label="t('mediaViewer.aiNote')" :hint="t('mediaViewer.aiNoteHint')">
            <template #default="f">
              <KestrelUiTextInput v-model="aiNote" v-bind="f" @keydown.enter="save" />
            </template>
          </KestrelUiField>
        </div>
        <KestrelUiAlert v-if="error" variant="error">{{ error }}</KestrelUiAlert>
        <!-- Optional per-file extra panel (e.g. proofing comments). Empty by default. -->
        <slot name="extra" :file="file" />
      </aside>
    </div>
    <template v-if="file" #footer>
      <KestrelUiButton :disabled="busy" @click="emit('update:open', false)">{{ t('common.close') }}</KestrelUiButton>
      <KestrelUiButton v-if="isImage" variant="primary" :disabled="busy || !dirty" @click="save">{{ t('common.save') }}</KestrelUiButton>
    </template>
  </KestrelUiDialog>
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
.media-viewer__ai { display: flex; flex-direction: column; gap: var(--space-3); }
.media-viewer__info { display: flex; flex-direction: column; gap: var(--space-2); margin: 0; }
.media-viewer__info > div { display: flex; justify-content: space-between; gap: var(--space-3); font-size: var(--text-sm); }
.media-viewer__info dt { color: var(--color-text-muted); }
.media-viewer__info dd { margin: 0; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
