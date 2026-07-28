<script setup lang="ts">
// The editor widget for the `secureGallery` field — a media-picker-grade explorer over an ENCRYPTED,
// storage-1:1 gallery. Zero-knowledge: the password + derived key live ONLY in this component's memory for
// the session; the field value holds just the public ref ({ galleryId, salt, verify }). The tree (sealed
// file names + folder paths) is the encrypted index file at `galleries-secure/<galleryId>/index.json`; the
// ciphertext blobs sit beside it. Every op (upload / new folder / delete) persists to storage IMMEDIATELY
// (POST blob + PUT index), so what the picker shows mirrors storage. Presentation reuses Kestrel's media
// components (`MediaToolbar`/`MediaGrid`/`MediaTable`) fed a `LibraryItem[]` adapter. `UiField`/`UiButton`/
// `UiIcon` + the media components + `recordEditContextKey` are auto-imported.
import { ref, computed, onBeforeUnmount, inject } from 'vue'
import type { SecureGalleryRef, SealedB64, GalleryIndex } from '../../utils/manifest'
import { sealToB64, sealFromB64 } from '../../utils/manifest'
import { createGallery, unlockRef, sealBlob, openBlob, fetchGalleryIndex, isIndexDamaged } from '../../utils/gallery'
import { authenticateIndex, verifyIndexAuth } from '../../utils/index-auth'
import { encryptString, decryptString, decryptBytes } from '../../utils/crypto'
import { type WorkingFile, encodeIndex, decodeIndex, addFile, removeFile, addFolder, removeFolderRecursive, renameFolder, moveFile } from '../../utils/index-codec'
import { toLibraryItems, type LibraryItem, type LibraryFile } from '../../utils/library-adapter'
import { parentFolder, joinFolder } from '../../utils/path'
import { generatePassphrase, estimatePasswordBits, MIN_PASSWORD_BITS } from '../../utils/passphrase'
import { extractUploads } from '../../utils/dnd'

const props = defineProps<{
  field?: unknown; name: string; locale?: string; error?: string | null; disabled?: boolean; id?: string
  /** Optional extra view filter (proofing-agnostic): a wrapping extension can pass a predicate to narrow the
   *  shown items (e.g. by customer colour mark). Applied after search; folders should be passed through. */
  filter?: (item: LibraryItem) => boolean
}>()
const model = defineModel<SecureGalleryRef | null>()

const key = ref<CryptoKey | null>(null)
const base = ref('')
const phase = computed<'create' | 'locked' | 'unlocked'>(() => (key.value ? 'unlocked' : model.value ? 'locked' : 'create'))

const MIN_PASSWORD = 8
const password = ref('')
const confirm = ref('')
const suggested = ref('')
const notice = ref<string | null>(null)
const busy = ref(false)

// The decrypted working model (in memory while unlocked) + per-blob object-URL previews. The index in
// storage is the persisted, sealed form; this is what the explorer renders + mutates.
const files = ref<WorkingFile[]>([])
const folders = ref<string[]>([])
const previews = ref<Record<string, { src: string; failed?: boolean }>>({})
// Version of the index this model was loaded from. Every write sends `seq + 1` and the server refuses a
// write that doesn't advance the stored one, so a second tab still holding a pre-upload model can't
// overwrite entries whose IVs + sealed names exist nowhere else.
const seq = ref(0)
// Set when a write lost the race with another tab. The model stays in memory: it holds the only copy of any
// entry this session added, so it is reconciled against the stored index on demand, never discarded.
const conflict = ref(false)
// Set when the server reports the STORED index is damaged (unparseable) — the in-memory model is fine and can
// be written over it, but only on an explicit request.
const damagedStored = ref(false)
// The unlock counterpart: the password verified but the stored index turned out to be damaged, so there is no
// model to open. The verified key waits here (never committed to `key`, which would mean "unlocked" over an
// empty model) until the user asks for the rebuild.
const damagedIndex = ref(false)
let verifiedKey: CryptoKey | null = null
let damagedBase = ''
// What this session minted and no accepted index write has acknowledged yet. Only these may be re-applied on
// top of a reloaded index: by blobId/path alone "added here" and "deleted by the other writer" look identical,
// and only this session can know which of the two it is.
const unsavedBlobIds = new Set<string>()
const unsavedFolders = new Set<string>()

const currentFolder = ref('')
const view = ref<'grid' | 'table'>('grid')
const search = ref('')
const selected = ref<Set<string>>(new Set())

