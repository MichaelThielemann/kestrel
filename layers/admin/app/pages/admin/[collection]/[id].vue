<script setup lang="ts">
import { resolveLocalized } from '../../../../../ui/app/utils/localized'
import type { EditorExpose } from '../../../utils/editor-expose'
import type { BatchDeleteReport } from '../../../utils/collection-ops'

definePageMeta({ layout: 'admin', middleware: 'admin-auth', key: (route) => route.fullPath })

const route = useRoute()
const collection = route.params.collection as string
const id = route.params.id as string
// Content locale + translation group flow from the URL (set by the LocaleBar). The page `key` is the
// full path, so switching locale remounts the editor cleanly with the new locale/group.
const localeParam = computed(() => (typeof route.query.locale === 'string' ? route.query.locale.trim() || undefined : undefined))
const group = computed(() => (typeof route.query.group === 'string' ? route.query.group.trim() || undefined : undefined))
// Returning to the list keeps the locale we were editing in, so a multilingual workflow stays in context.
const listPath = computed(() => `/admin/${collection}${localeParam.value ? `?locale=${localeParam.value}` : ''}`)

const { t, lang } = useT()
const toast = useToast()
// Resolve the collection's display labels so the header reads "New Page" / "Posts", not the raw
// (often plural) route param. Non-critical chrome — a failed load falls back to the param.
const { load: loadCollections } = useCollections()
const def = (await loadCollections().catch(() => [])).find((c) => c.name === collection) ?? null
const singular = computed(() => resolveLocalized(def?.label?.singular, lang.value) ?? collection)
const plural = computed(() => resolveLocalized(def?.label?.plural, lang.value) ?? collection)
// The "create" heading prefers the collection's complete per-locale phrase (same one the list button
// uses), so a German title reads "Neue Seite" / "Neuer Beitrag" — never "Neu: …".
const newTitle = computed(() => resolveLocalized(def?.label?.new, lang.value) ?? t('editor.newRecord', { collection: singular.value }))
// The header (where Delete also lives) drives Save by submitting the editor's form via its id, and reads
// the editor's in-flight `saving` for the button state. `dirty` powers the unsaved-changes guard.
const EDITOR_FORM_ID = 'record-editor'
const editorRef = ref<EditorExpose | null>(null)
const saving = computed(() => editorRef.value?.saving ?? false)
// An id means nothing to an editor, so the heading shows the record's own title when it has one. A new (or
// still untitled) record has nothing but its id, and the generic phrase is the only thing that reads well.
const recordName = computed(() => editorRef.value?.recordTitle?.trim() ?? '')
const hasRecordTitle = computed(() => id !== 'new' && recordName.value !== '')
const heading = computed(() =>
  id === 'new'
    ? newTitle.value
    : hasRecordTitle.value
      ? recordName.value
      : t('editor.editRecord', { collection: singular.value, id }),
)

// The external-tab button always works now: with unsaved edits it opens a preview TICKET (no save, no
// publish), otherwise the record's own URL — so the tooltip has to say which of the two you'd get.
const previewTitle = computed(() => t(editorRef.value?.dirty ? 'editor.previewUnsaved' : 'editor.openInNewTab'))

const skipGuard = ref(false)

// Delete flows through the shared batch op + the same confirm dialog the list uses, so the delete logic
// lives ONCE. On success the composable's onChanged navigates back to the list (bypassing the dirty guard).
const { busy: deleting, error: deleteError, previewDelete, confirmDelete: runDelete } = useCollectionOps(collection, async () => {
  skipGuard.value = true
  await navigateTo(listPath.value)
})
const deleteOpen = ref(false)
const deleteReport = ref<BatchDeleteReport | null>(null)

function onSaved(record: unknown) {
  toast.success(t('toast.saved'))
  // Save only saves — it does not leave the editor (navigation is the back link / rail's job). The one
  // exception: a brand-new record switches to its own editor URL so further saves update it (id is now
  // known) instead of POSTing a duplicate.
  if (id === 'new') {
    const newId = (record as { id?: number | string } | null)?.id
    if (newId != null) {
      skipGuard.value = true
      return navigateTo(`/admin/${collection}/${newId}${localeParam.value ? `?locale=${localeParam.value}` : ''}`)
    }
  }
}

// Guard unsaved edits on BOTH route-record changes (→ list) AND same-record param/query nav (the
// LocaleBar's edit-sibling / create-translation links reuse this `[id]` record → onBeforeRouteUpdate).
useUnsavedGuard(() => editorRef.value?.dirty ?? false, () => t('editor.discardConfirm'), () => skipGuard.value)

function toList() {
  return navigateTo(listPath.value)
}

