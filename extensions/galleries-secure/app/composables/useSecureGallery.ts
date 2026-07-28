// The headless core of the secure gallery VIEWER: password in → decrypted folder/file tree out (or error).
// Single source of decrypt logic; `<SecureGalleryView>` is a thin shell over it, and a developer can build
// a custom UI on the same composable. Browser-only (fetch + WebCrypto + object-URLs); load-bearing pure
// bits live in the utils (`gallery`, `index-codec`, `tree`) and are node-tested. Auto-imported across
// layers. The `key`/`seal`/`open` it returns are the seam the PROOFING extension hooks into to encrypt
// customer annotations under the same gallery key — that seam is preserved verbatim.
//
// v2 storage model: the field/ref carries `{ galleryId, saltB64, verify, base }` (base = the namespace's
// public URL). The tree lives in an encrypted index file at `<base>/index.json`; blobs at `<base>/<blobId>`.
import { ref, computed, watch, onMounted, onScopeDispose, toValue, type MaybeRefOrGetter, type Ref, type ComputedRef } from 'vue'
import { unlockRef, openBlob, fetchGalleryIndex } from '../utils/gallery'
import { verifyIndexAuth } from '../utils/index-auth'
import { encryptBytes, decryptBytes, decryptString } from '../utils/crypto'
import { sealToB64, sealFromB64, type SecureGalleryRef, type SealedB64 } from '../utils/manifest'
import { decodeIndex } from '../utils/index-codec'
import { buildTree, type GalleryNode, type DecryptedItem } from '../utils/tree'
import { parseHashKey } from '../utils/share-link'

export type GalleryState = 'locked' | 'unlocking' | 'unlocked' | 'error'

/** The viewer input: the public field ref plus the resolved storage `base` URL (the public-gallery endpoint
 *  supplies `base`; the index + blobs are fetched relative to it). */
export type GalleryViewRef = SecureGalleryRef & { base: string }

export interface UseSecureGalleryOptions {
  /** Read the password from the URL fragment `#key=…` on mount and auto-unlock (shareable links). */
  autoFromHash?: boolean
}

export interface UseSecureGalleryReturn {
  state: Ref<GalleryState>
  error: Ref<string | null>
  /** Flat list of decrypted images (object-URL `src`, or `failed`). `blobKey` = the stable blobId. */
  items: Ref<DecryptedItem[]>
  /** The images + empty folders as a nested folder/file tree. */
  tree: ComputedRef<GalleryNode[]>
  unlock: (password: string) => Promise<boolean>
  lock: () => void
  /** The in-memory gallery key (null while locked) — the seam for the proofing extension. */
  key: Ref<CryptoKey | null>
  /** Encrypt arbitrary bytes under the gallery key (e.g. a customer's annotation), optionally bound to AAD
   *  (additionalData) that must match on open. Throws while locked. */
  seal: (bytes: Uint8Array, aad?: Uint8Array) => Promise<SealedB64>
  /** Decrypt bytes sealed under the gallery key (with the same optional AAD used to seal). Throws while locked. */
  open: (sealed: SealedB64, aad?: Uint8Array) => Promise<Uint8Array>
}

export function useSecureGallery(
  source: MaybeRefOrGetter<GalleryViewRef | null | undefined>,
  options: UseSecureGalleryOptions = {},
): UseSecureGalleryReturn {
  const state = ref<GalleryState>('locked')
  const error = ref<string | null>(null)
  const key = ref<CryptoKey | null>(null)
  const items = ref<DecryptedItem[]>([])
  const folders = ref<string[]>([])
  const tree = computed(() => buildTree(items.value, folders.value))

  // Bumped on every lock / unmount / new unlock so an in-flight unlock can detect it was superseded and
  // self-cancel — freeing the object-URLs it minted instead of committing a stale session.
  let session = 0

  function revoke() {
    for (const it of items.value) if (it.src) URL.revokeObjectURL(it.src)
    items.value = []
    folders.value = []
  }

  function lock() {
    session++
    revoke()
    key.value = null
    error.value = null
    state.value = 'locked'
  }

  async function unlock(password: string): Promise<boolean> {
    const ref0 = toValue(source)
    if (!ref0) return false
    const gen = ++session
    state.value = 'unlocking'
    error.value = null
    let k: Awaited<ReturnType<typeof unlockRef>>
    try {
      k = await unlockRef(password, ref0)
    } catch {
      // e.g. `crypto.subtle` missing in a non-secure context (plain http, broken TLS termination) — must
      // still resolve the state machine rather than leave it stuck in 'unlocking' forever.
      if (gen !== session) return false
      state.value = 'error'; error.value = 'Could not unlock this gallery on this connection.'
      return false
    }
    if (gen !== session) return false // superseded during key derivation
    if (!k) { state.value = 'error'; error.value = 'Wrong password.'; return false }

    let model
    try {
      const index = await fetchGalleryIndex(ref0.base)
      // Enforce the index integrity tag when the (trusted) ref requires it — a tampered/stripped index fails.
      if (ref0.authIndex && !(await verifyIndexAuth(index, k))) throw new Error('integrity')
      model = await decodeIndex(index, (s) => decryptString(k, sealFromB64(s)))
    } catch {
      if (gen !== session) return false
      state.value = 'error'; error.value = 'Could not load the gallery index.'; return false
    }
    if (gen !== session) return false

    revoke()
    // Sequential fetch+decrypt: predictable and gentle on the origin.
    const decrypted: DecryptedItem[] = []
    for (const f of model.files) {
      if (gen !== session) break
      try {
        const res = await fetch(`${ref0.base}/${f.blobId}`)
        if (!res.ok) throw new Error(String(res.status))
        const ciphertext = new Uint8Array(await res.arrayBuffer())
        const bytes = await openBlob(k, f.ivB64, ciphertext)
        const src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: f.mime }))
        decrypted.push({ name: f.name, dir: f.dir, src, mime: f.mime, blobKey: f.blobId })
      } catch {
        decrypted.push({ name: f.name, dir: f.dir, src: '', mime: f.mime, blobKey: f.blobId, failed: true })
      }
    }
    if (gen !== session) {
      for (const it of decrypted) if (it.src) URL.revokeObjectURL(it.src)
      return false
    }
    key.value = k
    items.value = decrypted
    folders.value = model.folders
    state.value = 'unlocked'
    return true
  }

  async function seal(bytes: Uint8Array, aad?: Uint8Array): Promise<SealedB64> {
    if (!key.value) throw new Error('gallery is locked')
    return sealToB64(await encryptBytes(key.value, bytes, aad))
  }
  async function open(sealed: SealedB64, aad?: Uint8Array): Promise<Uint8Array> {
    if (!key.value) throw new Error('gallery is locked')
    return decryptBytes(key.value, sealFromB64(sealed), aad)
  }

  // A different gallery (ref identity changes) → drop the session + free its blobs.
  watch(() => toValue(source), () => lock())

  if (options.autoFromHash) {
    onMounted(() => {
      const pw = import.meta.client ? parseHashKey(location.hash) : null
      if (pw) {
        // The fragment IS the full master secret. Strip it from the address bar/history immediately so it
        // doesn't linger in a screen-share, the back/forward stack, or a copied URL. (It's a shareable link;
        // anyone with it still has the secret — this just stops it persisting after first use on this page.)
        history.replaceState(null, '', location.pathname + location.search)
        unlock(pw)
      }
    })
  }
  onScopeDispose(() => { session++; revoke() })

  return { state, error, items, tree, unlock, lock, key, seal, open }
}