// Lightbox viewer (reuses the media MediaViewer): the decrypted image + info + an editable (sealed) alt text.
const viewerFile = ref<LibraryFile | null>(null)
const viewerOpen = ref(false)
const viewerBusy = ref(false)
const viewerError = ref<string | null>(null)

// Discard cleanup: if this gallery was minted in a draft that's left without saving, wipe its namespace.
// `recordEditContextKey` is an auto-imported Kestrel symbol (provided by CollectionEditor).
const ctx = inject(recordEditContextKey, null)
let createdThisSession = false

const sealStr = async (s: string) => sealToB64(await encryptString(key.value!, s))
// Decrypt bytes sealed under the gallery key — the seam a wrapping extension (proofing) reads to load the
// customers' CLIENT-ENCRYPTED annotations once the photographer has unlocked. MUST be a real function: a
// bare `open` in `defineExpose` below would otherwise silently resolve to the global `window.open`.
const open = (s: SealedB64, aad?: Uint8Array) => decryptBytes(key.value!, sealFromB64(s), aad)

function suggest() {
  const phrase = generatePassphrase()
  password.value = confirm.value = suggested.value = phrase
  notice.value = null
}

function revokeAll() {
  for (const p of Object.values(previews.value)) if (p.src) URL.revokeObjectURL(p.src)
  previews.value = {}
}
onBeforeUnmount(() => { revokeAll(); void maybeCleanupDraft() })

/** Persist the current working model as the encrypted index (with a whole-index integrity tag). `repair`
 *  overwrites a stored index the server reports as damaged; the server ignores it in every other state, so it
 *  can never stand in for the seq guard. */
async function putIndex(opts: { repair?: boolean } = {}) {
  const next = seq.value + 1
  const encoded = await encodeIndex({ files: files.value, folders: folders.value }, sealStr)
  // `seq` sits inside the authenticated bytes (the tag covers everything but itself), so it can't be
  // rewritten in storage to unblock a stale write.
  const index: GalleryIndex & { seq: number } = { ...encoded, seq: next }
  const authed = await authenticateIndex(index, key.value!)
  try {
    const res = await $fetch<{ base: string }>('/api/galleries-secure/tree', {
      method: 'PUT',
      body: { galleryId: model.value!.galleryId, index: authed, ...(opts.repair ? { repair: true } : {}) },
    })
    base.value = res.base
    seq.value = next
    damagedStored.value = false
    // Storage now holds every entry this session minted, so the other writer's later state is authoritative
    // about them: a merge must not re-apply them.
    unsavedBlobIds.clear()
    unsavedFolders.clear()
  } catch (err) {
    const status = (err as { statusCode?: number; status?: number })?.statusCode ?? (err as { status?: number })?.status
    if (status === 422) {
      // The stored index is not an index any more. This model is intact and is the better copy — but writing
      // over storage is destructive, so ask first.
      damagedStored.value = true
      throw new Error('The stored gallery index is damaged. Everything in this tab is intact — restore it over the damaged index to save.')
    }
    if (status !== 409) throw err
    damagedStored.value = false // a 409 means the server read a real index back — whatever was damaged is gone
    // Someone else wrote this gallery after we loaded it, so this model can't be retried as-is. It must not
    // be dropped either: the entries added this session carry `ivB64` + sealed names that exist NOWHERE else
    // (the rejected write was their first trip to storage), so discarding them would leave their ciphertext
    // permanently undecryptable — and unreferenced, hence orphan-pruned. Surface it and let the user merge.
    conflict.value = true
    throw new Error('This gallery was changed elsewhere. Your changes are still here — merge them with the current version to save.')
  }
}

