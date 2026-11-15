import { createHash } from "node:crypto";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
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
  /** Milliseconds a connection may take to open and a socket may stay idle before the attempt fails, up to 3 s more from 6000 on; a transfer that keeps moving has no overall limit. */
  timeoutMs?: number | undefined;
  maxAttempts?: number | undefined;
  /** `"WHEN_REQUIRED"` stops the SDK from adding a checksum trailer to uploads; some S3-compatible stores reject or ignore it. */
  requestChecksumCalculation?: "WHEN_SUPPORTED" | "WHEN_REQUIRED" | undefined;
}

export interface S3Like {
  send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand | ListObjectsV2Command | CopyObjectCommand): Promise<unknown>;
}

export function clientOptions(config: Config): S3ClientConfig {
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const options: S3ClientConfig = {
    maxAttempts: config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: timeout, socketTimeout: timeout },
  };
  if (config.region !== undefined) options.region = config.region;
  if (config.endpoint !== undefined) options.endpoint = config.endpoint;
  if (config.forcePathStyle !== undefined) options.forcePathStyle = config.forcePathStyle;
  if (config.requestChecksumCalculation !== undefined) options.requestChecksumCalculation = config.requestChecksumCalculation;
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

/** Whether an SDK error is a failure worth retrying later: a 5xx or 429 status, a retryable flag, or a network-level error. */
export function isTransient(cause: unknown): boolean {
  const e = boundaryCast<{ name?: string; code?: string; $retryable?: unknown; $metadata?: { httpStatusCode?: number } }>(cause, "host");
  const status = e.$metadata?.httpStatusCode;
  if (status !== undefined && (status >= 500 || status === 429)) return true;
  if (e.$retryable) return true;
  if (e.name !== undefined && TRANSIENT_NAMES.has(e.name)) return true;
  if (e.code !== undefined && TRANSIENT_CODES.has(e.code)) return true;
  return false;
}

const HASH_SLICE_BYTES = 1024 * 1024;

async function payloadHash(data: Uint8Array): Promise<string> {
  const hash = createHash("sha256");
  for (let offset = 0; offset < data.byteLength; offset += HASH_SLICE_BYTES) {
    if (offset > 0) await new Promise<void>((resolve) => setImmediate(resolve));
    hash.update(data.subarray(offset, offset + HASH_SLICE_BYTES));
  }
  return hash.digest("hex");
}

const hasHeaders = (request: unknown): request is { headers: Record<string, string> } => typeof request === "object" && request !== null && "headers" in request && typeof request.headers === "object" && request.headers !== null;

async function putCommand(input: ConstructorParameters<typeof PutObjectCommand>[0] & { Body: Uint8Array }): Promise<PutObjectCommand> {
  const command = new PutObjectCommand(input);
  const hash = await payloadHash(input.Body);
  command.middlewareStack.add(
    (next) => async (args) => {
      if (hasHeaders(args.request)) args.request.headers["x-amz-content-sha256"] = hash;
      return next(args);
    },
    { step: "build", name: "payloadHashMiddleware" },
  );
  return command;
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
        await client.send(await putCommand({ Bucket: config.bucket, Key: fullKey(key), Body: data, ...(options.contentType === undefined ? {} : { ContentType: options.contentType }) }));
        return ok();
      } catch (cause) {
        if (isTransient(cause)) return err(failure("TRANSIENT", `blobstore/s3: put ${JSON.stringify(key)} failed`, { cause }));
        throw cause;
      }
    },
    async get(key): Promise<Result<Uint8Array | null, BlobstoreError>> {
      try {
        const out = boundaryCast<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }>(await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: fullKey(key) })), "host");
        if (!out.Body) return ok(null);
        return ok(await out.Body.transformToByteArray());
      } catch (cause) {
        if (cause instanceof NoSuchKey || boundaryCast<{ name?: string }>(cause, "host").name === "NoSuchKey") return ok(null);
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
      const copySource = `${config.bucket}/${source.split("/").map(encodeURIComponent).join("/")}`;
      try {
        await client.send(new CopyObjectCommand({ Bucket: config.bucket, Key: fullKey(to), CopySource: copySource, MetadataDirective: "COPY" }));
      } catch (cause) {
        const info = boundaryCast<{ name?: string; $metadata?: { httpStatusCode?: number } }>(cause, "host");
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
          const page = boundaryCast<{
            Contents?: Array<{ Key?: string; Size?: number }>;
            NextContinuationToken?: string;
          }>(await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.prefix + prefix, ContinuationToken: token })), "host");
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
