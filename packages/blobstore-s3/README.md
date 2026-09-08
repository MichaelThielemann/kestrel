# blobstore/s3
`blobstore@1` on Amazon S3 or any S3-compatible store (MinIO, Cloud Foundry object storage)
via `@aws-sdk/client-s3`. Config: `bucket`, optional `prefix` (`"site/"`), `region`, `endpoint`,
`forcePathStyle`, `accessKeyId`/`secretAccessKey` (omit to use the SDK's default credential chain:
environment, profile, instance role), `timeoutMs` (default 10000, used for both the connection and
the request timeout, so a silent socket never hangs a pipeline step) and `maxAttempts` (default 3,
the SDK's retry limit including the first try). `put` stores the `contentType` hint as the object's
`Content-Type`, so a bucket served directly answers with the right type; `get` returns bytes only
and `list` reports key and size. The store never wrote sidecar files.

`pnpm test:s3` runs the `blobstore@1` contract test against a real MinIO instance in Podman
(starts it, creates the bucket, runs `minio.test.ts`, always stops the container).

## Errors

Every method returns a `Result<T, BlobstoreError>`. `move` answers `NOT_FOUND` when the source key
is missing. Once the SDK's own `maxAttempts` are spent, `put`/`get`/`remove`/`move`/`list` answer
`TRANSIENT` for `$metadata.httpStatusCode` ≥ 500 or 429, `$retryable`, an error `name` of
`TimeoutError`/`NetworkingError`/`AbortError`, or a Node `code` of
`ECONNRESET`/`ECONNREFUSED`/`ETIMEDOUT`/`EPIPE`/`EAI_AGAIN`. Everything else (an invalid key,
`AccessDenied`, a misconfigured bucket) throws — it is a wiring bug, not an expected failure.