/** Reload the stored index and re-apply what only this session has, then persist the union. */
async function mergeStored() {
  if (!key.value || !model.value) return
  notice.value = null
  busy.value = true
  try {
    const newBase = (await $fetch<{ base: string }>('/api/galleries-secure/base', { query: { galleryId: model.value.galleryId } })).base
    const index = await fetchGalleryIndex(newBase)
    if (model.value.authIndex && !(await verifyIndexAuth(index, key.value))) throw new Error('The gallery index failed its integrity check.')
    const current = await decodeIndex(index, (s) => decryptString(key.value!, sealFromB64(s)))
    const loaded = (index as { seq?: unknown }).seq
    const known = new Set(current.files.map((f) => f.blobId))
    // The stored side is authoritative; on top of it go ONLY the entries this session minted and never got
    // persisted, because their `ivB64` + sealed names exist nowhere else. Anything else this model still holds
    // but the stored index doesn't, was deleted by the other writer — re-adding it (the blobId is missing from
    // storage either way) would resurrect an entry pointing at ciphertext that is already gone.
    base.value = newBase
    const merged = [...current.files, ...files.value.filter((f) => unsavedBlobIds.has(f.blobId) && !known.has(f.blobId))]
    const dropped = new Set(files.value.map((f) => f.blobId))
    for (const f of merged) dropped.delete(f.blobId)
    for (const blobId of dropped) {
      const p = previews.value[blobId]
      if (p?.src) URL.revokeObjectURL(p.src)
      const next = { ...previews.value }; delete next[blobId]; previews.value = next
    }
    files.value = merged
    folders.value = [...new Set([...current.folders, ...folders.value.filter((p) => unsavedFolders.has(p))])]
    seq.value = typeof loaded === 'number' && Number.isFinite(loaded) ? loaded : 0
    conflict.value = false
    await putIndex()
    for (const f of files.value) void loadPreview(f)
  } catch (err) {
    // There is nothing to merge WITH when the stored index is damaged — but this model is intact, so route to
    // the restore rather than leaving the conflict banner pointing at an action that can only fail again.
    if (isIndexDamaged(err)) damagedStored.value = true
    notice.value = (err as Error)?.message || 'Could not merge the current version.'
  } finally { busy.value = false }
}

async function loadPreview(f: WorkingFile) {
  // Only short-circuit a SUCCESSFUL preview; a prior transient failure (src:'' + failed:true) stays retryable
  // instead of being permanently stuck until lock/unlock.
  if (previews.value[f.blobId]?.src) return
  try {
    const res = await fetch(`${base.value}/${f.blobId}`)
    if (!res.ok) throw new Error(String(res.status))
    const bytes = await openBlob(key.value!, f.ivB64, new Uint8Array(await res.arrayBuffer()))
    const src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: f.mime }))
    previews.value = { ...previews.value, [f.blobId]: { src } }
  } catch {
    previews.value = { ...previews.value, [f.blobId]: { src: '', failed: true } }
  }
}

async function create() {
  notice.value = null
  if (password.value.length < MIN_PASSWORD) { notice.value = `Use a password of at least ${MIN_PASSWORD} characters.`; return }
  // The ciphertext is world-readable, so a weak password — not the crypto — is the breakable link. Reject
  // low-entropy inputs and steer to the generated passphrase.
  if (estimatePasswordBits(password.value) < MIN_PASSWORD_BITS) {
    notice.value = 'That password is too weak. Add length and variety, or click Suggest for a strong passphrase.'
    return
  }
  if (password.value !== confirm.value) { notice.value = 'The passwords do not match.'; return }
  busy.value = true
  try {
    const { ref: galleryRef, key: k } = await createGallery(password.value)
    model.value = galleryRef
    key.value = k
    createdThisSession = true
    files.value = []
    folders.value = []
    unsavedBlobIds.clear()
    unsavedFolders.clear()
    seq.value = 0
    await putIndex() // mint an (empty) index immediately + learn `base`
    password.value = confirm.value = suggested.value = ''
  } catch (err) {
    notice.value = (err as Error)?.message || 'Could not create the gallery.'
  } finally { busy.value = false }
}

