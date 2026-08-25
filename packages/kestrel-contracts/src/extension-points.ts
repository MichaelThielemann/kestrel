/**
 * The §3.4 extension-point catalog (ADR-0014) as types: every adapter a consumer can plug into Kestrel.
 * Each interface is a plain Promise API — no Effect type crosses this boundary (ADR-0011) — and every
 * method is paired with a `Schema` in a matching {@link AdapterContract} record, so the layer that wraps
 * a consumer's implementation can `decodeUnknown` its return value before it reaches content. A value that
 * fails validation is quarantined, never trusted.
 *
 * An adapter method reports failure by rejecting (or, for a synchronous member, throwing) an ordinary
 * `Error` — never by resolving a sentinel like `null`/`false` in place of a real failure. The wrapping
 * engine layer is what decodes and validates the resolved value and turns both a rejection and a failed
 * decode into the caller's tagged `KestrelError` union; an adapter implementation never constructs one
 * of those tags itself. Per-method TSDoc below calls out only where a method's *success* case carries
 * a non-obvious meaning (e.g. `null` as a legitimate resolved value, not a failure).
 *
 * @packageDocumentation
 */

import { Schema } from 'effect'
import type { PublishedSnapshot } from './brands.js'

/**
 * Pairs an adapter interface with one boundary-validation `Schema` per method, keyed to that method's
 * resolved value. A method added to `T` without a matching entry here is a compile error, which is
 * what makes "every returned value is validated" a static property of the contract rather than a
 * convention.
 *
 * Most methods are `Promise`-returning I/O — the norm, since the adapter is a boundary to the outside
 * world. A method may instead be an ordinary synchronous function when it is pure (no I/O, no ambient
 * state) — `publicUrl` is the one case in this file: both shipped drivers are string concatenation, and
 * forcing that through a `Promise` would only make its one synchronous caller (`resolveMedia`) async
 * for no reason. `AdapterContract` accepts either shape and still requires a schema for it.
 *
 * @public
 */
export type AdapterContract<T> = {
  readonly [K in keyof T]: T[K] extends (...args: never[]) => Promise<infer R>
    ? Schema.Schema<R>
    : T[K] extends (...args: never[]) => infer R
      ? Schema.Schema<R>
      : never
}

/**
 * Optional per-object write metadata (today's real fields, from `publisher.ts`/`deploy-output.ts`):
 * `cacheControl` sets the object's `Cache-Control` (a driver that has no such concept ignores it);
 * `contentEncoding` marks a pre-compressed object (e.g. `br`/`gzip`) so a reverse proxy serves it as-is.
 *
 * @public
 */
export interface PutOptions {
  readonly cacheControl?: string
  readonly contentEncoding?: string
}

/**
 * Optional per-object delete metadata (today's real field, from `publisher.ts`'s `prunePages`):
 * `pruneEmptyDirs` also removes parent directories left empty by the delete, up to but never including
 * the driver root. A driver with no directory concept ignores it.
 *
 * @public
 */
export interface DeleteOptions {
  readonly pruneEmptyDirs?: boolean
}

/**
 * The generic blob-storage port: put, remove, and enumerate keys under a flat namespace. Backs the
 * publish output (`publisher.ts`, `deploy-output.ts`) and any other module that writes files without
 * media-specific semantics.
 *
 * @public
 */
export interface StorageAdapter {
  /** Write `bytes` under `key`, replacing any existing object there. */
  put(key: string, bytes: Uint8Array, contentType: string, opts?: PutOptions): Promise<void>
  /** Remove the object at `key`. Idempotent: removing a missing key is not an error. */
  delete(key: string, opts?: DeleteOptions): Promise<void>
  /** Whether an object currently exists at `key`. */
  exists(key: string): Promise<boolean>
  /** Every key currently stored, for reconcile-style callers that diff against a desired set. Rejects
   *  when the enumeration itself fails: callers delete on the strength of an empty listing, so "could
   *  not enumerate" must never arrive as "there is nothing here". */
  list(): Promise<readonly string[]>
  /** The URL a client fetches `key` from. Pure string construction — no I/O — so this member is
   *  synchronous rather than the file's usual `Promise` (see {@link AdapterContract}). */
  publicUrl(key: string): string
}

/**
 * Boundary schema for every {@link StorageAdapter} method's resolved value.
 *
 * @public
 */
export const StorageAdapterSchemas: AdapterContract<StorageAdapter> = {
  put: Schema.Void,
  delete: Schema.Void,
  exists: Schema.Boolean,
  list: Schema.Array(Schema.String),
  publicUrl: Schema.String,
}

/**
 * The result of a stat lookup: `mtimeMs: null` means the store does not expose an age, which callers
 * must treat as unknown rather than as old.
 *
 * @public
 */
export interface StorageObjectStat {
  readonly mtimeMs: number | null
}

/**
 * The media store port: {@link StorageAdapter} plus the operations media upload, relocate, backfill,
 * and on-demand derivation need — reading an original back, copying/moving within the namespace, and
 * folder-scoped enumeration and cleanup.
 *
 * @public
 */
