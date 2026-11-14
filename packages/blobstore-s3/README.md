# blobstore/s3
`blobstore@1` on Amazon S3 or any S3-compatible store (MinIO, Cloud Foundry object storage)
via `@aws-sdk/client-s3`. Config: `bucket`, optional `prefix` (a key prefix for everything this store
holds, such as `"kestrel/"`), `region`, `endpoint`, `allowInsecureEndpoint`, `forcePathStyle`, `accessKeyId`/`secretAccessKey` (omit to use the SDK's default credential chain:
environment, profile, instance role), `timeoutMs` (default 10000, used for both the connection and
the request timeout, so a silent socket never hangs a pipeline step) and `maxAttempts` (default 3,
the SDK's retry limit including the first try). `put` stores the `contentType` hint as the object's
`Content-Type`, so a public copy served straight from the bucket answers with the right type (serve
only the public tree, `site/*`, see the key table in `media-default`'s README; the rest of the bucket
holds originals, database replicas and backups); `get` returns bytes only
and `list` reports key and size. The store never wrote sidecar files.

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

`pnpm test:s3` runs the `blobstore@1` contract test against a real MinIO instance in Podman
(starts it, creates the bucket, runs `minio.test.ts`, always stops the container). Only a real
S3-compatible target exercises the `CopySource` encoding and the `NoSuchKey`/404 detection on
`CopyObject`, which a fake says nothing about. `@aws-sdk/client-s3` is a dependency of this package
alone and not of the workspace root, so the script resolves it from here.

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