async function unlock() {
  notice.value = null
  damagedIndex.value = false
  verifiedKey = null
  const ref0 = model.value
  if (!ref0) return
  busy.value = true
  let newBase = ''
  try {
    const k = await unlockRef(password.value, ref0)
    if (!k) { notice.value = 'Wrong password.'; return }
    verifiedKey = k
    // Load + decode EVERYTHING into locals first; commit the unlocked state ONLY once it all succeeds. A
    // transient base/index error must leave the widget locked — otherwise the explorer would show "unlocked"
    // over an empty model and the next putIndex() would persist that empty index over the real one, orphaning
    // every blob (their IVs/names are gone, so the ciphertext becomes undecryptable). Decode with the local
    // key `k` — `key.value` is committed only after the load succeeds.
    newBase = (await $fetch<{ base: string }>('/api/galleries-secure/base', { query: { galleryId: ref0.galleryId } })).base
    const index = await fetchGalleryIndex(newBase)
    // Enforce the index integrity tag when the (trusted) ref says this gallery has one — a tamper/strip fails here.
    if (ref0.authIndex && !(await verifyIndexAuth(index, k))) throw new Error('The gallery index failed its integrity check.')
    const model0 = await decodeIndex(index, (s) => decryptString(k, sealFromB64(s)))
    const loaded = (index as { seq?: unknown }).seq
    key.value = k
    base.value = newBase
    files.value = model0.files
    folders.value = model0.folders
    unsavedBlobIds.clear()
    unsavedFolders.clear()
    seq.value = typeof loaded === 'number' && Number.isFinite(loaded) ? loaded : 0
    password.value = ''
    for (const f of files.value) void loadPreview(f)
  } catch (err) {
    // A damaged index is permanent — retrying can only reproduce it — so offer the deliberate rebuild instead
    // of a dead end. Every other failure may be transient: stay locked and say so, so a retry can still find
    // the real index. The key is held aside, NOT committed: unlocking over an empty model is what makes the
    // next write clobber a healthy index.
    if (verifiedKey && isIndexDamaged(err)) {
      damagedIndex.value = true
      damagedBase = newBase
    } else {
      notice.value = (err as Error)?.message || 'Could not open the gallery.'
    }
  } finally { busy.value = false }
}

/** Deliberate recovery from a damaged stored index: replace it with a fresh empty one. Destructive — the
 *  index held every blob's name + IV, so nothing already in the gallery can be decrypted once it is gone. */
async function rebuildIndex() {
  const k = verifiedKey
  if (!k || !model.value) return
  if (typeof window !== 'undefined' && !window.confirm('Rebuild this gallery with an empty index? The photos it already contains cannot be decrypted any more and will be removed from it.')) return
  busy.value = true
  notice.value = null
  try {
    key.value = k
    base.value = damagedBase
    files.value = []
    folders.value = []
    unsavedBlobIds.clear()
    unsavedFolders.clear()
    seq.value = 0
    await putIndex({ repair: true })
    damagedIndex.value = false
    verifiedKey = null
    password.value = ''
  } catch (err) {
    // Back to locked: the server refuses the repair once the stored index reads back fine again (a concurrent
    // writer beat us to it), and an unlocked-over-empty model would then persist over that real index.
    key.value = null
    conflict.value = false
    damagedStored.value = false
    notice.value = (err as Error)?.message || 'Could not rebuild the gallery index.'
  } finally { busy.value = false }
}

/** The unlocked counterpart: this tab's model is complete, so write IT over the damaged stored index. */
async function restoreOverDamaged() {
  if (!key.value || !model.value) return
  busy.value = true
  notice.value = null
  try { await putIndex({ repair: true }) }
  catch (err) { notice.value = (err as Error)?.message || 'Could not restore the gallery index.' }
  finally { busy.value = false }
}

function lock() {
  key.value = null
  conflict.value = false
  damagedStored.value = false
  damagedIndex.value = false
  verifiedKey = null
  revokeAll()
  files.value = []
  folders.value = []
  unsavedBlobIds.clear()
  unsavedFolders.clear()
  selected.value = new Set()
  currentFolder.value = ''
  seq.value = 0 // the next unlock reloads it from the stored index
}

// --- explorer ops (each persists immediately) ---
const keyOf = (item: LibraryItem) => (item.type === 'folder' ? `folder:${item.folder.path}` : `file:${item.file.id}`)
const isSelected = (item: LibraryItem) => selected.value.has(keyOf(item))
function onSelect(item: LibraryItem) {
  const k = keyOf(item)
  const next = new Set(selected.value)
  next.has(k) ? next.delete(k) : next.add(k)
  selected.value = next
}
function navigate(path: string) { currentFolder.value = path; selected.value = new Set() }

const visibleItems = computed<LibraryItem[]>(() => {
  let all = toLibraryItems(currentFolder.value, files.value, folders.value, previews.value)
  const q = search.value.trim().toLowerCase()
  if (q) all = all.filter((i) => (i.type === 'folder' ? i.folder.name : i.file.filename).toLowerCase().includes(q))
  if (props.filter) all = all.filter(props.filter)
  return all
})
const parentPath = computed(() => parentFolder(currentFolder.value))
const selectedBlobIds = computed<string[]>(() =>
  visibleItems.value
    .filter((i) => i.type === 'file' && isSelected(i))
    .map((i) => (i.type === 'file' ? i.file.blobId : undefined))
    .filter((id): id is string => !!id))
