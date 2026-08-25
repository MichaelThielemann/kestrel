// Customer-side proofing state: holds the marks doc, an OPAQUE per-browser customerId (localStorage), and a
// debounced ENCRYPTED submit to the public back-channel. The marks are sealed client-side via the base
// gallery's `seal` (passed in from the same `useSecureGallery` instance the view drives) — so the server
// only ever receives ciphertext. Browser-only (localStorage + $fetch); the pure marks logic lives in
// `../utils/proofing` (node-tested). Identity beyond the opaque id (display name, avatar) is the consumer's
// job — they can fold a name into the sealed payload or build their own UI.
import { ref, computed, onScopeDispose } from 'vue'
import { emptyDoc, setMark as applyMark, validateDoc, proofingAad, sealedTooLarge, type ProofingDoc, type ImageMark } from '../utils/proofing'

export interface UseProofingOptions {
  /** The gallery's slug/path — keys submissions (one per gallery+customer). */
  gallerySlug: string
  /** Encrypt bytes under the gallery key (with optional AAD) — pass `useSecureGallery().seal`. */
  seal: (bytes: Uint8Array, aad?: Uint8Array) => Promise<{ iv: string; data: string }>
  /** Decrypt bytes under the gallery key (with optional AAD) — pass `useSecureGallery().open`. Enables `loadMine()`. */
  open?: (sealed: { iv: string; data: string }, aad?: Uint8Array) => Promise<Uint8Array>
  /** Debounce before auto-submitting after a mark change (ms). */
  debounceMs?: number
}

export type ProofingStatus = 'idle' | 'saving' | 'saved' | 'error'

function ensureStored(key: string): string {
  if (!import.meta.client) return ''
  try {
    let v = localStorage.getItem(key)
    if (!v) { v = crypto.randomUUID(); localStorage.setItem(key, v) }
    return v
  } catch {
    return crypto.randomUUID() // storage blocked (private mode / disabled) → ephemeral per-session value
  }
}

const ensureCustomerId = (gallerySlug: string) => ensureStored(`kestrel:proofing:customer:${gallerySlug}`)
// Per-customer WRITE SECRET proving ownership of the row on later overwrites (the server stores its hash on
// the first submit and requires a match afterwards) — so knowing (slug, customerId) alone can't overwrite.
const ensureWriteSecret = (gallerySlug: string, customerId: string) => ensureStored(`kestrel:proofing:write:${gallerySlug}:${customerId}`)

export function useProofing(options: UseProofingOptions) {
  const { gallerySlug, seal, open, debounceMs = 800 } = options
  const doc = ref<ProofingDoc>(emptyDoc())
  const status = ref<ProofingStatus>('idle')
  const customerId = ensureCustomerId(gallerySlug)
  const writeSecret = ensureWriteSecret(gallerySlug, customerId)

  let timer: ReturnType<typeof setTimeout> | undefined
  // Flush any pending debounced change immediately (rather than lose it): on in-app navigation the scope
  // disposes, and on tab-close / backgrounding the page hides — either can fall inside the 800ms window.
  function flush() {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
    void submit()
  }
  const onHide = () => { if (document.visibilityState === 'hidden') flush() }
  if (import.meta.client) {
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flush)
  }
  onScopeDispose(() => {
    if (import.meta.client) {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', flush)
    }
    flush()
  })

  // Whether we have a DEFINITIVE load result for this (gallery, customer): either the server said "no row"
  // or we successfully decrypted the existing row. Until then a submit must NOT overwrite — a failed load
  // (429/network) that we mistook for "no saved marks" would otherwise let the next mark silently replace
  // the customer's whole stored doc.
  let loaded = !open || !customerId // no way to load → nothing to lose, submit freely

  // Single-flight: never overlap submits (an older request could otherwise overwrite a newer one on the
  // server, since both update the same row). If marks change mid-flight, queue exactly one follow-up that
  // sends the latest doc.
  let submitting = false
  let pending = false
  async function submit() {
    if (!import.meta.client) return
    // Never overwrite a row we haven't confirmed the contents of — retry the load first; if it still fails,
    // surface an error and skip the write rather than clobber the customer's earlier (unread) marks.
    if (!loaded) { await loadMine(); if (!loaded) { status.value = 'error'; return } }
    if (submitting) { pending = true; return }
    submitting = true
    status.value = 'saving'
    try {
      // Bind the seal to (gallerySlug, customerId) so it can't be replayed/relabelled under another id.
      const sealed = await seal(new TextEncoder().encode(JSON.stringify(doc.value)), proofingAad(gallerySlug, customerId))
      // A gallery with many marked photos can sum past the server's envelope cap even though each mark is
      // capped individually — refuse locally rather than spend a request the server would reject anyway.
      if (sealedTooLarge(sealed)) { status.value = 'error'; return }
      // keepalive so a flush triggered by tab-close / pagehide still completes the request.
      await $fetch('/api/proofingSubmit', { method: 'POST', keepalive: true, body: { gallerySlug, customerId, sealed, writeSecret } })
      status.value = 'saved'
    } catch {
      status.value = 'error'
    } finally {
      submitting = false
      if (pending) { pending = false; submit() } // flush the latest state queued during the in-flight call
    }
  }

  /** Restore THIS customer's previously-submitted marks (after a reload). Fetches their own sealed
   *  submission and decrypts it with the gallery key. No-op if `open` wasn't provided, or if the customer
   *  has already marked this session (never clobber fresh edits — re-checked after the await). */
  async function loadMine() {
    if (!import.meta.client || !open || !customerId) { loaded = true; return }
    let res: { sealed: { iv: string; data: string } | null } | undefined
    try {
      res = await $fetch<{ sealed: { iv: string; data: string } | null }>(
        '/api/proofingSubmission', { query: { gallerySlug, customerId } },
      )
    } catch {
      // FETCH failed (429 rate-limit / network) — we do NOT know whether saved marks exist. Stay UNLOADED
      // so a subsequent submit can't overwrite them; the next mark's submit retries the load first.
      return
    }
    if (!res?.sealed) { loaded = true; return } // server definitively has no row → safe to start fresh
    try {
      const stored = validateDoc(JSON.parse(new TextDecoder().decode(await open(res.sealed, proofingAad(gallerySlug, customerId)))))
      // MERGE, don't replace: any marks the customer already made this session (before the load returned)
      // win over the stored ones; the rest of the stored doc is preserved rather than clobbered.
      if (stored) doc.value = { marks: { ...stored.marks, ...doc.value.marks } }
      loaded = true
    } catch {
      // The row exists but we can't decrypt/parse it (wrong key / corrupt) — do NOT overwrite it blindly.
      status.value = 'error'
    }
  }

  /** Set/clear a photo's mark and schedule a debounced encrypted submit. */
  function setMark(blobKey: string, mark: ImageMark) {
    doc.value = applyMark(doc.value, blobKey, mark)
    if (timer) clearTimeout(timer)
    timer = setTimeout(submit, debounceMs)
  }

  return {
    marks: computed(() => doc.value.marks),
    status,
    customerId,
    setMark,
    submit,
    loadMine,
  }
}
