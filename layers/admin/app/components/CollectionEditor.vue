<script setup lang="ts">
import { localePath } from '../../../core/app/utils/locale-path'
import { resolveCollectionEditor } from '../utils/editor-registry'
import { editorFormContextKey } from '../utils/editor-form-context'
import '../utils/register-builtin-editors'

const props = withDefaults(
  // `actions`: render the inline Save/Cancel row. The record editor hides it and drives the save from
  // its page header (where Delete also lives) via a `type=submit` button tied to this form by `formId`;
  // the singleton collection page keeps the inline actions. `formId` ids the form for that association.
  defineProps<{ collection: string; id: string; localeParam?: string; group?: string; actions?: boolean; formId?: string }>(),
  { actions: true },
)
const emit = defineEmits<{ saved: [record: unknown]; cancel: [] }>()

const saved = ref(false)
const { t } = useT()
const toast = useToast()
const f = useEditForm({ collection: props.collection, id: props.id, locale: props.localeParam, group: props.group })

// Editor → field-widget context. MUST run BEFORE the top-level `await` below — after an await the setup
// instance context is gone and `provide` silently no-ops. `id`/`saved` let a widget clean up an abandoned
// never-saved draft (the secure-gallery namespace); `values` (reactive, fills after `ready`) lets it read
// sibling fields (the gallery slug = the proofing key). Mirrors the blockEdit provide.
provide(recordEditContextKey, { id: toRef(props, 'id'), saved, values: f.values })

// Editor → body context. The shell owns the form/save/history/expose; the resolved body only lays out the
// values. Provided (like recordEditContextKey) BEFORE the await — the computeds below are lazy, so building
// them against `f`'s refs before `ready` resolves is safe. `revealError` is registered by a body (the
// blocks body focuses the offending block) and called by `onSave` on failure, keeping the shell generic.
const renderable = computed(() =>
  Object.fromEntries(Object.entries(f.renderableFields.value).map(([name, field]) => [name, asFieldDef(field)])),
)
const rootDeadFields = computed(() => deadFieldsAt(f.deadRefs.value, null))
// The record's own title for the header heading (blank → the host falls back to "Edit {collection} #{id}").
const heading = computed(() => recordTitle(renderable.value, f.values))
// Page/root field pane bindings — rendered by both the fields body and the blocks 3-pane root. Built once
// here so the two bodies differ only in layout chrome.
const pageFieldsBindings = computed(() => ({
  translatable: f.translatable.value, collection: props.collection, id: props.id, mode: f.mode.value,
  locale: f.locale.value, translations: f.translations.value, group: f.translationGroup.value,
  fields: renderable.value, fieldLayout: f.fieldLayout.value, values: f.values, errors: f.errors, deadFields: rootDeadFields.value,
  pageLike: f.pageLike.value, seo: f.hasSeo.value, status: f.hasStatus.value, disabled: f.saving.value,
}))
// camelCase keys: `v-on="obj"` does not camelize keys at runtime, so a kebab `copy-from` key becomes the
// `onCopy-from` listener — which never matches PageFieldsPane's declared `copyFrom` emit. The declared
// emit names are the contract.
const pageFieldsHandlers = { copyFrom: onCopyFrom, update: f.setField }

// Live-preview affordances (the header's "open in new tab" link, the status Ampel, the preview
// iframe): the current publish status and the record's real public URL (localized), or null when the
// record has no routable path (non-pageLike, never saved). Built from the SAVED path (baseline) — an
// unsaved slug edit must not point the preview/link at a URL that does not exist yet; a save moves the
// baseline and both follow. Defined BEFORE the provide so the blocks body can read `previewUrl` from
// the context (composable + lazy computeds — safe pre-`ready`).
const { primary, prefixPrimary } = useContentLocales()
const status = computed(() => (f.values.status as string | undefined) ?? '')
const previewUrl = computed(() => {
  const path = f.savedPath.value
  if (!f.pageLike.value || !path || props.id === 'new') return null
  return localePath(path, f.locale.value, primary, prefixPrimary)
})

let revealError: (() => void) | null = null
provide(editorFormContextKey, {
  values: f.values, errors: f.errors, formError: f.formError, blockErrors: f.blockErrors, setField: f.setField,
  locale: f.locale, translations: f.translations, translationGroup: f.translationGroup, deadRefs: f.deadRefs,
  saving: f.saving, mode: f.mode, translatable: f.translatable, pageLike: f.pageLike, hasSeo: f.hasSeo,
  hasStatus: f.hasStatus, blocksAllowed: f.blocksAllowed, renderable, previewUrl, undo: f.undo, redo: f.redo,
  applyFrom: f.applyFrom, pageFieldsBindings, pageFieldsHandlers,
  registerRevealError: (fn: () => void) => { revealError = fn },
})

await f.ready

const {
  formError, saving, submit, dirty, editorType, pageLike, hasStatus,
  savedStatus, undo, redo, canUndo, canRedo,
} = f

// Which editor body renders (fields · blocks · an extension type). Resolved from the registry; an
// unregistered type falls back to the visible EditorUnsupported panel.
const bodyComponent = computed(() => resolveCollectionEditor(editorType.value))