const selectedFolderPaths = computed<string[]>(() =>
  visibleItems.value
    .filter((i) => i.type === 'folder' && isSelected(i))
    .map((i) => (i.type === 'folder' ? i.folder.path : ''))
    .filter((p): p is string => !!p))

/** Encrypt + upload a batch, each into `dir`, then persist the index once. */
async function addUploads(uploads: { file: File; dir: string }[]) {
  if (!uploads.length || !key.value || !model.value) return
  notice.value = null
  busy.value = true
  try {
    const fresh: WorkingFile[] = []
    for (const { file, dir } of uploads) {
      const { ciphertext, ivB64 } = await sealBlob(key.value, new Uint8Array(await file.arrayBuffer()))
      const { blobId } = await $fetch<{ blobId: string }>('/api/galleries-secure/upload', {
        method: 'POST',
        query: { galleryId: model.value.galleryId },
        body: new Blob([ciphertext as BlobPart], { type: 'application/octet-stream' }),
      })
      const wf: WorkingFile = { blobId, ivB64, name: file.name, mime: file.type || 'application/octet-stream', size: file.size, dir }
      files.value = addFile({ files: files.value, folders: folders.value }, wf).files
      unsavedBlobIds.add(blobId)
      fresh.push(wf)
    }
    await putIndex()
    for (const f of fresh) void loadPreview(f)
  } catch (err) {
    notice.value = (err as Error)?.message || 'Upload failed.'
  } finally { busy.value = false }
}

function onUpload(list: File[]) {
  addUploads(list.map((file) => ({ file, dir: currentFolder.value })))
}

async function onNewFolder() {
  const name = (typeof window !== 'undefined' ? window.prompt('Folder name') : '')?.trim()
  if (!name) return
  const prev = folders.value
  const path = joinFolder(currentFolder.value, name)
  folders.value = addFolder({ files: files.value, folders: folders.value }, path).folders
  unsavedFolders.add(path)
  busy.value = true
  // Mirror the other handlers: roll the optimistic folder back + surface a notice if the persist fails,
  // instead of leaving a phantom folder and an unhandled rejection.
  try { await putIndex() }
  catch (err) { folders.value = prev; notice.value = (err as Error)?.message || 'Could not create the folder.' }
  finally { busy.value = false }
}

// Delete the selected files AND/OR folders (folders recurse — every blob under them goes too).
async function onDelete() {
  const fileIds = selectedBlobIds.value
  const folderPaths = selectedFolderPaths.value
  if ((!fileIds.length && !folderPaths.length) || !model.value) return
  busy.value = true
  try {
    // Build the next model + the full blob set to delete (selected files + everything under selected folders).
    const prev: { files: WorkingFile[]; folders: string[] } = { files: files.value, folders: folders.value }
    let m = prev
    const blobIds = new Set<string>(fileIds)
    for (const path of folderPaths) {
      const r = removeFolderRecursive(m, path)
      m = r.model
      for (const id of r.removedBlobIds) blobIds.add(id)
    }
    for (const id of fileIds) m = removeFile(m, id).model
    files.value = m.files; folders.value = m.folders
    // Persist the index FIRST (entries removed), THEN delete the blobs — a mid-way failure orphans ciphertext
    // rather than leaving a persisted index pointing at already-deleted blobs.
    try { await putIndex() }
    catch (err) { files.value = prev.files; folders.value = prev.folders; throw err }

    for (const blobId of blobIds) {
      try { await $fetch('/api/galleries-secure/blob', { method: 'DELETE', body: { galleryId: model.value.galleryId, blobId } }) } catch { /* orphan ciphertext is harmless */ }
      const p = previews.value[blobId]
      if (p?.src) URL.revokeObjectURL(p.src)
      const next = { ...previews.value }; delete next[blobId]; previews.value = next
    }
    selected.value = new Set()
  } catch (err) {
    notice.value = (err as Error)?.message || 'Delete failed.'
  } finally { busy.value = false }
}

// Rename the single selected folder (a selected child of the current folder), rewriting its subtree.
async function onRenameFolder() {
  const paths = selectedFolderPaths.value
  if (paths.length !== 1 || !model.value) return
  const path = paths[0]!
  const current = path.split('/').pop() ?? path
  const name = (typeof window !== 'undefined' ? window.prompt('Rename folder', current) : '')?.trim()
  if (!name || name === current) return
  const prev: { files: WorkingFile[]; folders: string[] } = { files: files.value, folders: folders.value }
  const next = renameFolder(prev, path, joinFolder(parentFolder(path) ?? '', name))
  if (next === prev) { notice.value = 'Could not rename the folder.'; return } // no-op / guarded (e.g. into itself)
  files.value = next.files; folders.value = next.folders
  selected.value = new Set()
  busy.value = true
  try { await putIndex() }
  catch (err) { files.value = prev.files; folders.value = prev.folders; notice.value = (err as Error)?.message || 'Rename failed.' }
  finally { busy.value = false }
}

