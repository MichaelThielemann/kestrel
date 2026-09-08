import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import type { KestrelError, Result } from "./errors.ts";

/** `contentType` is a write-time hint for stores that serve objects directly (S3 metadata); a store may ignore it. */
export interface PutOptions {
  contentType?: string;
}

export interface BlobInfo {
  key: string;
  size: number;
}

export type BlobstoreError = KestrelError<"NOT_FOUND" | "TRANSIENT">;

export interface Blobstore {
  put(key: string, data: Uint8Array, options?: PutOptions): Promise<Result<void, BlobstoreError>>;
  get(key: string): Promise<Result<Uint8Array | null, BlobstoreError>>;
  /** A missing key is `Ok`. */
  remove(key: string): Promise<Result<void, BlobstoreError>>;
  move(from: string, to: string): Promise<Result<void, BlobstoreError>>;
  list(prefix: string): Promise<Result<BlobInfo[], BlobstoreError>>;
}

export const BLOBSTORE = defineContract<Blobstore>()("blobstore@1", ["put", "get", "remove", "move", "list"]);
