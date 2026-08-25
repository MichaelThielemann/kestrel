import { createError, getRequestHeader, readBody } from 'h3'
import { Effect } from 'effect'
import { assertBodyLimit, definePipeline, eventOf } from '@kestrel/core'
import type { StepDef } from '@kestrel/core'
import { mediaRuntimeConfig, useStorageDriver } from '@kestrel/media'
import { orphanBlobKeys, stalePruneKeys } from '../utils/gallery-reconcile'
import { galleryNamespace } from '../utils/namespace'

// Persist a gallery's encrypted INDEX (the tree: sealed file names + folder paths). Public JSON with sealed
// leaves — stored opaquely at `galleries-secure/<galleryId>/index.json`. Returns the namespace's public
// `base` URL so the editor knows where to fetch the index + blobs.
//
// Orphan reconcile: after writing the index we prune namespace `.bin` blobs the index no longer references
// (abandoned/partial uploads). The blobIds are PLAINTEXT in the index (only names/folders are sealed), so this
// needs no key and reveals nothing — zero-knowledge-safe. Best-effort + only on drivers that can `listPrefix`.
//
// Concurrency: the index is written whole, from an in-memory model loaded once at unlock, so a second editor
// tab holding a pre-upload model would overwrite the newer entries' `ivB64` + sealed names — which exist
// NOWHERE else, making their ciphertext permanently undecryptable. The index therefore carries a monotonic
// `seq` (inside the MAC'd bytes) and a write whose seq doesn't advance the stored one is refused with 409,
// before the reconcile can compound the damage by deleting the now-unreferenced ciphertext. A stored index
// that cannot be READ is refused too (503): unread is not unwritten, and treating it as "none" would disarm
// the seq check and the reconcile's shrink check in the same request. A stored index that reads back fine but
// is not an index at all (truncated/garbled) is a permanent state, not a transient one — refusing it forever
// would brick the gallery, so it answers 422 `repairable` and only an explicit `repair: true` overwrites it.

// Spare any blob younger than this from the reconcile — long enough to cover an upload racing a concurrent
// index write, short enough that genuinely abandoned blobs are GC'd on the next index write after the window.
const ORPHAN_GRACE_MS = 60 * 60 * 1000 // 1 hour

interface StoredIndex { seq?: unknown; files?: unknown }

interface IndexReader {
  get?: (key: string) => Promise<Buffer>
  exists?: (key: string) => Promise<boolean>
  stat?: (key: string) => Promise<{ mtimeMs: number | null } | null>
}

/** What a read of the stored index established. `absent` (there is genuinely none) and `unreadable` (there
 *  may be a NEWER one behind a failed read) must never collapse into each other: the guards below key off
 *  exactly that difference. `damaged` is the third case — the bytes ARE readable and are not an index, so
 *  retrying can never change the answer. `unknown` is a driver that cannot read objects back at all. */
type StoredRead =
  | { state: 'absent' | 'unreadable' | 'damaged' | 'unknown' }
  | { state: 'parsed'; index: StoredIndex }

/** Whether `key` is genuinely missing — null when the driver can't say (no probe, or the probe itself
 *  failed). Both shipped drivers implement `exists`; `stat` is the fallback the reconcile already needs. */
async function probeAbsent(driver: IndexReader, key: string): Promise<boolean | null> {
  try {
    if (typeof driver.exists === 'function') return !(await driver.exists(key))
    if (typeof driver.stat === 'function') return (await driver.stat(key)) === null
  } catch {
    return null
  }
  return null
}

async function readStoredIndex(driver: IndexReader, key: string): Promise<StoredRead> {
  if (typeof driver.get !== 'function') return { state: 'unknown' }
  let bytes: Buffer
  try {
    bytes = await driver.get(key)
  } catch {
    // `get` rejects both for a missing object (the normal first write) and for a transient storage failure;
    // only a positive "it is not there" may be treated as absence.
    return { state: (await probeAbsent(driver, key)) ? 'absent' : 'unreadable' }
  }
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown
    if (parsed && typeof parsed === 'object') return { state: 'parsed', index: parsed as StoredIndex }
  } catch { /* falls through to damaged */ }
  // Bytes in hand that are not an index: nothing here carries a comparable seq or a recoverable entry, and no
  // retry will produce one. Distinct from `unreadable` so the caller can offer a deliberate repair.
  return { state: 'damaged' }
}

/** An index's write version. Anything non-numeric (a legacy index, a client that predates `seq`) is 0. */
const seqOf = (index: { seq?: unknown } | null): number =>
  typeof index?.seq === 'number' && Number.isFinite(index.seq) ? index.seq : 0

/** The blobIds an index references (plaintext in the index — no key needed). */
const liveBlobIds = (index: { files?: unknown } | null): string[] =>
  (Array.isArray(index?.files) ? index.files as { blobId?: unknown }[] : [])
    .map((f) => f?.blobId).filter((id): id is string => typeof id === 'string')