// Move the selected files into a destination folder (prompted; empty = root).
async function onMoveFiles() {
  const ids = selectedBlobIds.value
  if (!ids.length || !model.value) return
  const dest = (typeof window !== 'undefined' ? window.prompt('Move to folder (path, empty = root)', currentFolder.value) : null)
  if (dest === null) return // cancelled
  const target = joinFolder(dest)
  const prev: { files: WorkingFile[]; folders: string[] } = { files: files.value, folders: folders.value }
  let m = prev
  for (const id of ids) m = moveFile(m, id, target)
  files.value = m.files
  selected.value = new Set()
  busy.value = true
  try { await putIndex() }
  catch (err) { files.value = prev.files; notice.value = (err as Error)?.message || 'Move failed.' }
  finally { busy.value = false }
}

// Double-click → open the lightbox for that image. Dimensions are read from the (already-decrypted) preview
// in-memory — never stored/leaked; ZK galleries keep no dimensions/upload-date, so those show "—".
function onOpen(item: LibraryItem) {
  if (item.type !== 'file') return
  viewerError.value = null
  viewerFile.value = { ...item.file }
  viewerOpen.value = true
  const { src, blobId } = item.file
  if (!src) return
  const img = new Image()
  img.onload = () => {
    const cur = viewerFile.value
    if (cur && cur.blobId === blobId) viewerFile.value = { ...cur, width: img.naturalWidth, height: img.naturalHeight }
  }
  img.src = src
}

async function onSaveAlt(alt: string) {
  const blobId = viewerFile.value?.blobId
  if (!blobId) return
  viewerBusy.value = true
  viewerError.value = null
  try {
    const next = alt.trim() || undefined
    files.value = files.value.map((f) => (f.blobId === blobId ? { ...f, alt: next } : f))
    if (viewerFile.value) viewerFile.value = { ...viewerFile.value, alt: next }
    await putIndex()
  } catch (err) {
    viewerError.value = (err as Error)?.message || 'Could not save the alt text.'
  } finally { viewerBusy.value = false }
}

const dragActive = ref(false)
async function onDrop(e: DragEvent) {
  e.preventDefault()
  dragActive.value = false
  if (props.disabled || busy.value || !e.dataTransfer) return
  const { uploads, dirs } = await extractUploads(e.dataTransfer, currentFolder.value)
  // Seed dragged folders (incl. empty ones) so structure survives even when a folder has no files.
  for (const d of dirs) {
    folders.value = addFolder({ files: files.value, folders: folders.value }, d).folders
    unsavedFolders.add(joinFolder(d))
  }
  if (uploads.length) {
    addUploads(uploads.map((u) => ({ file: u.file, dir: u.folder }))) // persists the index (folders included)
  } else if (dirs.length) {
    busy.value = true // only empty folders dropped → addUploads would early-return, so persist them here
    try { await putIndex() }
    catch (err) { notice.value = (err as Error)?.message || 'Could not save the folders.' }
    finally { busy.value = false }
  }
}
function onDragOver(e: DragEvent) { e.preventDefault(); if (!props.disabled && !busy.value) dragActive.value = true }
function onDragLeave() { dragActive.value = false }

/** Best-effort: a gallery minted in a never-saved draft → remove its namespace on leave. */
async function maybeCleanupDraft() {
  if (!createdThisSession || !model.value) return
  // Without the edit context we can't tell whether the record was saved → default to KEEP (never destroy a
  // namespace on a guess). With it: keep once the record is no longer a fresh unsaved draft.
  if (!ctx || ctx.id.value !== 'new' || ctx.saved.value) return
  try { await $fetch('/api/galleries-secure/namespace', { method: 'DELETE', body: { galleryId: model.value.galleryId } }) } catch { /* best-effort */ }
}

// Breadcrumb segments of the current folder, each with its navigable path.
const crumbs = computed(() => {
  const out: { label: string; path: string }[] = []
  let acc = ''
  for (const seg of currentFolder.value.split('/').filter(Boolean)) { acc = acc ? `${acc}/${seg}` : seg; out.push({ label: seg, path: acc }) }
  return out
})

