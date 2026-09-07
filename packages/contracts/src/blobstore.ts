import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import type { KestrelError, Result } from "./errors.ts";

export interface Blob {
  data: Uint8Array;
  contentType: string;
}

export interface BlobInfo {
  key: string;
  size: number;
  contentType: string;
}

export type BlobstoreError = KestrelError<"NOT_FOUND" | "TRANSIENT">;

export interface Blobstore {
  put(key: string, blob: Blob): Promise<Result<void, BlobstoreError>>;
  get(key: string): Promise<Result<Blob | null, BlobstoreError>>;
  /** A missing key is `Ok`. */
  remove(key: string): Promise<Result<void, BlobstoreError>>;
  move(from: string, to: string): Promise<Result<void, BlobstoreError>>;
  list(prefix: string): Promise<Result<BlobInfo[], BlobstoreError>>;
}

export const BLOBSTORE = defineContract<Blobstore>()("blobstore@1", ["put", "get", "remove", "move", "list"]);
