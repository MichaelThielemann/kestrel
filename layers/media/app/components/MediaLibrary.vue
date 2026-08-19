<script setup lang="ts">
import { ref, computed } from 'vue'
import type { LibraryFile, LibraryItem } from '../utils/library'
import type { DropResult } from '../composables/useMediaDnd'
import type { DeleteReport, OpItem, Conflict } from '../utils/ops'
import { toOpItem, effectiveTargets } from '../utils/ops'

// The library API response carries `updatedAt` (server/utils/library.ts) that `LibraryFile` doesn't yet
// declare — widen locally rather than read it untyped.
type LibraryFileRow = LibraryFile & { updatedAt?: string }

const props = defineProps<{ pick?: boolean; multiple?: boolean; accept?: 'image' | 'any'; initialFolder?: string; initialSelected?: number[] }>()
const emit = defineEmits<{ confirm: [number[]]; cancel: [] }>()

const lib = useMediaLibrary({ urlSync: !props.pick, accept: props.accept, initialFolder: props.pick ? props.initialFolder : undefined })
const { folder, view, search, sort, items, parentPath, isSelected, hasMore, loading, error } = lib

// Managed multi-pick: the checked file ids persist across folder navigation (unlike lib.selected, which
// is per-folder + wiped on nav). Seeded from the field's current value so it opens pre-checked.
const picked = ref<Set<number>>(new Set(props.pick && props.multiple ? props.initialSelected ?? [] : []))
const isSelectedItem = (i: LibraryItem) => (props.pick && props.multiple
  ? i.type === 'file' && picked.value.has(i.file.id)
  : isSelected(i))

const { t } = useT()
const toast = useToast()
const upload = useMediaUpload({
  onSettled: () => lib.fetchLibrary(),
  // Each failed item raises its own reason (server statusMessage, e.g. "Payload too large") — the
  // running counter only ever showed how *many* failed, never *why*.
  // `||` (not `??`): an empty-string reason (e.g. a blank HTTP/2 statusText that slipped through) must
  // still degrade to the localized fallback rather than render "<file>: " with a dangling colon.
  onError: (item) => toast.error(t('media.uploadError', { name: item.filename, reason: item.message || t('media.uploadFailedReason') })),
})
const { conflicts, active, counts } = upload
const newFolderOpen = ref(false)

// Single-file viewer (general info + alt editor for images), opened on double-click.
const { primary } = useContentLocales()
const viewerOpen = ref(false)
const viewerFile = ref<LibraryFile | null>(null)
const viewerBusy = ref(false)
const viewerError = ref('')
function onOpenItem(item: LibraryItem) {
  // In the PICKER there is no viewer (it would stack a dialog in a dialog). The grid/table emit 'open' on
  // Enter (the keyboard activate) — so in pick mode route Enter to the same SELECT action a click does,
  // otherwise Enter would be a dead key for keyboard pickers. Outside the picker, Enter opens the viewer.
  if (item.type !== 'file') return
  if (props.pick) { onSelect(item, { toggle: false, range: false }); return }
  viewerFile.value = item.file
  viewerError.value = ''
  viewerOpen.value = true
}
async function onSaveMeta(alt: string, ai?: { aiSourceType: string | null; aiNote: string | null }) {
  const f = viewerFile.value as LibraryFileRow | null
  if (!f) return
  viewerBusy.value = true
  viewerError.value = ''
  try {
    // Alt lives in the per-locale translations JSON; write the primary locale (the library resolves
    // alt in that same locale, so this round-trips into the list). The AI disclosure is NOT per-locale,
    // so it rides alongside as top-level keys — and only when the viewer actually offered it, so a save
    // from a consumer with the feature off never clears a recorded disclosure. The precondition header
    // lets the server 409 instead of silently losing a concurrent edit from another open viewer tab.
    await $fetch(`/api/media/${f.id}`, {
      method: 'PATCH',
      body: { translations: { [primary]: { alt } }, ...(ai ?? {}) },
      ...(f.updatedAt ? { headers: { 'x-kestrel-if-unmodified-since': String(new Date(f.updatedAt).getTime()) } } : {}),
    })
  } catch (e) {
    viewerError.value = (e as { statusMessage?: string })?.statusMessage ?? t('mediaViewer.saveFailed')
    return // keep the viewer open so the error is visible
  } finally {
    viewerBusy.value = false
  }
  // Saved → close, then refresh the list (a refresh hiccup isn't a save failure, so don't surface it).
  viewerOpen.value = false
  lib.fetchLibrary()
}