// Exposed for a wrapping extension (proofing): the in-memory key (reactive) + the decrypt seam, so it can
// load + decrypt customer marks once the gallery is unlocked. Proofing-agnostic — the base knows nothing
// of what reads these.
defineExpose({ key, open })
</script>

<template>
  <UiField :id="id" :label="name" :error="notice ?? error ?? undefined">
    <template #default="f">
      <div class="secure-gallery">
        <template v-if="phase === 'create'">
          <p class="secure-gallery__note">
            Set a password to create an encrypted gallery. Images are encrypted in your browser before
            upload — the server never sees them. <strong>The password cannot be recovered;</strong> store it safely.
          </p>
          <div class="secure-gallery__row">
            <div class="secure-gallery__field">
              <!-- keydown + prevent: Enter's default is the record form's implicit submission, which
                   would validate + save the whole record before a keyup handler ever ran. -->
              <UiTextInput :id="f.id" v-model="password" type="password" placeholder="Password" autocomplete="new-password" :disabled="disabled || busy" @keydown.enter.prevent="create" />
            </div>
            <div class="secure-gallery__field">
              <UiTextInput v-model="confirm" type="password" placeholder="Confirm password" aria-label="Confirm password" autocomplete="new-password" :disabled="disabled || busy" @keydown.enter.prevent="create" />
            </div>
            <UiButton type="button" variant="ghost" :disabled="disabled || busy" @click="suggest">Suggest</UiButton>
            <UiButton type="button" variant="secondary" :disabled="disabled || busy" @click="create">Create</UiButton>
          </div>
          <p v-if="suggested" class="secure-gallery__note">Suggested password: <code class="secure-gallery__suggested">{{ suggested }}</code> — store it safely, it cannot be recovered.</p>
        </template>

        <template v-else-if="phase === 'locked'">
          <p v-if="damagedIndex" class="secure-gallery__conflict">
            <UiIcon name="triangle-alert" size="0.875rem" />
            The password is correct, but this gallery’s index file is damaged, so its photos can no longer be
            decrypted. You can rebuild the gallery with an empty index and start over.
            <UiButton type="button" variant="secondary" :disabled="busy" @click="rebuildIndex">Rebuild empty index</UiButton>
          </p>
          <p class="secure-gallery__note">This gallery is encrypted. Enter its password to view and manage the images.</p>
          <div class="secure-gallery__row">
            <div class="secure-gallery__field">
              <UiTextInput :id="f.id" v-model="password" type="password" placeholder="Password" autocomplete="current-password" :disabled="disabled || busy" @keydown.enter.prevent="unlock" />
            </div>
            <UiButton type="button" variant="secondary" :disabled="disabled || busy" @click="unlock">Unlock</UiButton>
          </div>
        </template>

        <!-- UNLOCKED: media-style explorer over the encrypted gallery -->
        <template v-else>
          <div class="secure-gallery__explorer" :class="{ 'is-drag': dragActive }" @drop="onDrop" @dragover="onDragOver" @dragleave="onDragLeave">
            <p v-if="conflict" class="secure-gallery__conflict">
              <UiIcon name="triangle-alert" size="0.875rem" />
              This gallery was changed elsewhere, so the last save was refused. Nothing here is lost — merge in
              the current version to save. Do not close this tab before it succeeds.
              <UiButton type="button" variant="secondary" :disabled="busy" @click="mergeStored">Reload &amp; merge</UiButton>
            </p>
            <p v-if="damagedStored" class="secure-gallery__conflict">
              <UiIcon name="triangle-alert" size="0.875rem" />
              The stored index of this gallery is damaged, so the last save was refused. Nothing here is lost —
              restore this tab’s version over it to save. Do not close this tab before it succeeds.
              <UiButton type="button" variant="secondary" :disabled="busy" @click="restoreOverDamaged">Restore this version</UiButton>
            </p>
            <MediaToolbar :view="view" :search="search" :disabled="disabled || busy" @update:view="view = $event" @update:search="search = $event" @upload="onUpload" @new-folder="onNewFolder" />
            <nav class="secure-gallery__crumbs" aria-label="Folder path">
              <button type="button" class="secure-gallery__crumb" :disabled="busy" @click="navigate('')">/</button>
              <template v-for="(c, i) in crumbs" :key="c.path">
                <span v-if="i > 0" class="secure-gallery__crumb-sep">/</span>
                <button type="button" class="secure-gallery__crumb" :disabled="busy" @click="navigate(c.path)">{{ c.label }}</button>
              </template>
              <!-- Optional extension toolbar (e.g. proofing colour filter). Empty by default. -->
              <slot name="toolbar" />
              <span class="secure-gallery__spacer" />
              <UiButton v-if="selectedFolderPaths.length === 1 && !selectedBlobIds.length" type="button" variant="ghost" :disabled="busy" @click="onRenameFolder">Rename</UiButton>
              <UiButton v-if="selectedBlobIds.length" type="button" variant="ghost" :disabled="busy" @click="onMoveFiles">Move ({{ selectedBlobIds.length }})</UiButton>
              <UiButton v-if="selectedBlobIds.length || selectedFolderPaths.length" type="button" variant="ghost" :disabled="busy" @click="onDelete">
                <UiIcon name="trash" size="0.875rem" /> Delete ({{ selectedBlobIds.length + selectedFolderPaths.length }})
              </UiButton>
              <UiButton type="button" variant="ghost" :disabled="busy" @click="lock"><UiIcon name="lock" size="0.875rem" /> Lock</UiButton>
            </nav>

            <MediaGrid v-if="view === 'grid'" :items="visibleItems" :is-selected="isSelected" :parent-path="parentPath" up-label=".." @navigate="navigate" @select="onSelect" @open="onOpen">
              <template #file-overlay="s"><slot name="file-overlay" v-bind="s" /></template>
            </MediaGrid>
            <MediaTable v-else :items="visibleItems" :is-selected="isSelected" :parent-path="parentPath" up-label=".." @navigate="navigate" @select="onSelect" @open="onOpen">
              <template #file-badge="s"><slot name="file-badge" v-bind="s" /></template>
            </MediaTable>

            <p v-if="!visibleItems.length" class="secure-gallery__note">This folder is empty — drag photos or whole folders here, or use “Add images”.</p>
            <p v-if="busy" class="secure-gallery__busy">Working…</p>
            <p v-if="dragActive" class="secure-gallery__drophint">Drop to add &amp; encrypt into this folder</p>
          </div>
          <MediaViewer :open="viewerOpen" :file="viewerFile" :busy="viewerBusy" :error="viewerError"
            @update:open="viewerOpen = $event" @save="onSaveAlt">
            <template #extra="s"><slot name="viewer-extra" v-bind="s" /></template>
          </MediaViewer>
        </template>
      </div>
    </template>
  </UiField>
