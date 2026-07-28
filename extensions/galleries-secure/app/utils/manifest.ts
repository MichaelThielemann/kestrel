import { type Sealed, toBase64, fromBase64 } from './crypto'

/** A base64-encoded {@link Sealed} (iv + data) — how a sealed value is stored inside JSON. */
export interface SealedB64 {
  iv: string
  data: string
}

/** The gallery FIELD value (v2). Fully PUBLIC / zero-knowledge: `galleryId` is an unguessable storage
 *  namespace, `salt` + `verify` reveal nothing without the password. The actual tree (files + folders)
 *  lives in an encrypted INDEX file in storage (`galleries-secure/<galleryId>/index.json`), NOT here — so
 *  the picker mirrors storage 1:1. `verify` is a sealed known-constant so a session/viewer can confirm the
 *  password before fetching/decrypting anything. */
export interface SecureGalleryRef {
  v: 2
  galleryId: string
  saltB64: string
  verify: SealedB64
  /** PBKDF2 iteration count this gallery's key was derived at. Absent on galleries minted before it was
   *  carried — those fall back to the legacy count at unlock. Recorded so the work factor can rise over time. */
  iterations?: number
  /** Whether the index carries an integrity tag that MUST be verified on read (see index-auth). Lives in the
   *  trusted field ref (not tamperable storage), so a missing tag can't be downgraded away. Absent on legacy
   *  galleries → integrity is best-effort (not enforced) for them. */
  authIndex?: boolean
}

/** One encrypted image in the index. The ciphertext BYTES live at
 *  `galleries-secure/<galleryId>/<blobId>.bin`; only the IV + sealed original filename + sealed folder path
 *  live here. `mime` is not secret. `dir` absent/empty = the gallery root. */
export interface IndexFile {
  blobId: string
  ivB64: string
  name: SealedB64
  mime: string
  /** Plaintext byte size (cleartext, like `mime`): the ciphertext blob's length already reveals it, so this
   *  is no extra leak — it just saves the explorer a round-trip to show file sizes. */
  size: number
  dir?: SealedB64
  /** Optional alt text, SEALED (it can describe the image content). Set via the lightbox viewer. */
  alt?: SealedB64
}

/** The encrypted INDEX file persisted at `galleries-secure/<galleryId>/index.json`. `folders` is the list
 *  of sealed folder paths so EMPTY folders persist (a file's `dir` only covers folders that contain files).
 *  Public JSON with sealed leaves: counts/structure are observable, names/contents/password are not. */
export interface GalleryIndex {
  v: 1
  files: IndexFile[]
  folders: SealedB64[]
  /** Whole-index integrity tag (a sealed digest under the gallery key) — see index-auth. Present on galleries
   *  created with integrity on; absent on legacy ones. */
  mac?: SealedB64
}

export const sealToB64 = (s: Sealed): SealedB64 => ({ iv: toBase64(s.iv), data: toBase64(s.data) })
export const sealFromB64 = (s: SealedB64): Sealed => ({ iv: fromBase64(s.iv), data: fromBase64(s.data) })

/** An empty index (a freshly-created gallery, before any upload/folder). */
export const emptyIndex = (): GalleryIndex => ({ v: 1, files: [], folders: [] })
