import { CopyObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client, type DeleteObjectCommand, type GetObjectCommand, type PutObjectCommand } from "@aws-sdk/client-s3";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { customFailure, failure, type KestrelError } from "@michaelthielemann/kestrel/errors";
import { err, ok, type Result } from "@michaelthielemann/kestrel/result";
import { createClient, isTransient, type Config } from "./impl.ts";

/** The client surface the admin operations use; `S3Client` satisfies it, tests pass a fake. */
export interface S3AdminLike {
  send(command: ListObjectsV2Command | HeadObjectCommand | CopyObjectCommand | PutObjectCommand | GetObjectCommand | DeleteObjectCommand): Promise<unknown>;
}

/** `TRANSIENT` after the SDK's own retries; `NOT_FOUND` for a missing source. Anything else (a denied request, a bad bucket) throws as a wiring bug. */
export type S3AdminError = KestrelError<"NOT_FOUND" | "TRANSIENT">;

/** One object as the store reports it. `lastModified` is epoch milliseconds from the server's clock, `null` when the store sends none. */
export interface ObjectInfo {
  key: string;
  size: number;
  /** The ETag without quotes. It is the content MD5 only for single-part objects stored without customer-supplied encryption keys. */
  etag: string;
  lastModified: number | null;
}

/** Failures of `copy`: a stale or rewritten source (`PRECONDITION_FAILED`) and a destination that does not match the source after the copy (`VERIFY_FAILED`). */
export type S3CopyError = KestrelError<"NOT_FOUND" | "TRANSIENT" | "PAYLOAD_TOO_LARGE" | "PRECONDITION_FAILED" | "VERIFY_FAILED">;

export interface CopyOptions {
  /** The ETag the caller listed for the source. The copy is refused, and nothing is written, when the source no longer has it. */
  ifMatch?: string;
}

export interface CopyResult {
  /** The destination's size, equal to the source's. */
  size: number;
  etag: string;
}

export interface S3AdminOptions {
  /** Waits between attempts to observe a write; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
  /** Heads of a fresh destination before a copy counts as unverified. Default 5. */
  verifyAttempts?: number;
  /** Pause between those attempts in milliseconds. Default 200. */
  retryDelayMs?: number;
}

export interface S3Admin {
  /** Every object under `prefix` with size, ETag and server modification time, ordered by key. Keys are relative to the configured `prefix`. */
  listDetailed(prefix: string): Promise<Result<ObjectInfo[], S3AdminError>>;
  /** Metadata of one object, or `Ok(null)` when the key does not exist. `lastModified` has whole-second precision here. */
  head(key: string): Promise<Result<ObjectInfo | null, S3AdminError>>;
  /**
   * Copies one object inside the bucket on the server and checks the result: the destination must report the
   * source's size, read again while an overwritten destination still looks stale. With `ifMatch` the copy is
   * refused when the source changed, both by the store (`x-amz-copy-source-if-match`) and, for stores that ignore
   * or reject that header, by comparing the source's ETag before and after the copy. Sources above 5 GiB are refused.
   */
  copy(from: string, to: string, options?: CopyOptions): Promise<Result<CopyResult, S3CopyError>>;
  close(): void;
}

/** The largest object a single copy request moves. */
export const MAX_SINGLE_COPY_BYTES = 5 * 1024 ** 3;
const DEFAULT_VERIFY_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 200;

function compareKeys(a: ObjectInfo, b: ObjectInfo): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Strips the quotes (and a weak-validator prefix) a store puts around an ETag. */
export function normalizeEtag(etag: string): string {
  return etag.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}

interface ListedItem {
  Key?: string;
  Size?: number;
  ETag?: string;
  LastModified?: Date;
}

function describeFailure(what: string, cause: unknown): S3AdminError {
  return failure("TRANSIENT", `blobstore/s3 admin: ${what} failed`, { cause });
}

async function guarded<T>(what: string, run: () => Promise<T>): Promise<Result<T, S3AdminError>> {
  try {
    return ok(await run());
  } catch (cause) {
    if (isTransient(cause)) return err(describeFailure(what, cause));
    throw cause;
  }
}

function statusOf(cause: unknown): number | undefined {
  return boundaryCast<{ $metadata?: { httpStatusCode?: number } }>(cause, "host").$metadata?.httpStatusCode;
}

function preconditionFailed(key: string, expected: string, found: string): S3CopyError {
  return customFailure("PRECONDITION_FAILED", 412, `blobstore/s3 admin: ${JSON.stringify(key)} no longer has the expected ETag`, { details: { expectedEtag: expected, foundEtag: found } });
}

function isNotFound(cause: unknown): boolean {
  const info = boundaryCast<{ name?: string; $metadata?: { httpStatusCode?: number } }>(cause, "host");
  return info.name === "NotFound" || info.name === "NoSuchKey" || info.$metadata?.httpStatusCode === 404;
}

/**
 * Bucket-level operations the `blobstore@1` contract does not offer: detailed listings, server-side copy with
 * verification, object metadata and probes of what the store enforces. Keys are relative to `config.prefix`;
 * a client with an empty prefix addresses the whole bucket.
 */
