import { randomUUID } from "node:crypto";
import { CopyObjectCommand, DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { customFailure, failure, type KestrelError } from "@michaelthielemann/kestrel/errors";
import { err, ok, type Result } from "@michaelthielemann/kestrel/result";
import { createClient, isTransient, type Config } from "./impl.ts";

/** The client surface the admin operations use; `S3Client` satisfies it, tests pass a fake. */
export interface S3AdminLike {
  send(command: ListObjectsV2Command | HeadObjectCommand | HeadBucketCommand | CopyObjectCommand | PutObjectCommand | DeleteObjectCommand): Promise<unknown>;
}

/** `TRANSIENT` after the SDK's own retries; `NOT_FOUND` for a missing source. Anything else (a denied request, a missing bucket) throws as a wiring bug. */
export type S3AdminError = KestrelError<"NOT_FOUND" | "TRANSIENT">;

/** One object as the store reports it. `lastModified` is epoch milliseconds from the server's clock, `null` when the store sends none. */
export interface ObjectInfo {
  key: string;
  size: number;
  /** The ETag without quotes. It is the content MD5 only for single-part objects stored without customer-supplied encryption keys. */
  etag: string;
  lastModified: number | null;
}

/**
 * Failures of `copy`: a stale or rewritten source (`PRECONDITION_FAILED`) and a destination that does not match
 * the source after the copy (`VERIFY_FAILED`).
 *
 * `PRECONDITION_FAILED` carries `details.expectedEtag`, `details.foundEtag` (`null` when the source is missing),
 * `details.reason` (`"store-refused"`, `"source-changed"` or `"source-missing"`) and `details.destinationWritten`.
 * When the destination was written and then found invalid, `details.destinationRemoved` says whether the
 * cleanup succeeded. `VERIFY_FAILED` carries the expected and actual size and ETag and `details.destinationRemoved`.
 *
 * A `TRANSIENT` that follows a written destination (the source or the destination could not be read back)
 * carries `details.destinationWritten: true` and `details.destinationRemoved`; the destination is unverified when
 * it was not removed. A `TRANSIENT` from the copy request itself carries no details, and the destination may exist.
 */
export type S3CopyError = KestrelError<"NOT_FOUND" | "TRANSIENT" | "PAYLOAD_TOO_LARGE" | "PRECONDITION_FAILED" | "VERIFY_FAILED">;

export interface CopyOptions {
  /**
   * The ETag the caller listed for the source. The copy is refused when the source no longer has it. A store that
   * enforces `x-amz-copy-source-if-match` writes nothing then. For a store that ignores the header, answers 501
   * or 400, or refuses the condition although the source is unchanged, the copy is made without the header, the
   * source is read again afterwards and a destination written from a changed source is removed.
   */
  ifMatch?: string;
  /**
   * How `ifMatch` is checked. `"header"` (default) lets the store check it and falls back to comparing when the
   * store cannot. `"compare"` never sends the header and only compares the source's ETag before and after the
   * copy; pass it when `probeCapabilities` did not report `copySourceIfMatch` as supported.
   */
  sourceCheck?: "header" | "compare";
}

export interface CopyResult {
  /** The destination's size, equal to the source's. */
  size: number;
  /** The ETag of the destination as the copy reported it and a later head confirmed. */
  etag: string;
}

export interface S3AdminOptions {
  /** Waits between attempts to observe a write; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
  /** Heads of a fresh destination before a copy counts as unverified. Default 5. */
  verifyAttempts?: number;
  /** Pause between those attempts in milliseconds. Default 200. */
  retryDelayMs?: number;
  /** Listings of a fresh probe object before `serverTime` gives up. Default 10. */
  observeAttempts?: number;
  /** The local clock in epoch milliseconds. */
  now?: () => number;
}

/** The store's clock against the local one. `skewMs` is positive when the store is ahead. */
export interface ServerClock {
  serverMs: number;
  localMs: number;
  skewMs: number;
}

/**
 * What one probe saw: `enforced` is a refusal of the stale condition with 412 and a success with a matching one,
 * `always-refused` a 412 for the matching condition too, `ignored` a success despite the stale condition,
 * `not-implemented` a 501.
 */
export type ProbeOutcome = "enforced" | "always-refused" | "ignored" | "not-implemented" | "error";

export interface CapabilityProbe {
  /** True only when the store was seen to refuse the stale condition and to accept the matching one; anything not proven counts as unsupported. */
  supported: boolean;
  outcome: ProbeOutcome;
  /** The error name for `outcome: "error"`. */
  detail?: string;
}

export interface Capabilities {
  /** `If-None-Match: *` on a write refuses to overwrite an existing key. */
  conditionalCreate: CapabilityProbe;
  /** `If-Match` on a write refuses a stale ETag. */
  conditionalOverwrite: CapabilityProbe;
  /** `x-amz-copy-source-if-match` on a copy refuses a stale source ETag. */
  copySourceIfMatch: CapabilityProbe;
}

export interface S3Admin {
  /**
   * Every object under `prefix` with size, ETag and server modification time, ordered by key. Keys are relative to
   * the configured `prefix`. A store that reports a truncated page without a continuation token, or the same token
   * twice, makes it throw instead of answering a partial list.
   */
  listDetailed(prefix: string): Promise<Result<ObjectInfo[], S3AdminError>>;
  /**
   * Metadata of one object, or `Ok(null)` when the key does not exist. `lastModified` has whole-second precision
   * here. A key that is missing is told apart from a missing bucket by one `HeadBucket` request on the first
   * miss; a bucket that does not exist throws.
   */
  head(key: string): Promise<Result<ObjectInfo | null, S3AdminError>>;
  /**
   * Copies one object inside the bucket on the server and checks the result: the destination must report the
   * source's size and the ETag the copy returned, read again while an overwritten destination still looks stale.
   * With `ifMatch` the copy is refused when the source changed, both by the store (`x-amz-copy-source-if-match`)
   * and, for stores that ignore, reject or always refuse that header (see `CopyOptions.sourceCheck`), by comparing
   * the source's ETag before and after the copy. A destination written from a source that changed, or that fails
   * verification, is removed again; an object that existed under `to` before is overwritten and removed too, so
   * copy to keys that are free. A source that changed and returned to its earlier content during the copy cannot
   * be told apart. Sources above 5 GiB are refused. Copying an object onto itself throws.
   */
  copy(from: string, to: string, options?: CopyOptions): Promise<Result<CopyResult, S3CopyError>>;
  /**
   * Reads the store's clock: writes a probe object, lists until it appears and returns its `LastModified`, which
   * listings report with at least whole-second precision (some stores report milliseconds), so `skewMs` is accurate
   * to about a second. The probe object is removed again; a denied delete throws.
   */
  serverTime(): Promise<Result<ServerClock, S3AdminError>>;
  /**
   * Tests which write conditions the store enforces, on scratch keys under the configured prefix that are removed
   * afterwards; a denied delete throws. A store that ignores a condition accepts the stale write, and a store that
   * refuses every conditional request also refuses the matching one, so a probe reports a capability as supported
   * only after it saw the stale condition refused and the matching one accepted.
   */
  probeCapabilities(): Promise<Result<Capabilities, S3AdminError>>;
  close(): void;
}

/** The largest object a single copy request moves. */
export const MAX_SINGLE_COPY_BYTES = 5 * 1024 ** 3;
const DEFAULT_VERIFY_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 200;
const DEFAULT_OBSERVE_ATTEMPTS = 10;
const CLOCK_PREFIX = ".kestrel-clock/";
const PROBE_PREFIX = ".kestrel-probe/";
const NEVER_MATCHING_ETAG = '"kestrel-probe-no-such-etag"';

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

type PreconditionReason = "store-refused" | "source-changed" | "source-missing";

function preconditionFailed(key: string, details: { expectedEtag: string; foundEtag: string | null; reason: PreconditionReason; destinationWritten: boolean; destinationRemoved?: boolean }): S3CopyError {
  return customFailure("PRECONDITION_FAILED", 412, `blobstore/s3 admin: ${JSON.stringify(key)} no longer has the expected ETag`, { details });
}

function errorName(cause: unknown): string {
  return boundaryCast<{ name?: string }>(cause, "host").name ?? "Error";
}

async function classify(stale: () => Promise<unknown>, matching: () => Promise<unknown>): Promise<Result<CapabilityProbe, S3AdminError>> {
  try {
    await stale();
    return ok({ supported: false, outcome: "ignored" });
  } catch (cause) {
    const status = statusOf(cause);
    if (status === 501) return ok({ supported: false, outcome: "not-implemented" });
    if (status !== 412) {
      if (isTransient(cause)) return err(describeFailure("capability probe", cause));
      return ok({ supported: false, outcome: "error", detail: errorName(cause) });
    }
  }
  try {
    await matching();
    return ok({ supported: true, outcome: "enforced" });
  } catch (cause) {
    if (statusOf(cause) === 412) return ok({ supported: false, outcome: "always-refused" });
    if (isTransient(cause)) return err(describeFailure("capability probe", cause));
    return ok({ supported: false, outcome: "error", detail: errorName(cause) });
  }
}

function isNotFound(cause: unknown): boolean {
  const info = boundaryCast<{ name?: string; $metadata?: { httpStatusCode?: number } }>(cause, "host");
  if (info.name === "NoSuchBucket") return false;
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
  const observeAttempts = options.observeAttempts ?? DEFAULT_OBSERVE_ATTEMPTS;
  const now = options.now ?? Date.now;

  const fullKey = (key: string): string => {
    if (key === "" || key.startsWith("/")) throw new Error(`blobstore/s3 admin: invalid key ${JSON.stringify(key)}`);
    return config.prefix + key;
  };
  const relativeKey = (key: string): string => key.slice(config.prefix.length);

  function listDetailed(prefix: string): Promise<Result<ObjectInfo[], S3AdminError>> {
    return guarded(`list ${JSON.stringify(prefix)}`, async () => {
      const out: ObjectInfo[] = [];
      const seenTokens = new Set<string>();
      let token: string | undefined;
      do {
        const page = boundaryCast<{ Contents?: ListedItem[]; IsTruncated?: boolean; NextContinuationToken?: string }>(
          await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.prefix + prefix, ContinuationToken: token })),
          "host",
        );
        for (const item of page.Contents ?? []) {
          if (item.Key === undefined) continue;
          out.push({ key: relativeKey(item.Key), size: item.Size ?? 0, etag: normalizeEtag(item.ETag ?? ""), lastModified: item.LastModified?.getTime() ?? null });
        }
        token = page.NextContinuationToken;
        if (token === undefined || token === "") {
          if (page.IsTruncated === true) throw new Error(`blobstore/s3 admin: the store reported a truncated listing of ${JSON.stringify(prefix)} without a continuation token`);
          token = undefined;
        } else if (seenTokens.has(token)) {
          throw new Error(`blobstore/s3 admin: the store repeated a continuation token while listing ${JSON.stringify(prefix)}`);
        } else {
          seenTokens.add(token);
        }
      } while (token !== undefined);
      return out.sort(compareKeys);
    });
  }

  async function remove(key: string): Promise<void> {
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: fullKey(key) }));
  }

  async function tryRemove(key: string): Promise<boolean> {
    try {
      await remove(key);
      return true;
    } catch {
      return false;
    }
  }

  async function withScratch<T, E extends KestrelError>(keys: readonly string[], body: () => Promise<Result<T, E>>): Promise<Result<T, E>> {
    let outcome: { value: Result<T, E> } | { failure: unknown };
    try {
      outcome = { value: await body() };
    } catch (cause) {
      outcome = { failure: cause };
    }
    let denied: { cause: unknown } | undefined;
    for (const key of keys) {
      try {
        await remove(key);
      } catch (cause) {
        if (!isTransient(cause) && !isNotFound(cause)) denied ??= { cause };
      }
    }
    if ("failure" in outcome) throw outcome.failure;
    if (denied !== undefined && outcome.value.ok) throw denied.cause;
    return outcome.value;
  }

  let bucketVerified = false;
  async function verifyBucket(): Promise<void> {
    if (bucketVerified) return;
    try {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      bucketVerified = true;
    } catch (cause) {
      if (statusOf(cause) === 404) throw new Error(`blobstore/s3 admin: bucket ${JSON.stringify(config.bucket)} does not exist`, { cause });
    }
  }

  function write(key: string, body: Uint8Array, conditions: { ifNoneMatch?: string; ifMatch?: string } = {}): Promise<unknown> {
    return client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: fullKey(key),
      Body: body,
      ...(conditions.ifNoneMatch === undefined ? {} : { IfNoneMatch: conditions.ifNoneMatch }),
      ...(conditions.ifMatch === undefined ? {} : { IfMatch: conditions.ifMatch }),
    }));
  }

  async function head(key: string): Promise<Result<ObjectInfo | null, S3AdminError>> {
    const target = fullKey(key);
    try {
      const out = boundaryCast<{ ContentLength?: number; ETag?: string; LastModified?: Date }>(await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: target })), "host");
      return ok({ key, size: out.ContentLength ?? 0, etag: normalizeEtag(out.ETag ?? ""), lastModified: out.LastModified?.getTime() ?? null });
    } catch (cause) {
      if (isNotFound(cause)) {
        await verifyBucket();
        return ok(null);
      }
      if (isTransient(cause)) return err(describeFailure(`head ${JSON.stringify(key)}`, cause));
      throw cause;
    }
  }

  async function serverTime(): Promise<Result<ServerClock, S3AdminError>> {
    const key = `${CLOCK_PREFIX}${randomUUID()}`;
    const before = now();
    const written = await guarded("clock probe write", () => write(key, new Uint8Array(0)));
    if (!written.ok) return written;
    const localMs = Math.round((before + now()) / 2);
    return withScratch([key], async () => {
      for (let attempt = 0; attempt < observeAttempts; attempt += 1) {
        if (attempt > 0) await sleep(retryDelayMs);
        const listed = await listDetailed(key);
        if (!listed.ok) return listed;
        const modified = listed.value.find((item) => item.key === key)?.lastModified;
        if (modified !== null && modified !== undefined) return ok({ serverMs: modified, localMs, skewMs: modified - localMs });
      }
      return err(failure("TRANSIENT", `blobstore/s3 admin: the clock probe object did not appear in ${observeAttempts} listings`));
    });
  }

  async function probeCapabilities(): Promise<Result<Capabilities, S3AdminError>> {
    const scratch = `${PROBE_PREFIX}${randomUUID()}/`;
    const original = `${scratch}original`;
    const copied = `${scratch}copy`;
    const fresh = `${scratch}fresh`;
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    const created = await guarded("capability probe write", () => write(original, bytes("one")));
    if (!created.ok) return created;
    const currentEtag = async (): Promise<string> => {
      const out = boundaryCast<{ ETag?: string }>(await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: fullKey(original) })), "host");
      return `"${normalizeEtag(out.ETag ?? "")}"`;
    };
    const copyFromOriginal = (condition: string): Promise<unknown> =>
      client.send(new CopyObjectCommand({ Bucket: config.bucket, Key: fullKey(copied), CopySource: `${config.bucket}/${fullKey(original).split("/").map(encodeURIComponent).join("/")}`, CopySourceIfMatch: condition }));
    return withScratch([original, copied, fresh], async () => {
      const conditionalCreate = await classify(
        () => write(original, bytes("two"), { ifNoneMatch: "*" }),
        () => write(fresh, bytes("one"), { ifNoneMatch: "*" }),
      );
      if (!conditionalCreate.ok) return conditionalCreate;
      const conditionalOverwrite = await classify(
        () => write(original, bytes("three"), { ifMatch: NEVER_MATCHING_ETAG }),
        async () => write(original, bytes("four"), { ifMatch: await currentEtag() }),
      );
      if (!conditionalOverwrite.ok) return conditionalOverwrite;
      const copySourceIfMatch = await classify(
        () => copyFromOriginal(NEVER_MATCHING_ETAG),
        async () => copyFromOriginal(await currentEtag()),
      );
      if (!copySourceIfMatch.ok) return copySourceIfMatch;
      return ok({ conditionalCreate: conditionalCreate.value, conditionalOverwrite: conditionalOverwrite.value, copySourceIfMatch: copySourceIfMatch.value });
    });
  }

  async function transientAfterWrite(error: S3AdminError, destination: string): Promise<S3CopyError> {
    const destinationRemoved = await tryRemove(destination);
    return { ...error, details: { destinationWritten: true, destinationRemoved } };
  }

  return {
    close() {
      if (client instanceof S3Client) client.destroy();
    },

    listDetailed,

    head,
    serverTime,
    probeCapabilities,

    async copy(from, to, copyOptions = {}) {
      if (fullKey(from) === fullKey(to)) throw new Error(`blobstore/s3 admin: cannot copy ${JSON.stringify(from)} onto itself`);
      const source = await head(from);
      if (!source.ok) return source;
      if (source.value === null) return err(failure("NOT_FOUND", `blobstore/s3 admin: ${JSON.stringify(from)} not found`));
      const expected = source.value;
      if (expected.size > MAX_SINGLE_COPY_BYTES) {
        return err(failure("PAYLOAD_TOO_LARGE", `blobstore/s3 admin: ${JSON.stringify(from)} is ${expected.size} bytes, above the ${MAX_SINGLE_COPY_BYTES} bytes one copy request moves`));
      }
      const ifMatch = copyOptions.ifMatch === undefined ? undefined : normalizeEtag(copyOptions.ifMatch);
      const refused = (reason: PreconditionReason, foundEtag: string | null, destinationWritten: boolean, destinationRemoved?: boolean): S3CopyError =>
        preconditionFailed(from, { expectedEtag: ifMatch ?? "", foundEtag, reason, destinationWritten, ...(destinationRemoved === undefined ? {} : { destinationRemoved }) });
      if (ifMatch !== undefined && expected.etag !== ifMatch) return err(refused("source-changed", expected.etag, false));

      const sourcePath = `${config.bucket}/${fullKey(from).split("/").map(encodeURIComponent).join("/")}`;
      const send = (conditionHeader: boolean): Promise<unknown> =>
        client.send(new CopyObjectCommand({
          Bucket: config.bucket,
          Key: fullKey(to),
          CopySource: sourcePath,
          MetadataDirective: "COPY",
          ...(conditionHeader && ifMatch !== undefined ? { CopySourceIfMatch: `"${ifMatch}"` } : {}),
        }));
      const checkedByStore = ifMatch !== undefined && copyOptions.sourceCheck !== "compare";
      const sendChecked = async (): Promise<{ response: unknown } | { refusal: S3CopyError | S3AdminError }> => {
        if (!checkedByStore) return { response: await send(false) };
        try {
          return { response: await send(true) };
        } catch (cause) {
          const status = statusOf(cause);
          if (status === 501 || status === 400) return { response: await send(false) };
          if (status !== 412) throw cause;
        }
        const current = await head(from);
        if (!current.ok) return { refusal: current.error };
        if (current.value !== null && current.value.etag === ifMatch) return { response: await send(false) };
        return { refusal: refused(current.value === null ? "source-missing" : "store-refused", current.value?.etag ?? null, false) };
      };
      let response: unknown;
      try {
        const sent = await sendChecked();
        if ("refusal" in sent) return err(sent.refusal);
        response = sent.response;
      } catch (cause) {
        if (statusOf(cause) === 412) return err(refused("store-refused", null, false));
        if (isNotFound(cause)) return err(failure("NOT_FOUND", `blobstore/s3 admin: ${JSON.stringify(from)} not found`, { cause }));
        if (isTransient(cause)) return err(describeFailure(`copy ${JSON.stringify(from)} to ${JSON.stringify(to)}`, cause));
        throw cause;
      }
      const copiedEtag = boundaryCast<{ CopyObjectResult?: { ETag?: string } }>(response, "host").CopyObjectResult?.ETag;
      const expectedEtag = copiedEtag === undefined ? null : normalizeEtag(copiedEtag);

      if (ifMatch !== undefined) {
        const after = await head(from);
        if (!after.ok) return err(await transientAfterWrite(after.error, to));
        if (after.value === null || after.value.etag !== ifMatch) {
          const removed = await tryRemove(to);
          return err(refused(after.value === null ? "source-missing" : "source-changed", after.value?.etag ?? null, true, removed));
        }
      }

      let actual: ObjectInfo | null = null;
      for (let attempt = 0; attempt < verifyAttempts; attempt += 1) {
        if (attempt > 0) await sleep(retryDelayMs);
        const destination = await head(to);
        if (!destination.ok) return err(await transientAfterWrite(destination.error, to));
        actual = destination.value;
        if (actual !== null && actual.size === expected.size && (expectedEtag === null || actual.etag === expectedEtag)) break;
      }
      if (actual === null || actual.size !== expected.size || (expectedEtag !== null && actual.etag !== expectedEtag)) {
        const removed = await tryRemove(to);
        return err(customFailure("VERIFY_FAILED", 502, `blobstore/s3 admin: ${JSON.stringify(to)} does not match ${JSON.stringify(from)} after the copy`, {
          details: { expectedSize: expected.size, actualSize: actual?.size ?? null, expectedEtag, actualEtag: actual?.etag ?? null, destinationRemoved: removed },
        }));
      }
      return ok({ size: actual.size, etag: actual.etag });
    },
  };
}
