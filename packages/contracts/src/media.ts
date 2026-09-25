import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import type { KestrelError, Result } from "./errors.ts";

/**
 * A stored file as its provider describes it. Only a ready file is ever returned: one whose bytes the
 * provider has stored completely and whose removal has not begun.
 */
export interface MediaFile {
  id: string;
  /** The stored media type in canonical form: lower-case `type/subtype`, plus `; charset=<value>` for a `text/*` type. Type patterns match against it. */
  contentType: string;
  /** The `Content-Type` the provider serves this file's bytes with wherever it publishes them. A consumer that publishes the same bytes at another path sends this type. */
  publishedType: string;
  /** Length of the stored bytes. */
  size: number;
  /** Pixel width the provider read from the stored bytes, before any orientation is applied; `null` when unknown or not an image. */
  width: number | null;
  /** Pixel height, as `width`. */
  height: number | null;
  /** The folder the file is filed under; `""` for the root and for a provider without folders. Can change while the file is ready. */
  folder: string;
  /** The display name. Can change while the file is ready. */
  filename: string;
  /** When the file was created, in milliseconds since the epoch. */
  createdAt: number;
}

/**
 * Which ready files a scan or a count considers. A type pattern is one of: `*`, or a pattern whose type and
 * subtype are both `*` (every type); `type/*` (every subtype of `type`); `type/*+suffix` (every subtype of
 * `type` ending in `+suffix`), or the same with `*` as the type (of every type); `type/subtype` (that type).
 * Case and parameters are ignored on both sides; any other string matches nothing.
 */
export interface MediaFilter {
  /** A file matches when its type matches at least one pattern. Omitted: every type. An empty list matches nothing. */
  types?: readonly string[];
  /** A file whose type matches any of these patterns is left out, even when `types` matches it. */
  excludeTypes?: readonly string[];
  /** Only files created at or after this time, in milliseconds since the epoch. */
  createdSince?: number;
}

export interface MediaScanOptions {
  /** The `next` of the previous call; omitted or `null` starts at the beginning. */
  after?: string | null;
  /** 1 to 500; any other value is a wiring error and throws. */
  limit: number;
}

export interface MediaScan {
  items: MediaFile[];
  /** Resumes after the last item, also in another process or after a restart; `null` when this call returned fewer than `limit` items. */
  next: string | null;
}

/** A ready file and its stored bytes, read together. */
export interface LoadedMediaFile {
  file: MediaFile;
  data: Uint8Array;
}

export type MediaFilesError = KestrelError<"TRANSIENT">;

/**
 * Read access to the files a media provider stores. Readiness is the provider's alone: a file becomes ready
 * once all its bytes are stored, stays ready until its removal begins, and never becomes ready again; an id
 * is never reused. A provider ends a file's readiness before it removes any of its bytes. Every method
 * answers from the store, never from a cache kept across calls, so a call that starts after a file became
 * ready or after its removal began sees that. A provider should note what it answers as reads of type
 * `media` (`@michaelthielemann/kestrel/reads`): a `document` read per id asked of `file`, `files` and
 * `load`, a `type` read per `scan` and `count`.
 */
export interface MediaFiles {
  /** The ready file with this id; `Ok(null)` for an unknown id, a file not yet ready, or one whose removal has begun. */
  file(id: string): Promise<Result<MediaFile | null, MediaFilesError>>;
  /** The ready files among `ids`, each once, in the order of its first occurrence; the others are left out. Takes any number of ids. */
  files(ids: readonly string[]): Promise<Result<MediaFile[], MediaFilesError>>;
  /** The ready file with its bytes exactly as stored; `Ok(null)` whenever `file(id)` answers `null`, and for a ready file whose bytes the store has lost, which the provider logs. */
  load(id: string): Promise<Result<LoadedMediaFile | null, MediaFilesError>>;
  /** Ready files matching `filter`, in an order that stays stable for resuming. A file that becomes ready or stops being ready while a scan is under way may or may not be returned by it. */
  scan(filter: MediaFilter, options: MediaScanOptions): Promise<Result<MediaScan, MediaFilesError>>;
  /** The number of ready files matching `filter`: exactly as many as a complete scan with the same filter would return at that moment. */
  count(filter: MediaFilter): Promise<Result<number, MediaFilesError>>;
}

export const MEDIA = defineContract<MediaFiles>()("media@1", ["file", "files", "load", "scan", "count"]);
