# blobstore/s3
`blobstore@1` on Amazon S3 or any S3-compatible store (MinIO, Cloud Foundry object storage)
via `@aws-sdk/client-s3`. Config: `bucket`, optional `prefix` (`"site/"`), `region`, `endpoint`,
`forcePathStyle`, `accessKeyId`/`secretAccessKey` (omit to use the SDK's default credential chain:
environment, profile, instance role), `timeoutMs` (default 10000, used for both the connection and
the request timeout, so a silent socket never hangs a pipeline step) and `maxAttempts` (default 3,
the SDK's retry limit including the first try). `put` stores the `contentType` hint as the object's
`Content-Type`, so a bucket served directly answers with the right type; `get` returns bytes only
and `list` reports key and size. The store never wrote sidecar files.

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
| `forcePathStyle` | boolean | no | – |
| `accessKeyId` | string | no | *(secret)* |
| `secretAccessKey` | string | no | *(secret)* |
| `timeoutMs` | integer | no | `10000` |
| `maxAttempts` | integer | no | `3` |

<!-- kestrel-docs:end -->