const writeGalleryTree: StepDef = {
  name: 'writeGalleryTree',
  fn: (ctx) => Effect.gen(function* () {
    const event = eventOf(ctx)
    // Bound the index size — readBody buffers the whole body with no cap. The index is sealed metadata, so
    // the media upload cap is a generous ceiling against an unbounded/chunked flood.
    assertBodyLimit(getRequestHeader(event, 'content-length'), mediaRuntimeConfig().maxUploadBytes)
    const body = (yield* Effect.promise(() => readBody(event))) as { galleryId?: unknown; index?: { files?: unknown; folders?: unknown; seq?: unknown }; repair?: unknown } | undefined
    const ns = galleryNamespace(body?.galleryId)
    const index = body?.index
    if (!index || typeof index !== 'object' || !Array.isArray(index.files) || !Array.isArray(index.folders)) {
      throw createError({ statusCode: 400, statusMessage: 'invalid index' })
    }
    const driver = useStorageDriver()
    const indexKey = `${ns}/index.json`
    const read = yield* Effect.promise(() => readStoredIndex(driver, indexKey))
    if (read.state === 'unreadable') {
      // The stored index may be newer than this one, and a read failure is transient: refuse so the client
      // keeps its in-memory model (with the IVs + sealed names that exist nowhere else) and can retry.
      throw createError({ statusCode: 503, statusMessage: 'gallery index could not be read' })
    }
    // `repair` is honoured for exactly one server-side state — a stored index read back as not-an-index. Against
    // any readable index it stays inert, so it can never be used to slip a stale write past the seq guard.
    if (read.state === 'damaged' && body?.repair !== true) {
      throw createError({
        statusCode: 422,
        statusMessage: 'stored gallery index is damaged',
        data: { repairable: true },
      })
    }
    const stored = read.state === 'parsed' ? read.index : null
    // Only enforce once the stored index actually carries a seq: a legacy index (written before versioning)
    // has nothing to compare against, and its first versioned write establishes the baseline.
    const storedSeq = typeof stored?.seq === 'number' ? seqOf(stored) : null
    if (storedSeq !== null && seqOf(index) <= storedSeq) {
      throw createError({ statusCode: 409, statusMessage: 'gallery index changed elsewhere' })
    }
    yield* Effect.promise(() => driver.put(indexKey, Buffer.from(JSON.stringify(index)), 'application/json'))

    // Only prune orphan blobs older than a grace window: a blob uploaded but not yet added to the index — an
    // upload racing a concurrent index write (a second tab, or the lightbox alt-save) — is younger than the
    // window and MUST be spared, because its plaintext exists only client-side (an erroneous delete is
    // unrecoverable). Needs both listPrefix + stat; without either, skip pruning entirely (never risk a blob).
    //
    // A second safeguard against an unnoticed clobber: an index that references FEWER blobs than the one it
    // replaced is the clobber signature, so leave the ciphertext alone. Deliberate deletes cost nothing —
    // they delete their own blobs via /blob, and the next non-shrinking write still collects real strays.
    // That comparison needs the replaced index, so a driver that can't read one back — or one whose index was
    // damaged, where the empty stored side would read as "everything is a stray" — never prunes either.
    const live = liveBlobIds(index)
    if (read.state !== 'unknown' && read.state !== 'damaged'
      && typeof driver.listPrefix === 'function' && typeof driver.stat === 'function'
      && live.length >= liveBlobIds(stored).length) {
      // A JS try/catch does NOT observe an Effect failure crossing a `yield*` — only Effect's own
      // combinators do — so the "log and continue" fallback has to be Effect.catchAll over an inner
      // Effect.gen (tryPromise, not plain promise, so a rejection is a proper Fail catchAll can see).
      yield* Effect.gen(function* () {
        const candidates = orphanBlobKeys(yield* Effect.tryPromise({ try: () => driver.listPrefix!(ns), catch: (error) => error }), live)
        const withAge = yield* Effect.tryPromise({
          try: () => Promise.all(candidates.map(async (key) => ({ key, mtimeMs: (await driver.stat!(key))?.mtimeMs ?? null }))),
          catch: (error) => error,
        })
        const strays = stalePruneKeys(withAge, Date.parse(ctx.facts.now), ORPHAN_GRACE_MS)
        yield* Effect.tryPromise({ try: () => Promise.all(strays.map((key) => driver.delete(key))), catch: (error) => error })
      }).pipe(
        Effect.catchAll((error) => Effect.sync(() => {
          console.error('[kestrel] galleries-secure: blob reconcile failed (orphans left in place):', error)
        })),
      )
    }
    ctx.output = { ok: true, base: driver.publicUrl(ns) }
  }),
}

export const secureGalleryTreePipeline = definePipeline({
  name: 'secureGalleryTree',
  access: { role: 'admin' },
  rawBody: true,
  steps: [writeGalleryTree],
})
