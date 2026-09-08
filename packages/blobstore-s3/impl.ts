import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok, type Result } from "@michaelthielemann/kestrel/result";
import type { BlobInfo, Blobstore, BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";

export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface Config {
  bucket: string;
  prefix: string;
  region?: string | undefined;
  endpoint?: string | undefined;
  forcePathStyle?: boolean | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  timeoutMs?: number | undefined;
  maxAttempts?: number | undefined;
}

export interface S3Like {
  send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand | ListObjectsV2Command | CopyObjectCommand): Promise<unknown>;
}

export function clientOptions(config: Config): S3ClientConfig {
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const options: S3ClientConfig = {
    maxAttempts: config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: timeout, requestTimeout: timeout },
  };
  if (config.region !== undefined) options.region = config.region;
  if (config.endpoint !== undefined) options.endpoint = config.endpoint;
  if (config.forcePathStyle !== undefined) options.forcePathStyle = config.forcePathStyle;
  if (config.accessKeyId !== undefined && config.secretAccessKey !== undefined) {
    options.credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  }
  return options;
}

export function createClient(config: Config): S3Client {
  return new S3Client(clientOptions(config));
}

export interface BlobstoreS3 extends Blobstore {
  close(): void;
}

const TRANSIENT_NAMES = new Set(["TimeoutError", "NetworkingError", "AbortError"]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"]);

/** After the SDK's own `maxAttempts` are spent, this is the only line separating "retry the caller" from "the operation is broken". */
function isTransient(cause: unknown): boolean {
  const e = cause as { name?: string; code?: string; $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
  const status = e.$metadata?.httpStatusCode;
  if (status !== undefined && (status >= 500 || status === 429)) return true;
  if (e.$retryable) return true;
  if (e.name !== undefined && TRANSIENT_NAMES.has(e.name)) return true;
  if (e.code !== undefined && TRANSIENT_CODES.has(e.code)) return true;
  return false;
}

export function createBlobstoreS3(config: Config, client: S3Like = createClient(config)): BlobstoreS3 {
  const fullKey = (key: string): string => {
    if (key === "" || key.startsWith("/")) throw new Error(`blobstore/s3: invalid key ${JSON.stringify(key)}`);
    return config.prefix + key;
  };

  return {
    close() {
      if (client instanceof S3Client) client.destroy();
    },
    async put(key, data, options = {}): Promise<Result<void, BlobstoreError>> {
      try {
        await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: fullKey(key), Body: data, ...(options.contentType === undefined ? {} : { ContentType: options.contentType }) }));
        return ok();
      } catch (cause) {
        if (isTransient(cause)) return err(failure("TRANSIENT", `blobstore/s3: put ${JSON.stringify(key)} failed`, { cause }));
        throw cause;
      }
    },
    async get(key): Promise<Result<Uint8Array | null, BlobstoreError>> {
      try {
        const out = (await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: fullKey(key) }))) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
        if (!out.Body) return ok(null);
        return ok(await out.Body.transformToByteArray());
      } catch (cause) {
        if (cause instanceof NoSuchKey || (cause as { name?: string }).name === "NoSuchKey") return ok(null);
        if (isTransient(cause)) return err(failure("TRANSIENT", `blobstore/s3: get ${JSON.stringify(key)} failed`, { cause }));
        throw cause;
      }
    },
    async remove(key): Promise<Result<void, BlobstoreError>> {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: fullKey(key) }));
        return ok();
      } catch (cause) {
        if (isTransient(cause)) return err(failure("TRANSIENT", `blobstore/s3: remove ${JSON.stringify(key)} failed`, { cause }));
        throw cause;
      }
    },
    async move(from, to): Promise<Result<void, BlobstoreError>> {
      const source = fullKey(from);
      // CopySource is a path: the segments are percent-encoded, the slashes separating them are not
      const copySource = `${config.bucket}/${source.split("/").map(encodeURIComponent).join("/")}`;
      try {
        await client.send(new CopyObjectCommand({ Bucket: config.bucket, Key: fullKey(to), CopySource: copySource, MetadataDirective: "COPY" }));
      } catch (cause) {
        const info = cause as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (info.name === "NoSuchKey" || info.$metadata?.httpStatusCode === 404) return err(failure("NOT_FOUND", `blobstore/s3: ${JSON.stringify(from)} not found`, { cause }));
        if (isTransient(cause)) return err(failure("TRANSIENT", `blobstore/s3: move ${JSON.stringify(from)} to ${JSON.stringify(to)} failed`, { cause }));
        throw cause;
      }
      try {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: source }));
      } catch (cause) {
        if (isTransient(cause)) return err(failure("TRANSIENT", `blobstore/s3: move ${JSON.stringify(from)} to ${JSON.stringify(to)} failed`, { cause }));
        throw cause;
      }
      return ok();
    },
    async list(prefix): Promise<Result<BlobInfo[], BlobstoreError>> {
      const out: BlobInfo[] = [];
      let token: string | undefined;
      try {
        do {
          const page = (await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.prefix + prefix, ContinuationToken: token }))) as {
            Contents?: Array<{ Key?: string; Size?: number }>;
            NextContinuationToken?: string;
          };
          for (const item of page.Contents ?? []) {
            if (item.Key === undefined) continue;
            out.push({ key: item.Key.slice(config.prefix.length), size: item.Size ?? 0 });
          }
          token = page.NextContinuationToken;
        } while (token);
      } catch (cause) {
        if (isTransient(cause)) return err(failure("TRANSIENT", `blobstore/s3: list ${JSON.stringify(prefix)} failed`, { cause }));
        throw cause;
      }
      return ok(out.sort((a, b) => a.key.localeCompare(b.key)));
    },
  };
}