// Open the confirm dialog, fetching the referrer aggregate for its warning. Best-effort: a failed lookup
// still opens the dialog with a bare summary (deleting is never blocked on the warning).
async function onDelete() {
  deleteReport.value = null
  deleteOpen.value = true
  try {
    deleteReport.value = await previewDelete([Number(id)])
  } catch {
    // The referrer lookup FAILED — mark the report unverified (checked:false) so the dialog shows the
    // "references could not be verified" caution instead of a reassuring referencedCount:0 (which would
    // read as a confirmed-safe delete).
    deleteReport.value = { count: 1, referencedCount: 0, referenced: [], checked: false }
    deleteError.value = null
  }
}
async function confirmDelete() {
  try {
    await runDelete([Number(id)])
    toast.success(t('toast.deleted'))
    deleteOpen.value = false
    // navigation back to the list is the composable's onChanged
  } catch {
    // deleteError stays surfaced in the dialog
  }
}
</script>

<template>
  <section class="record">
    <div class="record__head">
      <NuxtLink :to="listPath" class="record__back">
        <UiIcon name="arrow-left" :size="16" />
        <span>{{ t('editor.back', { collection: plural }) }}</span>
      </NuxtLink>
      <h1 class="record__title" :class="{ 'record__title--generic': !hasRecordTitle }">{{ heading }}</h1>
      <div class="record__actions">
        <UiButton type="button" variant="ghost" size="sm" icon="undo" :disabled="saving || !editorRef?.canUndo" :title="t('history.undo')" :aria-label="t('history.undo')" @click="editorRef?.undo()" />
        <UiButton type="button" variant="ghost" size="sm" icon="redo" :disabled="saving || !editorRef?.canRedo" :title="t('history.redo')" :aria-label="t('history.redo')" @click="editorRef?.redo()" />
        <UiButton type="button" variant="ghost" size="sm" icon="external-link" :title="previewTitle" :aria-label="previewTitle" :loading="editorRef?.previewOpening" @click="editorRef?.openPreview()" />
        <UiButton type="button" variant="secondary" size="sm" icon="x" :disabled="saving" @click="toList">{{ t('common.cancel') }}</UiButton>
        <UiButton v-if="id !== 'new'" variant="danger" size="sm" icon="trash" :loading="deleting" @click="onDelete">{{ t('common.delete') }}</UiButton>
        <UiButton type="submit" :form="EDITOR_FORM_ID" variant="primary" size="sm" icon="check" :loading="saving">{{ t('common.save') }}</UiButton>
        <!-- Publishing is its own decision: Save persists, Publish writes the static page (ADR-0008). -->
        <UiButton type="button" variant="secondary" size="sm" icon="upload" :loading="editorRef?.publishing" :disabled="saving" @click="editorRef?.publish()">{{ t('common.publish') }}</UiButton>
        <EditorStatus class="record__ampel" :dirty="editorRef?.dirty ?? false" :saving="saving" :has-status="editorRef?.hasStatus ?? false" :status="editorRef?.status" :saved-status="editorRef?.savedStatus" :page-like="editorRef?.pageLike ?? false" :live="editorRef?.live" />
      </div>
    </div>
    <CollectionEditor ref="editorRef" :collection="collection" :id="id" :form-id="EDITOR_FORM_ID" :locale-param="localeParam" :group="group" :actions="false" @saved="onSaved" />
    <CollectionDeleteDialog
      :open="deleteOpen"
      :report="deleteReport"
      :busy="deleting"
      :error="deleteError"
      @update:open="deleteOpen = $event"
      @confirm="confirmDelete"
    />
  </section>
</template>

<style lang="scss">
.record {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  // The record shell stays fixed; the editor's panes own the scroll (see the admin layout).
  overflow: hidden;

  &__back {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    flex: 0 0 auto;
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    text-decoration: none;

    &:hover {
      color: var(--color-text);
    }
    span {
      text-transform: capitalize;
    }
  }
  // Back link, heading and actions share ONE row so the editor keeps the vertical space for its panes.
  &__head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  &__actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
  }
  // The status Ampel sits far-right, divided from the action buttons.
  &__ampel {
    margin-inline-start: var(--space-1);
    padding-inline-start: var(--space-3);
    border-inline-start: 1px solid var(--color-border);
  }
  &__title {
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
    // A long page title must not push the actions off the row.
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    // Only the generic "Edit {collection} #{id}" / "New {collection}" phrase is title-cased — a real record
    // title is shown verbatim (capitalize would mangle e.g. "iPhone").
    &--generic {
      text-transform: capitalize;
    }
  }
}
</style>
