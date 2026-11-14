import { HeadObjectCommand, ListObjectsV2Command, S3Client, type CopyObjectCommand, type DeleteObjectCommand, type GetObjectCommand, type PutObjectCommand } from "@aws-sdk/client-s3";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { failure, type KestrelError } from "@michaelthielemann/kestrel/errors";
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

export interface S3Admin {
  /** Every object under `prefix` with size, ETag and server modification time, ordered by key. Keys are relative to the configured `prefix`. */
  listDetailed(prefix: string): Promise<Result<ObjectInfo[], S3AdminError>>;
  /** Metadata of one object, or `Ok(null)` when the key does not exist. `lastModified` has whole-second precision here. */
  head(key: string): Promise<Result<ObjectInfo | null, S3AdminError>>;
  close(): void;
}

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

function isNotFound(cause: unknown): boolean {
  const info = boundaryCast<{ name?: string; $metadata?: { httpStatusCode?: number } }>(cause, "host");
  return info.name === "NotFound" || info.name === "NoSuchKey" || info.$metadata?.httpStatusCode === 404;
}

/**
 * Bucket-level operations the `blobstore@1` contract does not offer: detailed listings, server-side copy with
 * verification, object metadata and probes of what the store enforces. Keys are relative to `config.prefix`;
 * a client with an empty prefix addresses the whole bucket.
 */
export function createS3Admin(config: Config, client: S3AdminLike = createClient(config)): S3Admin {
  const fullKey = (key: string): string => {
    if (key === "" || key.startsWith("/")) throw new Error(`blobstore/s3 admin: invalid key ${JSON.stringify(key)}`);
    return config.prefix + key;
  };
  const relativeKey = (key: string): string => key.slice(config.prefix.length);

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

    async head(key) {
      const target = fullKey(key);
      try {
        const out = boundaryCast<{ ContentLength?: number; ETag?: string; LastModified?: Date }>(await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: target })), "host");
        return ok({ key, size: out.ContentLength ?? 0, etag: normalizeEtag(out.ETag ?? ""), lastModified: out.LastModified?.getTime() ?? null });
      } catch (cause) {
        if (isNotFound(cause)) return ok(null);
        if (isTransient(cause)) return err(describeFailure(`head ${JSON.stringify(key)}`, cause));
        throw cause;
      }
    },
  };
}
