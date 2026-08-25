/** Optional per-object write metadata. Omitted by media uploads; the static-output deploy sets `cacheControl`.
 * @public
 */
export interface PutOptions {
  /** `Cache-Control` value (S3 stores it as object metadata served on GET; the local driver ignores it). */
  cacheControl?: string
  /** `Content-Encoding` (e.g. `br`/`gzip`) for a pre-compressed object, so a reverse proxy can serve it
   *  as-is. S3 stores + serves it as object metadata; the local driver ignores it. */
  contentEncoding?: string
}

/** Options `StorageDriver.delete` accepts.
 * @public
 */
export interface DeleteOptions {
  /** Local driver only: after removing the file, also remove parent dirs left empty (up to, never
   *  including, the root). The publisher opts in so an unpublished page leaves no orphan folder; media
   *  uploads leave it OFF so a user-created library folder survives deleting its last file. S3 has no
   *  real directories, so the S3 driver ignores it. */
  pruneEmptyDirs?: boolean
}

/** The storage abstraction media uploads and the static-output deploy both build on — local filesystem or
 *  S3, chosen by whichever config the caller resolves.
 * @public
 */
export interface StorageDriver {
  put(key: string, bytes: Buffer | Uint8Array, contentType: string, opts?: PutOptions): Promise<void>
  copy(srcKey: string, dstKey: string): Promise<void>
  delete(key: string, opts?: DeleteOptions): Promise<void>
  publicUrl(key: string): string
  /** Read an object's bytes back. Rejects when the key is missing (a read, unlike idempotent delete, has
   *  no empty fallback). Backfill / GC re-derivation and the dev on-demand deriver need the original. */
  get?(key: string): Promise<Buffer>
  exists?(key: string): Promise<boolean>
  /** An object's last-modified time (epoch ms), or null when the key is missing. Used by the gallery blob
   *  GC to spare recently-uploaded (not-yet-indexed) blobs from a racing reconcile. `mtimeMs: null` means
   *  the store does not expose an age — callers must treat that as unknown, not as old. */
  stat?(key: string): Promise<{ mtimeMs: number | null } | null>
  ensureDir?(folder: string): Promise<void>
  removeDir?(folder: string): Promise<void>
  /** Every object key under the driver's configured prefix, relative to it (i.e. the put/delete space).
   *  Rejects when the enumeration itself fails: callers delete on the strength of an empty listing, so
   *  "could not enumerate" must never arrive as "there is nothing here". */
  list?(): Promise<string[]>
  /** Like `list()` but restricted to keys under `prefix` (a sub-path of the put/delete space), returned
   *  relative to the driver root. Used to reconcile a per-record namespace against its index (drop strays),
   *  and as the media guard against recursively removing a path that still holds unmanaged objects — so it
   *  rejects on a failed enumeration just like `list()`. */
  listPrefix?(prefix: string): Promise<string[]>
}