function onSelect(item: LibraryItem, mods: { toggle: boolean; range: boolean }) {
  // Managed multi-pick: a plain click toggles the file's membership in the persistent `picked` set
  // (folders aren't pickable — a modifier-click on one is ignored here).
  if (props.pick && props.multiple) {
    if (item.type !== 'file') return
    const s = new Set(picked.value)
    if (s.has(item.file.id)) s.delete(item.file.id)
    else s.add(item.file.id)
    picked.value = s
    return
  }
  // single-pick is always exactly one — modifier clicks must not let it accumulate
  if (props.pick && !props.multiple) { lib.select(item); return }
  if (mods.range) lib.range(item)
  else if (mods.toggle) lib.toggle(item)
  else if (props.pick) lib.toggle(item)
  else lib.select(item)
}

const selectedFileIds = computed(() => (props.pick && props.multiple
  ? [...picked.value]
  : items.value
    .filter((i): i is Extract<LibraryItem, { type: 'file' }> => i.type === 'file' && isSelected(i))
    .map((i) => i.file.id)))
function onConfirmPick() { emit('confirm', selectedFileIds.value) }

// A not-found folder (error set) must not be silently created by uploading / new-folder / paste / drop
// into it — that would contradict the "does not exist" banner. Gate every write path on `error`.
function onUpload(files: File[]) {
  if (error.value) return
  // start a fresh batch (reset cumulative counts) only once any prior batch has fully settled
  if (!active.value && !conflicts.value.length) upload.reset()
  upload.enqueue(files, folder.value)
}

async function onCreateFolder(name: string) {
  if (error.value) return
  await $fetch('/api/media/folders', {
    method: 'POST',
    body: { path: folder.value ? `${folder.value}/${name}` : name },
  })
  newFolderOpen.value = false
  lib.fetchLibrary()
}

async function onDropResult({ uploads, folders }: DropResult) {
  if (error.value) return
  for (const path of folders) {
    await $fetch('/api/media/folders', { method: 'POST', body: { path } })
  }
  if (uploads.length) {
    if (!active.value && !conflicts.value.length) upload.reset()
    upload.enqueueUploads(uploads)
  } else if (folders.length) {
    lib.fetchLibrary()
  }
}

