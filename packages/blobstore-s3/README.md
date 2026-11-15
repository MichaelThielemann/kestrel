# blobstore/s3
`blobstore@1` on Amazon S3 or any S3-compatible store (MinIO, Cloud Foundry object storage)
via `@aws-sdk/client-s3`. Config: `bucket`, optional `prefix` (a key prefix for everything this store
holds, such as `"kestrel/"`), `region`, `endpoint`, `allowInsecureEndpoint`, `forcePathStyle`, `accessKeyId`/`secretAccessKey` (omit to use the SDK's default credential chain:
environment, profile, instance role), `timeoutMs` (default 10000: how long a connection may take to
open and how long a socket may stay idle, nothing sent and nothing received, before the attempt fails) and
`maxAttempts` (default 3, the SDK's retry limit including the first try). A store that accepts the connection
and never answers fails the attempt after about `timeoutMs`, and the call answers `TRANSIENT` once the attempts
are spent, so a silent socket does not hang a pipeline step. A transfer that keeps moving has no overall limit:
a large upload, such as a database snapshot, may take longer than `timeoutMs` as long as data flows. `put` stores the `contentType` hint as the object's
`Content-Type`, so a public copy served straight from the bucket answers with the right type (serve
only the public tree, `site/*`, see the key table in `media-default`'s README; the rest of the bucket
holds originals, database replicas and backups); `get` returns bytes only
and `list` reports key and size. The store never wrote sidecar files. `put` computes the SHA-256 of the
body that signs the request itself, in slices of 1 MiB with the event loop running between them, so an
upload of a large object, such as a database snapshot, does not hold the event loop for the whole hash.

`requestChecksumCalculation` (`WHEN_SUPPORTED` or `WHEN_REQUIRED`) passes through to the SDK. Recent SDK
versions add a CRC32 trailer to every upload; a store that does not understand it fails the request or
ignores the trailer without verifying it. `WHEN_REQUIRED` sends a checksum only where the operation needs
one. Unset keeps the SDK default.

`endpoint` must be `https://`, or plain `http://` on a loopback address (`localhost`, `127.0.0.0/8`,
`[::1]`), for example a MinIO next to the app. Any other plain `http://` endpoint is a config error at
boot, since the access keys' signatures, every stored object and every replica snapshot would cross
the network unencrypted; `allowInsecureEndpoint: true` accepts it for a network you trust, and the
module then logs a warning at every boot.

`move` copies through `CopyObject`, whose `CopySource` is a path: the segments are percent-encoded,
the slashes separating them are not.

`pnpm test:s3` runs the `blobstore@1` contract test and the admin client against a real MinIO instance in
Podman (starts it, creates the bucket, runs every `packages/*/minio.test.ts`, always stops the container).
Only a real S3-compatible target exercises the `CopySource` encoding, the `NoSuchKey`/404 detection on
`CopyObject` and the 412 answers of a conditional copy, which a fake says nothing about. `@aws-sdk/client-s3` is a dependency of this package
alone and not of the workspace root, so the script resolves it from here.

## Admin client (`./admin`)
`createS3Admin(config)` takes the same `Config` as the module and offers what `blobstore@1` leaves out. Keys
are relative to `config.prefix`; with an empty prefix the client addresses the whole bucket. Every method
returns a `Result`: `TRANSIENT` once the SDK's retries are spent, while a denied request or a missing
bucket throws.

```ts
import { createS3Admin } from "@michaelthielemann/kestrel-blobstore-s3/admin";

const admin = createS3Admin({ bucket: "assets", prefix: "" });
const listed = await admin.listDetailed("media/"); // key, size, etag, lastModified (ms)
if (!listed.ok) throw listed.error;
const first = listed.value[0];
if (first !== undefined) {
  const copied = await admin.copy(first.key, `backup/${first.key}`, { ifMatch: first.etag });
}
```

- `listDetailed(prefix)` lists every object with `key`, `size`, `etag` (without quotes) and `lastModified`
  in epoch milliseconds, ordered by key. `head(key)` reports the same for one key and `Ok(null)` for a
  missing one; a `HEAD` reports whole seconds, and listings report at least whole seconds (some stores add
  milliseconds). A `HEAD` cannot tell a missing key from a missing bucket, so the first miss runs one
  `HeadBucket`; a bucket that does not exist throws. A store that reports a truncated listing page without a
  continuation token, or repeats a token, makes `listDetailed` throw instead of answering a partial list.
- `copy(from, to, { ifMatch?, sourceCheck? })` copies on the server. It then reads the destination until it
  reports the source's size and the ETag the copy returned, since an overwritten key can still answer with its
  old metadata for a moment, and answers `VERIFY_FAILED` with the expected and actual size and ETag if it never
  does. With `ifMatch` (the ETag from a listing) it answers `PRECONDITION_FAILED` when the source changed.
  By default the store's own `x-amz-copy-source-if-match` does the check where it works and writes nothing
  then (`details.reason: "store-refused"`, with the ETag a later read found in `details.foundEtag`); the
  store's 412 is final even when that read still shows the expected ETag. When a store answers 501 or 400 to
  the header, the client copies without it, compares the source's ETag after the copy and removes a
  destination written from a changed source (`details.reason: "source-changed"` or `"source-missing"`,
  `details.destinationRemoved`). `sourceCheck: "compare"` skips the header and always compares; use it when
  `probeCapabilities` did not report `copySourceIfMatch` as supported, which includes a store that refuses
  every conditional request (`always-refused`). Where the expected ETag, the source's and the copy's are plain
  content hashes (32 hex digits, no server-side encryption other than SSE-S3), the ETag the copy reports is
  compared with the expected one too, so a source overwritten while reads of it still look stale is caught;
  other ETags are only compared by reading the source. A destination that fails verification
  is removed too, and an object that already existed under `to` is overwritten and removed with it, so copy to
  keys that are free. Copying an object onto itself throws. A source that changes and returns to identical
  content during the copy cannot be detected. A source above 5 GiB answers `PAYLOAD_TOO_LARGE`, since one copy
  request does not move more. A `TRANSIENT` after the destination was written (the source or the destination
  could not be read back) removes the destination and reports `details.destinationWritten: true` and
  `details.destinationRemoved`; when the removal failed too, the destination is unverified. A `TRANSIENT` from
  the copy request itself carries no details, and the destination may exist.
- `serverTime()` returns `{ serverMs, localMs, skewMs, leftover? }`. It writes a probe object under `.kestrel-clock/`,
  lists until the object shows, reads its `LastModified` and removes it. Listings can lag behind a write, which
  is why it lists again, up to `observeAttempts` times. `skewMs` is accurate to about a second, because a
  store may report `LastModified` in whole seconds.
- `probeCapabilities()` finds out which write conditions the store enforces: `conditionalCreate`
  (`If-None-Match: *`), `conditionalOverwrite` (`If-Match`) and `copySourceIfMatch`. Each probe sends a
  condition that cannot hold and, after a 412, the matching condition, on scratch keys under
  `.kestrel-probe/`. `supported` is `true` only for `outcome: "enforced"`: the stale condition was refused
  and the matching one accepted. It is `false` for `"always-refused"` (the matching condition got a 412 too),
  `"ignored"` (the store accepted the stale write), `"not-implemented"` (501) and `"error"` (`detail` names
  it). A capability nobody observed is not assumed.
- `serverTime()` and `probeCapabilities()` remove their scratch objects, also after a write that failed, and
  need the `DeleteObject` permission for that. When `serverTime()` measured the clock but could not remove its
  probe, denied or after a transient failure, it still answers the clock and names the probe that stays in
  `leftover` (relative to the prefix). A denied delete in `probeCapabilities()` throws when the probe itself
  succeeded. When a probe failed, its own error is returned and the scratch object may stay. A transient failure
  to delete a capability probe, and a 404 for a scratch key that was never written, are ignored.

`createS3Admin(config, client, options)` accepts a client for tests and `S3AdminOptions`: `verifyAttempts`,
`retryDelayMs`, `observeAttempts`, `sleep` and `now`.

## Errors

Every method returns a `Result<T, BlobstoreError>`. `move` answers `NOT_FOUND` when the source key
is missing. Once the SDK's own `maxAttempts` are spent, `put`/`get`/`remove`/`move`/`list` answer
`TRANSIENT` for `$metadata.httpStatusCode` ≥ 500 or 429, `$retryable`, an error `name` of
`TimeoutError`/`NetworkingError`/`AbortError`, or a Node `code` of
`ECONNRESET`/`ECONNREFUSED`/`ETIMEDOUT`/`EPIPE`/`EAI_AGAIN`. Everything else (an invalid key,
`AccessDenied`, a misconfigured bucket) throws — it is a wiring bug, not an expected failure.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-blobstore-s3` – module `blobstore/s3`: provides `blobstore@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `bucket` | string | yes | – |
| `prefix` | string | no | `""` |
| `region` | string | no | – |
| `endpoint` | string | no | – |
| `allowInsecureEndpoint` | boolean | no | `false` |
| `forcePathStyle` | boolean | no | – |
| `accessKeyId` | string | no | *(secret)* |
| `secretAccessKey` | string | no | *(secret)* |
| `timeoutMs` | integer | no | `10000` |
| `maxAttempts` | integer | no | `3` |
| `requestChecksumCalculation` | enum | no | – |

<!-- kestrel-docs:end -->
