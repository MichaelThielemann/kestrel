import { createHash } from "node:crypto";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
// eslint-disable-next-line no-restricted-imports -- kestrel-ops is a tool, not a module; it reaches S3 through the admin client of the blobstore package it depends on
import { createS3Admin, normalizeEtag, type S3Admin } from "@michaelthielemann/kestrel-blobstore-s3/admin";
// eslint-disable-next-line no-restricted-imports -- kestrel-ops is a tool, not a module; it builds its S3 client with the options of the blobstore package it depends on
import { clientOptions, type Config } from "@michaelthielemann/kestrel-blobstore-s3/impl";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { KestrelError } from "@michaelthielemann/kestrel/errors";
import type { Result } from "@michaelthielemann/kestrel/result";
import { ObjectMissing, PreconditionFailed, type ObjectInfo, type ObjectStore } from "./store.ts";

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
  /**
   * How long, in milliseconds, opening a connection may take and a request may go without sending or receiving a
   * byte before that attempt fails as a timeout; a transfer that keeps moving data is never cut off. Default 60 000.
   */
  timeoutMs?: number | undefined;
}

/** The default of {@link S3StoreConfig.timeoutMs}. */
export const STORE_IDLE_TIMEOUT_MS = 60_000;

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

function unwrap<T>(what: string, result: Result<T, KestrelError>): T {
  if (result.ok) return result.value;
  if (result.error.code === "PRECONDITION_FAILED") throw new PreconditionFailed(`${what}: ${result.error.message}`, { cause: result.error });
  if (result.error.code === "NOT_FOUND") throw new ObjectMissing(`${what}: ${result.error.message}`, { cause: result.error });
  throw new Error(`${what}: ${result.error.message}`, { cause: result.error });
}

const refusedMatchingCondition = (details: Record<string, unknown> | undefined, ifMatch: string): boolean => details?.reason === "store-refused" && details.destinationWritten === false && typeof details.foundEtag === "string" && details.foundEtag === normalizeEtag(ifMatch);

/**
 * An {@link ObjectStore} on an S3-compatible bucket below `config.prefix`. Listings, HEADs, server-side copies to
 * free keys and the server clock go through the admin client of `kestrel-blobstore-s3`; such a copy is verified
 * against the source's size and ETag and refused when the source no longer has the listed ETag. A store that
 * answers 412 to `x-amz-copy-source-if-match` although the source still has that ETag gets this and every later
 * copy without the header, checked by comparing the source's ETag before and after. A copy with
 * `replace` is a single CopyObject request that never removes its target. Reads and writes of whole objects use the
 * same S3 client. Two stores copy server-side only within one bucket reached with the same credentials. Every
 * request attempt that stays silent for `config.timeoutMs` fails as a timeout, so a store that stops answering ends
 * the command with an error instead of holding it.
 */