// Right dot of the editor Ampel: the live / generated state of THIS record's static page. Only a saved
// pageLike record has one (a non-pageLike collection produces no static page; an unsaved `new` has no row).
// Refreshed on mount and after each save (a save may (re)publish the page).
const liveStatus = usePublishStatus({
  collection: () => props.collection,
  id: () => props.id,
  locale: () => f.locale.value,
  enabled: () => pageLike.value && props.id !== 'new',
})
// Carries "poll the live status on mount" across the create→navigate remount (see usePendingPublishPoll).
const pendingPoll = usePendingPublishPoll()

// The record-editor page renders the action toolbar (Save/Cancel/Delete + Undo/Redo) in its header: it
// submits this form by id (formId), reads the in-flight `saving` for the button state, drives the
// unsaved-changes guard off `dirty`, and the undo/redo controls off the history API exposed here.
// The exposed shape IS the `EditorExpose` contract (utils/editor-expose.ts) — keep them in sync.
defineExpose({ dirty, saving, undo, redo, canUndo, canRedo, hasStatus, status, savedStatus, previewUrl, pageLike, live: liveStatus.data, recordTitle: heading })

async function onSave() {
  const r = await submit()
  if (r.ok) {
    saved.value = true
    // The save may have (re)published the page. A PUBLISHED page republishes asynchronously (a debounced
    // queue) in prod, so poll the right lamp until it settles (Live / Error) rather than catching only the
    // in-flight state; `since` is the pre-save row timestamp so a stale prior success/error can't settle the
    // poll early. A DRAFT produces no file → a single refresh (to reflect the draft / cleared row).
    const wasNew = props.id === 'new'
    const isDraft = hasStatus.value && status.value === 'draft'
    const since = liveStatus.data.value.updatedAt ?? null
    // A create navigates the editor to the new record's URL (a full remount), so this `new` instance is
    // torn down before its poll could run — hand the intent to the arriving instance instead.
    if (wasNew) pendingPoll.value = pageLike.value && !isDraft
    emit('saved', r.record)
    if (!wasNew) void (isDraft ? liveStatus.refresh() : liveStatus.refreshUntilSettled({ since }))
    return
  }
  // Save failed — let the active body reveal the problem (the blocks body focuses the offending block /
  // deselects to show the page fields); then guarantee the failure is noticed on a long editor.
  revealError?.()
  toast.error(formError.value || t('editor.saveFailed'))
}

// LocaleBar "copy" — pull a sibling locale's content into the current form (multi only; the button is
// shown only for an existing sibling, so its id is in the translations map).
async function onCopyFrom(loc: string) {
  const tid = f.translations.value[loc]
  if (typeof tid !== 'number') return
  try {
    const row = await $fetch<Record<string, unknown>>(`/api/${props.collection}/${tid}`)
    f.applyFrom(row)
  } catch {
    f.formError.value = t('localeBar.copyFailed', { locale: loc.toUpperCase() })
  }
}

// Native unload (tab close / reload / external navigation) bypasses the in-app route guard on the editor
// pages, so a beforeunload prompt guards the same unsaved changes. Lives here (where `dirty` is owned) so
// both the record editor and the singleton editor are covered.
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value) {
    e.preventDefault()
    e.returnValue = '' // legacy fallback for the native prompt
  }
}
onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload)
  if (pendingPoll.value) {
    // Arrived here from a create → the republish is still in flight, so poll until the right lamp settles.
    pendingPoll.value = false
    void liveStatus.refreshUntilSettled()
  } else {
    void liveStatus.refresh() // fetch the live/generated state once the saved record (path/locale) is known
  }
})
onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<template>
  <!-- novalidate: Zod owns validation (inline + banner). Native constraint validation would run BEFORE
       the submit event and block onSave with a browser bubble — wrongly so on proxy inputs whose text
       doesn't mirror the model (combobox search boxes stay empty although records are selected). -->
  <form :id="formId" class="editor" novalidate @submit.prevent="onSave">
    <p v-if="formError" class="editor__error" role="alert">{{ formError }}</p>

    <!-- The editor body is chosen by the collection's `editor` type (fields · blocks · an extension). -->
    <component :is="bodyComponent" v-if="bodyComponent" />
    <EditorUnsupported v-else :editor="editorType" />

    <div v-if="actions" class="editor__actions">
      <UiButton type="submit" variant="primary" icon="check" :loading="saving">{{ t('common.save') }}</UiButton>
      <UiButton type="button" variant="secondary" icon="x" :disabled="saving" @click="emit('cancel')">{{ t('common.cancel') }}</UiButton>
    </div>
  </form>
</template>

<style lang="scss">
// The editor form fills the height handed down by the page so its body/panes can own the scroll.
.editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  flex: 1 1 auto;
  min-height: 0;

  &__error {
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-sm);
    color: var(--color-danger);
    font-size: var(--text-sm);
  }
  &__actions {
    display: flex;
    gap: var(--space-3);
  }
}
</style>
