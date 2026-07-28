import { createLocalDriver } from './storage.local'
import { createS3Driver } from './storage.s3'
import type { ResolvedImagePolicy } from './kestrel-config'

/** Optional per-object write metadata. Omitted by media uploads; the static-output deploy sets `cacheControl`. */
export interface PutOptions {
  /** `Cache-Control` value (S3 stores it as object metadata served on GET; the local driver ignores it). */
  cacheControl?: string
  /** `Content-Encoding` (e.g. `br`/`gzip`) for a pre-compressed object, so a reverse proxy can serve it
   *  as-is. S3 stores + serves it as object metadata; the local driver ignores it. */
  contentEncoding?: string
}

export interface DeleteOptions {
  /** Local driver only: after removing the file, also remove parent dirs left empty (up to, never
   *  including, the root). The publisher opts in so an unpublished page leaves no orphan folder; media
   *  uploads leave it OFF so a user-created library folder survives deleting its last file. S3 has no
   *  real directories, so the S3 driver ignores it. */
  pruneEmptyDirs?: boolean
}

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

/** The `runtimeConfig.media` namespace as the `kestrel` module writes it. */
export interface MediaRuntimeConfig {
  driver: string
  maxUploadBytes: number
  allowedMimes?: string
  imagePolicy?: ResolvedImagePolicy
  local: { dir: string; baseUrl: string }
  s3: {
    bucket: string; region: string; endpoint: string; prefix: string; publicBaseUrl: string
    accessKeyId: string; secretAccessKey: string; sessionToken: string
  }
}

/** Reads that namespace with its real shape. Nuxt derives runtimeConfig types from the values present at
 *  type generation, so the nested variant specs arrive widened to `{}[]` and every consumer would otherwise
 *  assert its own ad-hoc shape. One assertion here also makes a read of a key the module never writes
 *  (e.g. a top-level `baseUrl`) a compile error instead of a silent `undefined`. */
export function mediaRuntimeConfig(): MediaRuntimeConfig {
  return useRuntimeConfig().media as MediaRuntimeConfig
}

export function useStorageDriver(): StorageDriver {
  const media = mediaRuntimeConfig()
  if (media.driver === 's3') {
    const s = media.s3
    // publicBaseUrl is required too: without it publicUrl() would emit relative `/key` URLs that resolve
    // against the app origin (which serves no uploads on S3) instead of the bucket/CDN — breaking media.
    if (!s?.bucket || !s.publicBaseUrl || !s.accessKeyId || !s.secretAccessKey) {
      throw createError({ statusCode: 500, statusMessage: 'S3 media driver is not configured: bucket, publicBaseUrl, and credentials (KESTREL_S3_ACCESS_KEY_ID / _SECRET_ACCESS_KEY) are required' })
    }
    return createS3Driver({
      bucket: s.bucket,
      region: s.region,
      endpoint: s.endpoint || undefined,
      prefix: s.prefix,
      publicBaseUrl: s.publicBaseUrl,
      accessKeyId: s.accessKeyId,
      secretAccessKey: s.secretAccessKey,
      sessionToken: s.sessionToken || undefined,
    })
  }
  return createLocalDriver(media.local)
}