export interface MediaStorageAdapter extends StorageAdapter {
  /** Read an object's bytes back. Rejects when `key` is missing — unlike `delete`, a read has no empty
   *  fallback. Used by variant backfill and the dev on-demand deriver to re-derive from the original. */
  get(key: string): Promise<Uint8Array>
  /** Copy the object at `srcKey` to `dstKey`, used by relocate/duplicate operations in the media library. */
  copy(srcKey: string, dstKey: string): Promise<void>
  /** An object's last-modified time, or `null` when the key is missing. Used by blob GC to spare a
   *  recently-uploaded, not-yet-indexed object from a racing reconcile. */
  stat(key: string): Promise<StorageObjectStat | null>
  /** Ensure a folder exists, including empty ones created by a move/copy destination. */
  ensureDir(folder: string): Promise<void>
  /** Remove a folder. Callers only call this once they have confirmed nothing unmanaged remains under
   *  it, since the operation is a recursive wipe. */
  removeDir(folder: string): Promise<void>
  /** Every key under `prefix`, relative to the adapter root. Used to check a folder is empty before
   *  `removeDir`, and to reconcile a per-record namespace against its index. Rejects when the
   *  enumeration itself fails: callers delete on the strength of an empty listing, so "could not
   *  enumerate" must never arrive as "there is nothing here". */
  listPrefix(prefix: string): Promise<readonly string[]>
}

/**
 * Boundary schema for every {@link MediaStorageAdapter} method's resolved value.
 *
 * @public
 */
export const MediaStorageAdapterSchemas: AdapterContract<MediaStorageAdapter> = {
  ...StorageAdapterSchemas,
  get: Schema.Uint8ArrayFromSelf,
  copy: Schema.Void,
  stat: Schema.NullOr(Schema.Struct({ mtimeMs: Schema.NullOr(Schema.Number) })),
  ensureDir: Schema.Void,
  removeDir: Schema.Void,
  listPrefix: Schema.Array(Schema.String),
}

/**
 * The outcome of an identity check: `subject` — who the credentials authenticate as — exists only when
 * `ok` is `true`. A discriminated union rather than `{ ok: boolean; subject: string }` because a
 * rejected check has no subject to report; Kestrel has no seam today that identifies who *failed* to
 * authenticate.
 *
 * @public
 */
export const IdentityVerificationSchema = Schema.Union(
  Schema.Struct({ ok: Schema.Literal(true), subject: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false) }),
)

/**
 * The outcome of an identity check: `subject` — who the credentials authenticate as — exists only when
 * `ok` is `true`. A discriminated union rather than `{ ok: boolean; subject: string }` because a
 * rejected check has no subject to report; Kestrel has no seam today that identifies who *failed* to
 * authenticate.
 *
 * @public
 */
export type IdentityVerification = Schema.Schema.Type<typeof IdentityVerificationSchema>

/**
 * The identity port: verify a set of credentials. Kestrel today has a single seam here — the admin
 * login step (`auth.ts`'s `verifyCredentials`) checks one password against one configured hash — so
 * the adapter stays a single method rather than a speculative multi-provider shape until a second
 * identity source exists to generalize from.
 *
 * @public
 */
export interface IdentityProviderAdapter {
  /** Verify `credentials` and report who they authenticate as, if anyone. */
  verifyCredentials(credentials: { readonly password: string }): Promise<IdentityVerification>
}

/**
 * Boundary schema for every {@link IdentityProviderAdapter} method's return value.
 *
 * @public
 */
export const IdentityProviderAdapterSchemas: AdapterContract<IdentityProviderAdapter> = {
  verifyCredentials: IdentityVerificationSchema,
}

/**
 * The delivery port (ADR-0013 §3.3): an adapter that turns published snapshots into what a visitor
 * sees. Reads snapshots only, never drafts, so every delivery adapter renders the same state by
 * construction. `delivery-static` (writes each snapshot to a `StorageDriver` — local dir or S3) and
 * `delivery-live` (serves the snapshot store directly at request time, no files written) are both this
 * one port.
 *
 * @public
 */
export interface DeliveryPort {
  /** Publish one snapshot's routes. */
  publishSnapshot(s: PublishedSnapshot): Promise<void>
  /** Remove previously published routes, e.g. after an unpublish or a route rename. */
  removeRoutes(routes: string[]): Promise<void>
  /** Rebuild every route from a full snapshot stream, for a cold start or a killed-and-restored adapter. */
  rebuildAll(iter: AsyncIterable<PublishedSnapshot>): Promise<void>
}

/**
 * A module's declared table ownership (ADR-0012): the set of table names the enforcing DB adapter
 * grants that module exclusive access to. Every other module's access to `tables` is a CI violation.
 *
 * @public
 */
export const OwnershipManifest = Schema.Struct({
  module: Schema.String,
  tables: Schema.Array(Schema.String),
})

/**
 * A module's declared table ownership (ADR-0012): the set of table names the enforcing DB adapter
 * grants that module exclusive access to. Every other module's access to `tables` is a CI violation.
 *
 * @public
 */
export type OwnershipManifest = Schema.Schema.Type<typeof OwnershipManifest>