export function createS3Admin(config: Config, client: S3AdminLike = createClient(config), options: S3AdminOptions = {}): S3Admin {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const verifyAttempts = options.verifyAttempts ?? DEFAULT_VERIFY_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const fullKey = (key: string): string => {
    if (key === "" || key.startsWith("/")) throw new Error(`blobstore/s3 admin: invalid key ${JSON.stringify(key)}`);
    return config.prefix + key;
  };
  const relativeKey = (key: string): string => key.slice(config.prefix.length);

  async function head(key: string): Promise<Result<ObjectInfo | null, S3AdminError>> {
    const target = fullKey(key);
    try {
      const out = boundaryCast<{ ContentLength?: number; ETag?: string; LastModified?: Date }>(await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: target })), "host");
      return ok({ key, size: out.ContentLength ?? 0, etag: normalizeEtag(out.ETag ?? ""), lastModified: out.LastModified?.getTime() ?? null });
    } catch (cause) {
      if (isNotFound(cause)) return ok(null);
      if (isTransient(cause)) return err(describeFailure(`head ${JSON.stringify(key)}`, cause));
      throw cause;
    }
  }

  return {
    close() {
      if (client instanceof S3Client) client.destroy();
    },

    listDetailed(prefix) {
      return guarded(`list ${JSON.stringify(prefix)}`, async () => {
        const out: ObjectInfo[] = [];
        let token: string | undefined;
        do {
          const page = boundaryCast<{ Contents?: ListedItem[]; NextContinuationToken?: string }>(
            await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.prefix + prefix, ContinuationToken: token })),
            "host",
          );
          for (const item of page.Contents ?? []) {
            if (item.Key === undefined) continue;
            out.push({ key: relativeKey(item.Key), size: item.Size ?? 0, etag: normalizeEtag(item.ETag ?? ""), lastModified: item.LastModified?.getTime() ?? null });
          }
          token = page.NextContinuationToken;
        } while (token);
        return out.sort(compareKeys);
      });
    },

    head,

    async copy(from, to, copyOptions = {}) {
      const source = await head(from);
      if (!source.ok) return source;
      if (source.value === null) return err(failure("NOT_FOUND", `blobstore/s3 admin: ${JSON.stringify(from)} not found`));
      const expected = source.value;
      if (expected.size > MAX_SINGLE_COPY_BYTES) {
        return err(failure("PAYLOAD_TOO_LARGE", `blobstore/s3 admin: ${JSON.stringify(from)} is ${expected.size} bytes, above the ${MAX_SINGLE_COPY_BYTES} bytes one copy request moves`));
      }
      const ifMatch = copyOptions.ifMatch === undefined ? undefined : normalizeEtag(copyOptions.ifMatch);
      const changed = (found: string): S3CopyError => preconditionFailed(from, ifMatch ?? "", found);
      if (ifMatch !== undefined && expected.etag !== ifMatch) return err(changed(expected.etag));

      const sourcePath = `${config.bucket}/${fullKey(from).split("/").map(encodeURIComponent).join("/")}`;
      const send = (conditionHeader: boolean): Promise<unknown> =>
        client.send(new CopyObjectCommand({
          Bucket: config.bucket,
          Key: fullKey(to),
          CopySource: sourcePath,
          MetadataDirective: "COPY",
          ...(conditionHeader && ifMatch !== undefined ? { CopySourceIfMatch: `"${ifMatch}"` } : {}),
        }));
      try {
        try {
          await send(true);
        } catch (cause) {
          if (statusOf(cause) !== 501 || ifMatch === undefined) throw cause;
          await send(false);
        }
      } catch (cause) {
        if (statusOf(cause) === 412) return err(changed("changed"));
        if (isNotFound(cause)) return err(failure("NOT_FOUND", `blobstore/s3 admin: ${JSON.stringify(from)} not found`, { cause }));
        if (isTransient(cause)) return err(describeFailure(`copy ${JSON.stringify(from)} to ${JSON.stringify(to)}`, cause));
        throw cause;
      }

      let actual: ObjectInfo | null = null;
      for (let attempt = 0; attempt < verifyAttempts; attempt += 1) {
        if (attempt > 0) await sleep(retryDelayMs);
        const destination = await head(to);
        if (!destination.ok) return destination;
        actual = destination.value;
        if (actual !== null && actual.size === expected.size) break;
      }
      if (actual === null || actual.size !== expected.size) {
        return err(customFailure("VERIFY_FAILED", 502, `blobstore/s3 admin: ${JSON.stringify(to)} does not match ${JSON.stringify(from)} after the copy`, { details: { expectedSize: expected.size, actualSize: actual?.size ?? null } }));
      }

      if (ifMatch !== undefined) {
        const after = await head(from);
        if (!after.ok) return after;
        if (after.value === null || after.value.etag !== ifMatch) return err(changed(after.value?.etag ?? "missing"));
      }
      return ok({ size: actual.size, etag: actual.etag });
    },
  };
}
