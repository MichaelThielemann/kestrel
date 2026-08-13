<script setup lang="ts">
// A proper editor for a single-record (singleton) collection — the same header-driven chrome as the
// record editor, minus list/new/delete. The header carries the title and a Save button that submits the
// CollectionEditor's form by id; `saving`/`dirty` come from the editor's exposed state.
import type { EditorExpose } from '../utils/editor-expose'

const props = defineProps<{ collection: string; title: string; localeParam?: string }>()

const { t } = useT()
const toast = useToast()

const EDITOR_FORM_ID = 'singleton-editor'
const editorRef = ref<EditorExpose | null>(null)
const saving = computed(() => editorRef.value?.saving ?? false)

function onSaved() {
  toast.success(t('toast.saved'))
}

// Unsaved edits preview through a ticket instead of a save; the editor owns both paths (ADR-0008).
const previewTitle = computed(() => t(editorRef.value?.dirty ? 'editor.previewUnsaved' : 'editor.openInNewTab'))

// Guard in-app navigation away from unsaved changes — both record-change AND same-record `?locale`
// switches (the LocaleBar's singleton locale switch reuses this route record → onBeforeRouteUpdate).
// The editor itself guards native unload.
useUnsavedGuard(() => editorRef.value?.dirty ?? false, () => t('editor.discardConfirm'))
</script>

<template>
  <section class="singleton">
    <div class="singleton__head">
      <h1 class="singleton__title">{{ title }}</h1>
      <div class="singleton__actions">
        <UiButton type="button" variant="ghost" size="sm" icon="undo" :disabled="saving || !editorRef?.canUndo" :title="t('history.undo')" :aria-label="t('history.undo')" @click="editorRef?.undo()" />
        <UiButton type="button" variant="ghost" size="sm" icon="redo" :disabled="saving || !editorRef?.canRedo" :title="t('history.redo')" :aria-label="t('history.redo')" @click="editorRef?.redo()" />
        <UiButton type="button" variant="ghost" size="sm" icon="external-link" :title="previewTitle" :aria-label="previewTitle" :loading="editorRef?.previewOpening" @click="editorRef?.openPreview()" />
        <UiButton type="submit" :form="EDITOR_FORM_ID" variant="primary" size="sm" icon="check" :loading="saving">{{ t('common.save') }}</UiButton>
        <!-- Publishing is its own decision: Save persists, Publish writes the static page (ADR-0008). -->
        <UiButton type="button" variant="secondary" size="sm" icon="upload" :loading="editorRef?.publishing" :disabled="saving" @click="editorRef?.publish()">{{ t('common.publish') }}</UiButton>
        <EditorStatus class="singleton__ampel" :dirty="editorRef?.dirty ?? false" :saving="saving" :has-status="editorRef?.hasStatus ?? false" :status="editorRef?.status" :saved-status="editorRef?.savedStatus" :page-like="editorRef?.pageLike ?? false" :live="editorRef?.live" />
      </div>
    </div>
    <CollectionEditor
      ref="editorRef"
      :collection="collection"
      id="single"
      :form-id="EDITOR_FORM_ID"
      :locale-param="localeParam"
      :actions="false"
      @saved="onSaved"
    />
  </section>
</template>

<style lang="scss">
// The singleton shell stays fixed and fills the height handed down; the editor body (.editor__flat /
// .editor3) owns the scroll — same model as the record editor (see the admin layout).
.singleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;

  // Fixed header; the fields scroll below it, so it needs no sticky positioning (matching .record__head).
  &__head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--color-border);
  }
  &__title {
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
    text-transform: capitalize;
  }
  &__actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  &__ampel {
    margin-inline-start: var(--space-1);
    padding-inline-start: var(--space-3);
    border-inline-start: 1px solid var(--color-border);
  }
}
</style>