export function s3Store(config: S3StoreConfig): S3Store {
  const timeoutMs = config.timeoutMs ?? STORE_IDLE_TIMEOUT_MS;
  const base: Config = { ...config, timeoutMs };
  const options = { ...clientOptions(base), requestHandler: { connectionTimeout: timeoutMs, socketTimeout: timeoutMs } };
  if (config.requestChecksumCalculation !== undefined) options.responseChecksumValidation = config.requestChecksumCalculation;
  const client = new S3Client(options);
  const full = (key: string): string => config.prefix + key;
  const adminAt = (prefix: string, extra: Parameters<typeof createS3Admin>[2] = {}): S3Admin => createS3Admin({ ...base, prefix }, client, extra);
  const admin = adminAt(config.prefix);
  const bucketAdmin = adminAt("");
  const id = `s3:${createHash("sha256").update(`${config.endpoint ?? "aws"}\n${config.region ?? ""}\n${config.bucket}\n${config.accessKeyId ?? ""}`).digest("hex").slice(0, 16)}`;
  let sourceCheck: "header" | "compare" = "header";
  const toInfo = (info: { key: string; size: number; etag: string; lastModified: number | null }): ObjectInfo => ({ key: info.key, size: info.size, etag: info.etag, lastModified: info.lastModified ?? 0 });
  const getObject = async (key: string, ifMatch?: string): Promise<{ data: Uint8Array; contentType?: string } | null> => {
    try {
      const out = boundaryCast<{ Body?: { transformToByteArray(): Promise<Uint8Array> }; ContentType?: string }>(
        await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: full(key), ...(ifMatch === undefined ? {} : { IfMatch: `"${ifMatch}"` }) })),
        "host",
      );
      if (!out.Body) return null;
      return { data: await out.Body.transformToByteArray(), ...(out.ContentType === undefined ? {} : { contentType: out.ContentType }) };
    } catch (cause) {
      if (statusOf(cause) === 412 || nameOf(cause) === "PreconditionFailed") throw new PreconditionFailed(`${key} changed since it was listed`, { cause });
      if (statusOf(cause) === 404 || nameOf(cause) === "NoSuchKey") return null;
      throw cause;
    }
  };
  const store: S3Store = {
    id,
    close: () => client.destroy(),
    locate: (key) => ({ bucket: config.bucket, key: full(key) }),
    async list(prefix) {
      return unwrap(`list ${prefix}`, await admin.listDetailed(prefix)).map(toInfo);
    },
    async head(key) {
      const info = unwrap(`head ${key}`, await admin.head(key));
      return info === null ? null : toInfo(info);
    },
    async get(key) {
      return (await getObject(key))?.data ?? null;
    },
    async read(key, readOptions = {}) {
      return getObject(key, readOptions.ifMatch);
    },
    async put(key, data, putOptions = {}) {
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: full(key), Body: data, ...(putOptions.contentType === undefined ? {} : { ContentType: putOptions.contentType }) }));
    },
    async copy(sourceKey, key, copyOptions = {}) {
      const source = (copyOptions.from ?? store).locate(sourceKey);
      if (source.bucket !== config.bucket) throw new Error(`s3 store: cannot copy from bucket ${source.bucket} into ${config.bucket} on the server`);
      if (copyOptions.replace === true) {
        const copySource = `${source.bucket}/${source.key.split("/").map(encodeURIComponent).join("/")}`;
        try {
          await client.send(new CopyObjectCommand({ Bucket: config.bucket, Key: full(key), CopySource: copySource, MetadataDirective: "COPY", ...(copyOptions.ifMatch === undefined ? {} : { CopySourceIfMatch: `"${copyOptions.ifMatch}"` }) }));
        } catch (cause) {
          if (statusOf(cause) === 412 || nameOf(cause) === "PreconditionFailed") throw new PreconditionFailed(`${sourceKey} changed since it was listed`, { cause });
          if (statusOf(cause) === 404 || nameOf(cause) === "NoSuchKey") throw new ObjectMissing(`${sourceKey} does not exist`, { cause });
          throw cause;
        }
        return;
      }
      const ifMatch = copyOptions.ifMatch;
      if (ifMatch === undefined) {
        unwrap(`copy ${sourceKey}`, await bucketAdmin.copy(source.key, full(key)));
        return;
      }
      let copied = await bucketAdmin.copy(source.key, full(key), { ifMatch, sourceCheck });
      if (!copied.ok && sourceCheck === "header" && refusedMatchingCondition(copied.error.details, ifMatch)) {
        sourceCheck = "compare";
        copied = await bucketAdmin.copy(source.key, full(key), { ifMatch, sourceCheck });
      }
      unwrap(`copy ${sourceKey}`, copied);
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: full(key) }));
    },
    async serverTime(prefix, clock, poll = {}) {
      const probe = adminAt(full(prefix), { now: clock, observeAttempts: poll.attempts ?? 30, retryDelayMs: poll.delayMs ?? 1000, ...(poll.sleep === undefined ? {} : { sleep: poll.sleep }) });
      const measured = unwrap(`clock probe below ${prefix}`, await probe.serverTime());
      return { skewMs: measured.localMs - measured.serverMs, ...(measured.leftover === undefined ? {} : { leftover: prefix + measured.leftover }) };
    },
  };
  return store;
}
