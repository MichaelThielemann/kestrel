<script setup lang="ts">
import { localePath } from '../../../core/app/utils/locale-path'
import { PREVIEW_TOKEN_QUERY, PREVIEW_FALLBACK_PATH } from '../../../public/app/utils/preview-protocol'
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

// ---- publish + external preview -------------------------------------------------------------------
// Saving persists to the DB and leaves the live site alone; publishing writes the static file(s). The two
// are separate buttons because they are separate decisions (ADR-0008) — you can save a page a dozen times
// while the published version stays exactly as it was.
const publishing = ref(false)
const previewOpening = ref(false)
// `output.publishOnSave` turns the split off again (a save republishes, as before 1.8) — then a Publish
// button would have nothing to do, so the hosts hide it. Reported by /api/publish-status; unknown (a
// never-saved record, which does not fetch it) reads as the default, i.e. the button stays.
const publishOnSave = computed(() => liveStatus.data.value.publishOnSave === true)
const canPublish = computed(() => !publishOnSave.value)

/** Save (a publish publishes what you SEE), promote a draft, then write the output. */
async function publish() {
  if (publishing.value || saving.value) return
  publishing.value = true
  try {
    // Pressing Publish IS the publish intent, so a draft is promoted here rather than sending the user to
    // the status select first. A statusless collection has nothing to promote.
    if (hasStatus.value && f.values.status !== 'published') f.setField('status', 'published')
    const r = await submit()
    if (!r.ok) {
      revealError?.()
      toast.error(formError.value || t('editor.saveFailed'))
      return
    }
    saved.value = true
    // The saved row's id, whatever the route param says — `single`/`new` are not ids.
    const id = (r.record as { id?: number } | null)?.id ?? Number(props.id)
    if (!Number.isInteger(id)) return
    const since = liveStatus.data.value.updatedAt ?? null
    // Awaited BEFORE `saved` is emitted: on a new record that emit navigates to the record's own URL and
    // tears this instance down, which would cut the request short.
    const res = await $fetch<{ generates: boolean; drafts: number[] }>('/api/publish', {
      method: 'POST', body: { collection: props.collection, id },
    }).catch(() => null)
    // A create navigates to the new record's URL (a full remount), so this instance is gone before its
    // poll could run — hand the intent to the arriving one instead.
    if (props.id === 'new') pendingPoll.value = pageLike.value && !!res?.generates
    emit('saved', r.record)
    if (!res) { toast.error(t('editor.publishFailed')); return }
    if (res.drafts.length) { toast.info(t('editor.publishDraft')); return }
    if (!res.generates) { toast.info(t('editor.publishNotGenerated')); return }
    toast.success(t('toast.published'))
    void liveStatus.refreshUntilSettled({ since })
  } finally {
    publishing.value = false
  }
}

/**
 * Open the record in a new tab. Unsaved edits travel as a preview TICKET (a token in the URL) instead of
 * being written to the DB: previewing must never be an unasked-for save. A saved, unmodified record just
 * opens its URL.
 *
 * The tab is opened SYNCHRONOUSLY (about:blank) and redirected once the ticket is minted — a popup opened
 * after an await is a popup blocker's textbook case. That costs `noopener`, which the direct path keeps;
 * the target is our own origin either way.
 */
async function openPreview() {
  const url = previewUrl.value
  if (!dirty.value && props.id !== 'new' && url) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  const tab = window.open('', '_blank')
  previewOpening.value = true
  try {
    const ticket = await $fetch<{ token: string }>('/api/preview', {
      method: 'POST',
      body: {
        collection: props.collection,
        id: Number.isInteger(Number(props.id)) ? Number(props.id) : null, // 'new' / 'single' have no id
        locale: f.locale.value,
        values: f.buildBody(),
      },
    }).catch(() => null)
    if (!ticket) {
      tab?.close()
      toast.error(t('editor.previewFailed'))
      return
    }
    // No public URL (never saved, blank slug, non-pageLike) → the dedicated preview page renders the
    // ticket in the real public app instead.
    const base = url ?? `${PREVIEW_FALLBACK_PATH}?locale=${encodeURIComponent(f.locale.value)}`
    const target = `${base}${base.includes('?') ? '&' : '?'}${PREVIEW_TOKEN_QUERY}=${encodeURIComponent(ticket.token)}`
    if (tab) tab.location.replace(target)
    else window.open(target, '_blank', 'noopener,noreferrer') // popup blocked → try once more, directly
  } finally {
    previewOpening.value = false
  }
}

// The record-editor page renders the action toolbar (Save/Cancel/Delete + Undo/Redo) in its header: it
// submits this form by id (formId), reads the in-flight `saving` for the button state, drives the
// unsaved-changes guard off `dirty`, and the undo/redo controls off the history API exposed here.
// The exposed shape IS the `EditorExpose` contract (utils/editor-expose.ts) — keep them in sync.
defineExpose({
  dirty, saving, undo, redo, canUndo, canRedo, hasStatus, status, savedStatus, previewUrl, pageLike,
  live: liveStatus.data, recordTitle: heading, publish, publishing, canPublish, openPreview, previewOpening,
})

async function onSave() {
  // Read BEFORE the save: a successful submit rebaselines, after which the saved status is the new one.
  const wasPublished = savedStatus.value === 'published'
  const r = await submit()
  if (r.ok) {
    saved.value = true
    // A save publishes nothing (ADR-0008), so there is no in-flight republish to poll for — one refresh,
    // which is what turns the right lamp to "Outdated": still live, now an older version than the record.
    // An unpublish is the exception the write path still acts on, and its prune is enqueued the same
    // debounced way, so that case polls until the row clears.
    // …with one exception in each direction: an unpublish IS acted on at save time (its prune rides the same
    // debounced queue), and with `publishOnSave` every save republishes, so both poll until the row settles.
    const unpublished = hasStatus.value && wasPublished && status.value === 'draft'
    const settles = unpublished || (publishOnSave.value && status.value !== 'draft')
    const since = liveStatus.data.value.updatedAt ?? null
    emit('saved', r.record)
    if (props.id !== 'new') void (settles ? liveStatus.refreshUntilSettled({ since }) : liveStatus.refresh())
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
