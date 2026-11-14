import { createHash } from "node:crypto";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
// eslint-disable-next-line no-restricted-imports -- kestrel-ops is a tool, not a module; it reaches S3 through the client options of the blobstore package it depends on
import { clientOptions } from "@michaelthielemann/kestrel-blobstore-s3/impl";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { ObjectMissing, PreconditionFailed, unquote, type ObjectInfo, type ObjectStore } from "./store.ts";

/** Where and how an {@link s3Store} reaches its bucket. Credentials are resolved values, never written anywhere. */
export interface S3StoreConfig {
  bucket: string;
  prefix: string;
  region?: string | undefined;
  endpoint?: string | undefined;
  forcePathStyle?: boolean | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  /** `"WHEN_REQUIRED"` leaves out the checksum trailers some S3-compatible stores reject. */
  requestChecksumCalculation?: "WHEN_SUPPORTED" | "WHEN_REQUIRED" | undefined;
}

/** An {@link ObjectStore} with its client, which {@link S3Store.close} releases. */
export interface S3Store extends ObjectStore {
  close(): void;
}

interface ServiceError {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

const statusOf = (cause: unknown): number | undefined => boundaryCast<ServiceError>(cause, "host").$metadata?.httpStatusCode;
const nameOf = (cause: unknown): string | undefined => boundaryCast<ServiceError>(cause, "host").name;

/** An {@link ObjectStore} on an S3-compatible bucket below `config.prefix`. */
export function s3Store(config: S3StoreConfig): S3Store {
  const options = clientOptions({ ...config, timeoutMs: 60_000 });
  if (config.requestChecksumCalculation !== undefined) {
    options.requestChecksumCalculation = config.requestChecksumCalculation;
    options.responseChecksumValidation = config.requestChecksumCalculation;
  }
  const client = new S3Client(options);
  const full = (key: string): string => config.prefix + key;
  const id = `s3:${createHash("sha256").update(`${config.endpoint ?? "aws"}\n${config.region ?? ""}\n${config.accessKeyId ?? ""}`).digest("hex").slice(0, 16)}`;
  const store: S3Store = {
    id,
    close: () => client.destroy(),
    locate: (key) => ({ bucket: config.bucket, key: full(key) }),
    async list(prefix) {
      const out: ObjectInfo[] = [];
      let token: string | undefined;
      do {
        const page = boundaryCast<{ Contents?: Array<{ Key?: string; Size?: number; ETag?: string; LastModified?: Date }>; NextContinuationToken?: string }>(
          await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: full(prefix), ContinuationToken: token })),
          "host",
        );
        for (const item of page.Contents ?? []) {
          if (item.Key === undefined) continue;
          out.push({ key: item.Key.slice(config.prefix.length), size: item.Size ?? 0, etag: unquote(item.ETag), lastModified: item.LastModified?.getTime() ?? 0 });
        }
        token = page.NextContinuationToken;
      } while (token);
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    async head(key) {
      try {
        const out = boundaryCast<{ ContentLength?: number; ETag?: string; LastModified?: Date; ContentType?: string }>(await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: full(key) })), "host");
        return { key, size: out.ContentLength ?? 0, etag: unquote(out.ETag), lastModified: out.LastModified?.getTime() ?? 0, ...(out.ContentType === undefined ? {} : { contentType: out.ContentType }) };
      } catch (cause) {
        if (statusOf(cause) === 404 || nameOf(cause) === "NotFound" || nameOf(cause) === "NoSuchKey") return null;
        throw cause;
      }
    },
    async get(key) {
      try {
        const out = boundaryCast<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }>(await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: full(key) })), "host");
        return out.Body ? await out.Body.transformToByteArray() : null;
      } catch (cause) {
        if (statusOf(cause) === 404 || nameOf(cause) === "NoSuchKey") return null;
        throw cause;
      }
    },
    async read(key, readOptions = {}) {
      try {
        const out = boundaryCast<{ Body?: { transformToByteArray(): Promise<Uint8Array> }; ContentType?: string }>(
          await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: full(key), ...(readOptions.ifMatch === undefined ? {} : { IfMatch: `"${readOptions.ifMatch}"` }) })),
          "host",
        );
        if (!out.Body) return null;
        return { data: await out.Body.transformToByteArray(), ...(out.ContentType === undefined ? {} : { contentType: out.ContentType }) };
      } catch (cause) {
        if (statusOf(cause) === 412 || nameOf(cause) === "PreconditionFailed") throw new PreconditionFailed(`${key} changed since it was listed`, { cause });
        if (statusOf(cause) === 404 || nameOf(cause) === "NoSuchKey") return null;
        throw cause;
      }
    },
    async put(key, data, putOptions = {}) {
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: full(key), Body: data, ...(putOptions.contentType === undefined ? {} : { ContentType: putOptions.contentType }) }));
    },
    async copy(sourceKey, key, copyOptions = {}) {
      const source = (copyOptions.from ?? store).locate(sourceKey);
      const copySource = `${source.bucket}/${source.key.split("/").map(encodeURIComponent).join("/")}`;
      try {
        await client.send(new CopyObjectCommand({ Bucket: config.bucket, Key: full(key), CopySource: copySource, MetadataDirective: "COPY", ...(copyOptions.ifMatch === undefined ? {} : { CopySourceIfMatch: `"${copyOptions.ifMatch}"` }) }));
      } catch (cause) {
        if (statusOf(cause) === 412 || nameOf(cause) === "PreconditionFailed") throw new PreconditionFailed(`${sourceKey} changed since it was listed`, { cause });
        if (statusOf(cause) === 404 || nameOf(cause) === "NoSuchKey") throw new ObjectMissing(`${sourceKey} does not exist`, { cause });
        throw cause;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: full(key) }));
    },
  };
  return store;
}