const draggedItems = ref<OpItem[]>([])
function onItemDragStart(item: LibraryItem, e: DragEvent) {
  const set = effectiveTargets(item, lib.isSelected, items.value.filter((i) => lib.isSelected(i)))
  draggedItems.value = set.map(toOpItem)
  e.dataTransfer?.setData('application/x-kestrel-media', '1')
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onItemDragEnd() { draggedItems.value = [] }

const { dragActive, dropFolder, onDragEnter, onDragOver, onDragLeave, onDrop } = useMediaDnd({
  currentFolder: () => folder.value,
  onDrop: onDropResult,
  draggedItems: () => draggedItems.value,
  onMove,
})

const ops = useMediaOps(() => { lib.fetchLibrary(); lib.clear() })
const { busy: opsBusy, error: opError } = ops
const deleteOpen = ref(false)
const deleteReport = ref<DeleteReport | null>(null)
const pendingDelete = ref<OpItem[]>([])
const fileNames = computed(() => Object.fromEntries(
  items.value.filter((i) => i.type === 'file').map((i) => [i.file.id, i.file.filename]),
))

const renameOpen = ref(false)
const renameTarget = ref<LibraryItem | null>(null)
const renameName = computed(() => {
  const t = renameTarget.value
  if (!t) return ''
  return t.type === 'file' ? t.file.filename : t.folder.path.split('/').pop() ?? ''
})

async function onConfirmRename(name: string) {
  if (!renameTarget.value) return
  try {
    await ops.rename(toOpItem(renameTarget.value), name)
    renameOpen.value = false
    renameTarget.value = null
  } catch {
    // opError is set by ops.rename and shown inside the open rename dialog
  }
}

const { clipboard, isEmpty: clipboardEmpty, count: clipboardCount, cut, copy, clear: clearClipboard } = useMediaClipboard()

// Mirrors the two v-if-toggled visual paragraphs below into one region that is ALWAYS in the DOM: a
// live region inserted already containing text is not announced, so a v-if'd aria-live silences the
// very first clipboard/upload message. This one starts empty and only its text content changes.
const srStatus = computed(() => {
  const parts: string[] = []
  if (!clipboardEmpty.value) {
    parts.push(`${clipboardCount.value} ${clipboardCount.value === 1 ? t('media.clipboardItem') : t('media.clipboardItems')} ${clipboard.value?.mode === 'cut' ? t('media.clipboardCut') : t('media.clipboardCopied')}`)
  }
  if (active.value || counts.value.done || counts.value.error || counts.value.skipped) {
    let msg = active.value ? `${t('media.uploading')}${counts.value.done} ${t('media.uploadUploaded')}` : `${counts.value.done} ${t('media.uploadUploaded')}`
    if (counts.value.error) msg += `, ${counts.value.error} ${t('media.uploadFailed')}`
    if (counts.value.skipped) msg += `, ${counts.value.skipped} ${t('media.uploadSkipped')}`
    parts.push(msg)
  }
  return parts.join('. ')
})
const relocate = useMediaRelocate(() => { lib.fetchLibrary(); lib.clear() })
const { busy: relocateBusy, error: relocateError } = relocate

const conflictOpen = ref(false)
const pasteConflicts = ref<Conflict[]>([])
const pendingRelocate = ref<{ type: 'move' | 'copy'; items: OpItem[]; dest: string; onSuccess?: () => void } | null>(null)

async function doRelocate(type: 'move' | 'copy', opItems: OpItem[], dest: string, onSuccess?: () => void) {
  try {
    const report = await relocate.preview(type, opItems, dest)
    if (report.conflicts.length) {
      pendingRelocate.value = { type, items: opItems, dest, onSuccess }
      pasteConflicts.value = report.conflicts
      conflictOpen.value = true
    } else {
      await relocate.execute(type, opItems, dest, 'abort')
      onSuccess?.()
    }
  } catch {
    // relocateError surfaces in the library alert
  }
}

function onPaste(dest: string) {
  if (error.value) return
  const cb = clipboard.value
  if (!cb) return
  const type = cb.mode === 'cut' ? 'move' : 'copy'
  doRelocate(type, cb.items, dest, cb.mode === 'cut' ? () => clearClipboard() : undefined)
}

function onMove(opItems: OpItem[], dest: string) {
  doRelocate('move', opItems, dest)
}

async function onResolveConflict(strategy: 'skip' | 'overwrite' | 'rename') {
  const p = pendingRelocate.value
  if (!p) return
  try {
    await relocate.execute(p.type, p.items, p.dest, strategy)
    conflictOpen.value = false
    pendingRelocate.value = null
    pasteConflicts.value = []
    p.onSuccess?.()
  } catch {
    // relocateError shown inside the open conflict dialog
  }
}

// destructured as `onMenuSelect` to avoid clashing with the existing item-select handler `onSelect`
const { menuItems, onContextMenu, onSelect: onMenuSelect } = useMediaContextMenu({
  items: () => items.value,
  isSelected: lib.isSelected,
  select: lib.select,
  onDelete: async (opItems) => {
    try {
      // set the report + pending items together (after the await) so concurrent previews can't
      // open the dialog with one op's summary while a later op's items are pending
      const report = await ops.previewDelete(opItems)
      pendingDelete.value = opItems
      deleteReport.value = report
      deleteOpen.value = true
    } catch {
      // opError is set by previewDelete and surfaced by the library alert below
    }
  },
  onRename: (item) => { opError.value = null; renameTarget.value = item; renameOpen.value = true },
  currentFolder: () => folder.value,
  clipboardEmpty: () => clipboardEmpty.value,
  onCut: (opItems) => cut(opItems),
  onCopy: (opItems) => copy(opItems),
  onPaste,
})

async function onConfirmDelete() {
  try {
    await ops.confirmDelete(pendingDelete.value)
    deleteOpen.value = false
    deleteReport.value = null
  } catch {
    // opError is set by confirmDelete and shown inside the still-open dialog
  }
}

// Resolve the context-menu label keys here (the composable stays pure/node-testable, returning specs).
const localizedMenu = computed(() => menuItems.value.map((s) => ({
  label: t(s.labelKey, s.count != null ? { n: s.count } : undefined),
  value: s.value,
  ...(s.danger ? { danger: true } : {}),
})))
</script>

<template>
  <!-- eslint-disable-next-line vuejs-accessibility/click-events-have-key-events, vuejs-accessibility/no-static-element-interactions -- @click.self clears selection as a mouse-only bulk convenience; Space-toggle on each MediaGrid/MediaTable item already gives keyboard users the same end state -->
  <section class="media-library" @click.self="lib.clear()" @dragenter="onDragEnter" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <KestrelMediaPathBar :folder="folder" @navigate="lib.navigate" />
    <KestrelMediaToolbar
      :view="view"
      :search="search"
      :disabled="!!error"
      @update:view="lib.setView"
      @update:search="lib.setSearch"
      @upload="onUpload"
      @new-folder="newFolderOpen = true"
    />
    <KestrelUiMenu :items="localizedMenu" @select="onMenuSelect">
      <!-- @contextmenu.capture sets the menu target before Reka's own handler opens the menu, so menuItems is correct when the menu renders -->
      <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -- contextmenu fires natively via Shift+F10/the Menu key when a MediaGrid/MediaTable item has focus, so this capture handler is already keyboard-reachable -->
      <div class="media-library__items" @contextmenu.capture="onContextMenu">
        <KestrelUiAlert v-if="error" variant="error">{{ error }}</KestrelUiAlert>
        <p v-else-if="!loading && !items.length" class="media-library__empty">{{ t('media.folderEmpty') }}</p>
        <KestrelMediaGrid v-else-if="view === 'grid'" :items="items" :is-selected="isSelectedItem" :drop-target-path="dropFolder" :parent-path="parentPath" :up-label="t('media.parentFolder')" @navigate="lib.navigate" @select="onSelect" @open="onOpenItem" @dragstart="onItemDragStart" @dragend="onItemDragEnd" />
        <KestrelMediaTable v-else :items="items" :is-selected="isSelectedItem" :drop-target-path="dropFolder" :sort="sort" :parent-path="parentPath" :up-label="t('media.parentFolder')" @navigate="lib.navigate" @select="onSelect" @open="onOpenItem" @sort="lib.setSort" @dragstart="onItemDragStart" @dragend="onItemDragEnd" />
      </div>
    </KestrelUiMenu>
    <div v-if="hasMore" class="media-library__more">
      <KestrelUiButton :disabled="loading" @click="lib.loadMore">{{ t('media.loadMore') }}</KestrelUiButton>
    </div>
    <p v-if="!clipboardEmpty" class="media-library__clipboard">
      {{ clipboardCount }} {{ clipboardCount === 1 ? t('media.clipboardItem') : t('media.clipboardItems') }} {{ clipboard?.mode === 'cut' ? t('media.clipboardCut') : t('media.clipboardCopied') }}
      <KestrelUiButton size="sm" :disabled="!!error" @click="onPaste(folder)">{{ t('media.pasteHere') }}</KestrelUiButton>
      <KestrelUiButton size="sm" variant="ghost" @click="clearClipboard()">{{ t('media.clear') }}</KestrelUiButton>
    </p>
    <p v-if="active || counts.done || counts.error || counts.skipped" class="media-library__status">
      <span v-if="active">{{ t('media.uploading') }}</span>{{ counts.done }} {{ t('media.uploadUploaded') }}<span v-if="counts.error">, {{ counts.error }} {{ t('media.uploadFailed') }}</span><span v-if="counts.skipped">, {{ counts.skipped }} {{ t('media.uploadSkipped') }}</span>
    </p>
    <p class="media-library__sr-status" role="status" aria-live="polite">{{ srStatus }}</p>
    <div v-if="pick" class="media-library__pickbar">
      <span>{{ selectedFileIds.length }} {{ t('media.selected') }}</span>
      <KestrelUiButton variant="primary" :disabled="!selectedFileIds.length" @click="onConfirmPick">{{ t('media.useSelected') }}</KestrelUiButton>
      <KestrelUiButton variant="ghost" @click="emit('cancel')">{{ t('common.cancel') }}</KestrelUiButton>
    </div>
    <KestrelMediaUploadDialog
      :conflicts="conflicts"
      :open="conflicts.length > 0"
      @resolve="upload.resolve"
      @resolve-all="upload.resolveAll"
      @update:open="(v) => { if (!v) upload.resolveAll('skip') }"
    />
    <KestrelMediaNewFolderDialog v-model:open="newFolderOpen" @create="onCreateFolder" />
    <KestrelMediaViewer :open="viewerOpen" :file="viewerFile" :busy="viewerBusy" :error="viewerError" @update:open="(v) => { viewerOpen = v }" @save="onSaveMeta" />
    <KestrelUiAlert v-if="opError && !deleteOpen && !renameOpen" variant="error">{{ opError }}</KestrelUiAlert>
    <KestrelMediaDeleteDialog
      :open="deleteOpen"
      :report="deleteReport"
      :names="fileNames"
      :busy="opsBusy"
      :error="opError"
      @confirm="onConfirmDelete"
      @update:open="(v) => { if (!v) { deleteOpen = false; deleteReport = null } }"
    />
    <KestrelMediaRenameDialog
      :open="renameOpen"
      :name="renameName"
      :busy="opsBusy"
      :error="opError"
      @rename="onConfirmRename"
      @update:open="(v) => { if (!v) { renameOpen = false; renameTarget = null } }"
    />
    <KestrelUiAlert v-if="relocateError && !conflictOpen" variant="error">{{ relocateError }}</KestrelUiAlert>
    <KestrelMediaConflictDialog
      :open="conflictOpen"
      :conflicts="pasteConflicts"
      :type="pendingRelocate?.type ?? 'move'"
      :dest="pendingRelocate?.dest ?? ''"
      :busy="relocateBusy"
      :error="relocateError"
      @resolve="onResolveConflict"
      @update:open="(v) => { if (!v) { conflictOpen = false; pendingRelocate = null; pasteConflicts = []; relocateError = null } }"
    />
    <div v-if="dragActive && !dropFolder && !error" class="media-library__dropzone" aria-hidden="true">{{ t('media.dropToUpload') }}</div>
  </section>
</template>

<style lang="scss" scoped>
.media-library {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  // Page mode: fill the bounded height from .media-page so the grid scrolls internally. In the picker
  // dialog these are inert (the parent is a plain block, so no bounded height reaches here) and the
  // dialog scrolls as a whole — .media-library__items' overflow never engages there.
  flex: 1 1 auto;
  min-height: 0;
}

// The one scroll region: the file grid/table. Everything else (path bar, toolbar, load-more, clipboard,
// status, pick bar) is fixed chrome.
.media-library > :not(.media-library__items) {
  flex: 0 0 auto;
}
.media-library__items {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.media-library__dropzone {
  position: absolute;
  inset: 0;
  z-index: var(--z-overlay);
  display: grid;
  place-items: center;
  background: var(--color-scrim);
  color: var(--color-on-primary);
  font-size: var(--text-lg);
  border-radius: var(--radius-md);
  pointer-events: none; /* must not intercept dragover/drop events from the section */
}

.media-library__more {
  display: flex;
  justify-content: center;
}

.media-library__empty {
  color: var(--color-text-muted);
  padding: var(--space-6) 0;
  text-align: center;
}

.media-library__status {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

// Visually-hidden permanent live region (mirrors .list__sr-status in CollectionList).
.media-library__sr-status {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

.media-library__clipboard {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.media-library__pickbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  justify-content: flex-end;
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-3);
}
</style>
