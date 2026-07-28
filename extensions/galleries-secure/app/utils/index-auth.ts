// Whole-index integrity: the encrypted index is PUBLIC JSON with sealed leaves, so GCM authenticates each
// leaf's CONTENT — but not the array order or the plaintext fields (blobId/ivB64/mime/size), so a malicious
// storage backend could silently relabel or reorder entries. This binds the ENTIRE index with one tag: a
// digest of the index, sealed under the gallery key. Only a key holder can produce a valid tag, so any
// tamper (reorder/relabel/strip) of the CURRENT index fails verification. Confidentiality is unchanged — this
// is integrity only.
//
// SCOPE — this authenticates authorship+integrity, and freshness only RELATIVE to a seq you already know.
// The index carries a monotonic `seq` inside the authenticated bytes, so a rolled-back index is detectable by
// a reader holding a higher seq (that is what the server's 409 guard compares against), but the newest seq is
// not anchored anywhere trusted — the DB field ref carries only the `authIndex` flag — so every index the
// key-holder ever wrote stays a valid tag/content pair, and a malicious storage backend can still serve an
// older authentic index to a FRESH reader (undoing a later move/rename) without detection. Impact is limited —
// it only resurfaces content the key-holder already authored + can decrypt (folder organization is not an
// access boundary under whole-gallery-key sharing, and a rolled-back delete points at a blob the
// orphan-reconcile has already removed → a dead reference, not resurfaced plaintext). Closing it needs the seq
// anchored in the trusted DB ref; deferred as low-value. Do NOT read the "any tamper fails" line above as
// anti-rollback.
//
// Backward-compatible: galleries minted before this carry no tag, and the trusted field ref's `authIndex`
// flag says whether to ENFORCE one (the ref lives in the DB, not in tamperable storage, so an attacker can't
// downgrade by stripping the tag). Pure + node-tested.
import { encryptBytes, decryptBytes, sha256 } from './crypto'
import { sealToB64, sealFromB64, type GalleryIndex, type SealedB64 } from './manifest'

type IndexWithMac = GalleryIndex & { mac?: SealedB64 }
const enc = new TextEncoder()

/** Deterministic, key-order-independent serialization (arrays keep order; object keys sorted), so the tag
 *  doesn't depend on incidental JSON key ordering across stringify/parse hops. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** Canonical bytes of the index's AUTHENTICATED content — everything except the tag itself. */
function canonicalBytes(index: IndexWithMac): Uint8Array {
  const { mac: _mac, ...rest } = index
  return enc.encode(stableStringify(rest))
}

/** Seal a digest of the index under the gallery key → the index's integrity tag (returns a new index w/ mac). */
export async function authenticateIndex(index: GalleryIndex, key: CryptoKey): Promise<IndexWithMac> {
  const mac = sealToB64(await encryptBytes(key, await sha256(canonicalBytes(index))))
  return { ...index, mac }
}

/** True iff `index` carries a tag that matches its content under `key`. A missing tag, a wrong key, or any
 *  tamper returns false (the caller decides whether a missing tag is fatal, via the ref's `authIndex` flag). */
export async function verifyIndexAuth(index: GalleryIndex, key: CryptoKey): Promise<boolean> {
  const mac = (index as IndexWithMac).mac
  if (!mac) return false
  try {
    const digest = new Uint8Array(await decryptBytes(key, sealFromB64(mac)))
    const expected = await sha256(canonicalBytes(index as IndexWithMac))
    return digest.length === expected.length && digest.every((b, i) => b === expected[i])
  } catch {
    return false // GCM auth failure (wrong key / forged tag)
  }
}