</template>

<style lang="scss" scoped>
.secure-gallery { display: flex; flex-direction: column; gap: var(--space-2); }
.secure-gallery__note { margin: 0; font-size: var(--text-sm); color: var(--color-text-muted); }
.secure-gallery__suggested { font-family: var(--font-mono, monospace); color: var(--color-text); user-select: all; }
.secure-gallery__row { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
// Flex item around UiTextInput (whose own wrapper is display:block/width:100%) so the password fields share
// the row like the buttons. UiTextInput supplies the control styling + the reveal (show/hide) toggle.
.secure-gallery__field { flex: 1 1 12rem; min-width: 0; }
.secure-gallery__explorer { position: relative; display: flex; flex-direction: column; gap: var(--space-2); border-radius: var(--radius-md); }
.secure-gallery__explorer.is-drag { outline: 2px dashed var(--color-primary, #6366f1); outline-offset: 4px; background: var(--color-surface-2, #f5f5f7); }
.secure-gallery__crumbs { display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center; }
.secure-gallery__crumb { background: none; border: 0; padding: 0 var(--space-1); cursor: pointer; color: var(--color-text); font: inherit; }
.secure-gallery__crumb:hover { text-decoration: underline; }
.secure-gallery__crumb-sep { color: var(--color-text-muted); }
.secure-gallery__spacer { flex: 1 1 auto; }
.secure-gallery__busy { margin: 0; font-size: var(--text-sm); color: var(--color-text-muted); }
.secure-gallery__conflict {
  display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center;
  margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md);
  border: 1px solid var(--color-warning); background: var(--color-surface-2, #f5f5f7);
  color: var(--color-warning-text); font-size: var(--text-sm);
}
.secure-gallery__drophint { margin: 0; font-size: var(--text-sm); color: var(--color-primary, #6366f1); font-weight: var(--weight-medium, 600); }
</style>
