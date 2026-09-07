# Changelog

## Unreleased

- `core`: `http.allow` — a list of IPv4/IPv6 addresses or CIDR ranges the standalone HTTP server
  answers at all; every other client gets `403 forbidden` before routing (health and CORS preflight
  included). Empty or absent keeps the server open; the peer address is the socket's, or the first
  `X-Forwarded-For` entry with `http.trustProxy`; IPv4-mapped IPv6 peers are checked as IPv4. An
  entry that is neither an address nor a CIDR range is a boot error naming the entry.
## 5.0.1 – 2026-09-07

- `validate-jsonschema`: a `schemas` entry may be the JSON Schema object itself instead of a file
  path, so a bundled build needs no schema files on disk. Inline schemas compile, sanitize and
  report exactly like file schemas; `watch` applies to files only.

## 5.0.0 – 2026-09-07

5.0.0 is a rewrite that replaces the 4.x line of `@michaelthielemann/kestrel` with
a new package set (`@michaelthielemann/kestrel*`, one version for all). There is no upgrade path
from 4.x; the model, config and API are new.

- `persistence@1`: a schema field may be declared as `{ type, unique: true }` (plain field types
  stay valid). `persistence-sqlite` backs it with a `UNIQUE INDEX` per field, so two concurrent
  writes with the same value can no longer both succeed; the second answers `CONFLICT` with
  `details: { collection, field }` (`createOne`, `createMany`, `updateOne`, `updateMany`).
  `ensureCollection` throws when existing rows already share a value, naming collection, field,
  value and count. `fakePersistence` mirrors both. `content-default` declares every `unique` model
  field per locale column and reports the constraint as the same field validation error as its
  pre-check; `authn-multi` declares `username` unique.
- **breaking** `core`: expected failures are values. New `@michaelthielemann/kestrel/result` exports
  `Result<T, E>` (`Ok`/`Err`) with `ok`, `err`, `isOk`, `isErr`, `match`, `unwrapOr`. A step is now
  `(ctx: Context) => Promise<Result<Context, KestrelError>>`: success is `return ok(ctx)` or
  `return ok({ ...ctx, result })`, failure is `return ctx.fail(...)`. A `throw` from a step is a bug
  and becomes a 500 `INTERNAL` as before.
- **breaking** `core`: one error model in `@michaelthielemann/kestrel/errors`.
  `KestrelError { code, status, message, retryable, details?, cause? }`, the core code list
  (`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `FORBIDDEN`, `UNAUTHENTICATED`, `RATE_LIMITED`,
  `DANGLING_REF`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED`, `TRANSIENT`, `INTERNAL`), the single
  code → status table `STATUS_OF`, and the builders `failure(code, message, options?)` /
  `customFailure(code, status, message, options?)` (for codes a contract declares itself) plus the
  guard `isKestrelError`. `TRANSIENT` and `RATE_LIMITED` are the retryable codes.
- **breaking** `core`: `ctx.fail(status, message, details?)` becomes
  `ctx.fail(code, message, details?)` — the status comes from `STATUS_OF`, there is no status
  parameter. `ctx.fail(error)` passes a contract's `KestrelError` through unchanged
  (`if (isErr(r)) return ctx.fail(r.error)`). Both return an `Err` instead of throwing; `ctx.done`
  returns an `Ok` instead of throwing.
- **breaking** `core`: `PipelineFailure` and `PipelineDone` are removed. Nothing carries a failure
  as an exception any more, so the runner's only `catch` is the bug handler. A step returning
  anything but a `Result<Context>` is a 500 `INTERNAL` naming the step.
- **breaking** `core`: `RunResult` and the HTTP error body gain `code` and `retryable`; a failure
  reports `{ status, error, code, retryable, step, details? }`. A `KestrelError.cause` is logged,
  never serialized into the response. `StepLog.outcome` changes from `fail(<status>)` to
  `fail(<code>)`.
- **breaking** `core`: the HTTP error body is now `{ error, code, retryable, runId, step?, details? }`
  — `code` and `retryable` are always present. `buildResponse` sets a `Retry-After` header on a
  retryable 429 or 503, from `details.retryAfterSeconds` when it is a positive integer, else `1`.
  `errorResponse(status, error, requestId?)` (edge errors raised before a pipeline runs: unknown
  route, oversized or unparsable body) now assigns a fixed `code` by status
  (400 → `VALIDATION`, 404 → `NOT_FOUND`, 413 → `PAYLOAD_TOO_LARGE`, 500 → `INTERNAL`) and
  `retryable: false`.
- **breaking** `openapi`: the generated `Error` schema gains `code: { type: "string" }` and
  `retryable: { type: "boolean" }`, and `required` becomes `["error", "code", "retryable", "runId"]`
  to match the runtime error body. Every operation now defaults a `503` response alongside the
  existing `500` (any step can fail with `TRANSIENT`), and a `429` or `503` response documents a
  `Retry-After` header. `examples/minimal/openapi.json` is regenerated: it now documents the per-code statuses
  declared by the modules (`409` on `POST /pages` and `POST /users`, `413`/`415` on
  `POST /media`).
- **breaking** `core`: `describe()` is mandatory for every module that registers steps.
  `defineModule` requires a `describe` next to `steps` and `StepDescriptions<T>` demands an entry
  for every step key (a description function for a `stepFactory`, a plain object otherwise);
  `StepRegistry.register` refuses a step without a description, and `ResolvedStep.description` is
  no longer optional.
- **breaking** `core`: `StepDescription.summary` is required and every step declares
  `reads: ContextPath[]` and `writes: ContextPath[]` (either may be `[]`). A path is a context key
  optionally followed by dotted sub-keys (`^[a-zA-Z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)*\??$`); the
  trailing `?` marks a conditional write and is rejected in `reads`. `register` validates the
  grammar and names module and step in the `KestrelBootError`.
- **breaking** `core`: `boot()` checks the dataflow of every pipeline. Starting from the context keys
  a trigger fills (`payload`, `headers`, `files`, `ip`, `params`, plus the route params every http
  trigger of that pipeline binds), each step's `reads` must be covered by an earlier step's `writes`;
  an optional write (`identity?`) never satisfies a read, a write of `result` covers `result.<key>`
  and vice versa, and a plain `result` write replaces earlier `result.<key>` writes. A `params.<name>`
  read is rejected in a cron-only pipeline and in one whose http routes do not bind that param, and
  accepted under an event trigger (the envelope's params are opaque). `payload.*` reads are never
  checked. A violation is a `KestrelBootError` naming the pipeline, the step, the path and the earlier
  writes. New export `checkDataflow` from `@michaelthielemann/kestrel/dataflow`.
- **breaking** `contracts`: every async contract method returns `Promise<Result<T, E>>` instead of
  resolving with the value or rejecting. Absence stays inside the `Ok` (`Result<T | null, E>`);
  `throw` is reserved for wiring bugs (unknown collection/field/type/format, invalid key,
  `create` on a single type, `set` on a multi type, `id` in a persistence schema). Sync methods
  (`model`, `validate`, `pathOf`, `formats`, `targets`, `check`, `on`) are unchanged, and
  `validate@1` and `events@1` are unchanged as a whole.
- **breaking** `contracts`: each contract declares its error union — `PersistenceError`
  (`CONFLICT | NOT_FOUND | TRANSIENT`), `BlobstoreError` (`NOT_FOUND | TRANSIENT`), `ContentError`
  (`VALIDATION | NOT_FOUND | CONFLICT | TRANSIENT`), `AuthnError` / `AuthzError` / `SiteError`
  (`TRANSIENT`), `RendererError` (`TRANSIENT | RENDER_FAILED`), `MigrationsError`
  (`CONFLICT | TRANSIENT | MIGRATION_FAILED`). The two contract-specific codes come with the
  factories `renderFailed(message, cause?)` and
  `migrationFailed(message, { migration, document, locale?, problems? })`, both status 500; an
  implementation may return fewer codes than its union, never more. New
  `@michaelthielemann/kestrel-contracts/errors` re-exports `KestrelError`, `CoreCode`, `failure`,
  `customFailure`, `Result`, `ok`, `err`, `isErr` so a contract file needs one import path.
- **breaking** `contracts`: status changes carried by the new codes — a duplicate persistence id is
  `CONFLICT` (409) instead of a thrown 500, `updateOne` on a missing id is `NOT_FOUND` (404)
  instead of a throw, `blobstore.move` from a missing key is `NOT_FOUND`, and `content.get` /
  `content.list` with an unknown locale is `VALIDATION` (400) instead of a thrown 500.
- **breaking** `contracts`: the contract test suites assert failures as `Err` values. New
  `@michaelthielemann/kestrel-contracts/testing/result` exports `expectOk(result)` and
  `expectErr(result, code)`; `rejects.toThrow` is left only for the wiring bugs listed above.
  `createFakePersistence()` returns `Result`s and gains `failNext("TRANSIENT" | "CONFLICT")`, which
  makes the next call answer `Err` without touching the store, so a module test can pin that a step
  propagates a transient contract failure.
- **breaking** `persistence/sqlite`: the ten `persistence@1` methods return a `Result`. A single
  `run()` helper wraps every `node:sqlite` call: `SQLITE_BUSY`/`SQLITE_LOCKED` after the
  `busy_timeout` (primary result code 5 or 6, masked out of the extended `errcode`) becomes
  `Err(TRANSIENT)` — 503, retryable, `details.retryAfterSeconds: 1` — instead of a thrown 500, and
  `UNIQUE constraint failed` becomes `Err(CONFLICT)` (409), so `createOne` with an id that already
  exists reports a conflict instead of a generic `Error`. `updateOne` on a missing id is
  `Err(NOT_FOUND)` (404) instead of a throw, `deleteOne` on one stays `Ok`. Everything else — unknown
  collection, unknown field, `id` in a schema, a non-string for a string column — still throws.
  `createMany` keeps `BEGIN`/`COMMIT`/`ROLLBACK` around the loop and returns the first `Err`.
  Pragmas and `busyTimeoutMs` are unchanged.
- **breaking** `persistence/sqlite`: the seven steps return `Result` and carry a `describe()` entry
  with `summary`, `reads` and `writes`. `persistence.updateOne:<c>` and `persistence.deleteOne:<c>`
  answer `VALIDATION` for a missing `params.id`, `persistence.findOne:<c>` answers `NOT_FOUND`, and
  every step passes a contract failure through unchanged, so a locked database is a retryable 503.
  `persistence.checkpoint` and `persistence.snapshot:<file>` map a busy database to `TRANSIENT`
  too; the three maintenance calls on the module instance (`checkpoint`, `snapshot`, `close`) keep
  their synchronous, non-contract shape.
- **breaking** `blobstore-filesystem`: `put`/`get`/`remove`/`move`/`list` return `Result` per
  `blobstore@1`. `EBUSY`, `EAGAIN`, `EMFILE` and `ENFILE` from the underlying filesystem call become
  `Err(TRANSIENT)` instead of a thrown error; `ENOENT` on `get`/`remove` stays inside the `Ok`
  (`null` / `void`), and on `move` (source missing) is `Err(NOT_FOUND)`. Any other filesystem error,
  and an invalid or root-escaping key, still throws — those are bugs, not expected failures.
- **breaking** `blobstore-s3`: implements `blobstore@1`'s `Result` signatures. `move` from a missing
  source is `Err(NOT_FOUND)` instead of a throw. Once the SDK's own `maxAttempts` are spent,
  `put`/`get`/`remove`/`move`/`list` answer `Err(TRANSIENT)` for `$metadata.httpStatusCode` ≥ 500 or
  429, `$retryable`, an error `name` of `TimeoutError`/`NetworkingError`/`AbortError`, or a Node
  `code` of `ECONNRESET`/`ECONNREFUSED`/`ETIMEDOUT`/`EPIPE`/`EAI_AGAIN`; everything else (an invalid
  key, `AccessDenied`, a misconfigured bucket) still throws.
- **breaking** `renderer-plain`: `render` now returns `Result<RenderOutput, RendererError>` per the `renderer@1`
  contract; the module never returns `Err`, an unknown format still throws (wiring).
- **breaking** `validate-jsonschema`: `validate.check:<type>.<field>` returns `ctx.fail("VALIDATION",
  message, details)` instead of `ctx.fail(400, message)`; `details.problems` carries the same
  `{ path, message }[]` the error message text is built from, and each problem at the field's root
  (`path: "/"`) is duplicated into `details.fields` as `{ field, message }` so a client can map it
  like a `content@1` field error. `validate.sanitize`/`validate.sanitizeHtml`/`validate.check`
  declare `reads`/`writes` in `describe()`. `validate@1` itself is unchanged (still sync).
- **breaking** `events-inmemory`: the `events.emit` step returns `ok(ctx)` and gets a `describe()` entry. A failing
  handler pipeline run is logged with its `code` and `retryable` alongside the existing `status` and
  `error`.
- **breaking** `content/default`: the nine `content@1` methods return a `Result`. The three error
  classes exported from `./impl` — `ContentValidationError`, `ContentQueryError` and
  `ContentTranslationError` — are deleted. A field-level failure is `Err(VALIDATION)` carrying the
  unchanged message text (`pages: slug must be unique, "home" exists`) and
  `details.fields: FieldError[]`; an unknown `locale` option on `get`/`list`/`create`/`set`/`update`
  is `Err(VALIDATION)` (400) instead of a thrown 500 and an unknown `sort` field is `Err(VALIDATION)`
  too; `update` of a missing id and `removeTranslation` of a missing document or translation are
  `Err(NOT_FOUND)`, removing the last translation is `Err(CONFLICT)` (409, as before), and a
  persistence id collision on `create` is `Err(CONFLICT)`. Wiring bugs still throw: unknown type,
  `get` of a multi type without an id, `create` on a single type, `set` on a multi type, a filter on
  an unknown field, and a model the type check rejects; a failing `ensureCollection` during setup is
  a boot error.
- **breaking** `content/default`: the eight steps return `Result` and every one has a `describe()`
  entry with `summary`, `reads` and `writes` — `content.get:<t>` reads `params.id` only for a multi
  type, `content.update:<t>`, `content.remove:<t>` and `content.removeTranslation:<t>` read
  `params.id`, and every step but `content.validate:<t>` writes `result`. `ctx.fail(400, …)` becomes
  `ctx.fail("VALIDATION", …)` and the contract's failures are passed through unchanged, so a busy
  database is a retryable 503 on every step. `content.update:<t>` no longer pre-reads the document
  with `content.get` (the contract answers `NOT_FOUND` itself), which saves one read per update.
- **breaking** `authn-single`: `login`/`resolve`/`logout` implement `authn@1`'s `Result` signatures
  (never `Err` in practice — the module holds sessions in memory only, but the type matches the
  contract). `authn.login` and `authn.requireUser` answer `ctx.fail("UNAUTHENTICATED", ...)` (401)
  instead of `ctx.fail(401, ...)`. `authn.loadIdentity` and `authn.logout` declare
  `reads: ["identity"]` / `reads: ["token"]`, so boot's dataflow check requires a pipeline to run
  `authn.requireUser` first, and they keep answering `ctx.fail("UNAUTHENTICATED", ...)` (401) when
  identity or token is missing anyway — the same behaviour as `authn/multi`. Every step gets a
  `describe()` entry with `reads`/`writes`.
- **breaking** `authn/multi`: `login`/`resolve`/`logout` return `Result` per `authn@1` (wrong
  credentials are `Ok(null)`, never an `Err`); a `CONFLICT` from a random session-token collision on
  `login` is a bug and is rethrown as an `Error` instead of surfacing to the caller.
  `createUser`/`listUsers`/`getUser`/`setPassword`/`changePassword`/`setActive`/`cleanupSessions`
  also return `Result` and gain `VALIDATION`/`CONFLICT`/`NOT_FOUND`/`TRANSIENT`; `AuthnRejected` and
  `AuthnNotFound` are deleted. A duplicate username is `Err(CONFLICT)` (409) instead of a 400 — a
  breaking status change. `ensureCollection`/bootstrap failures during `setup()` are boot errors.
- **breaking** `authn/multi`: the thirteen steps return `Result` and every one has a `describe()`
  entry with `summary`, `reads` and `writes`; the `rejecting(ctx, status, fn)` helper is deleted, so
  every failure code is now decided in `impl.ts` instead of being flattened to one status per step.
  `authn.getUser`/`setPassword`/`deactivateUser`/`activateUser` read `params.id` — boot's dataflow
  check now proves every route binds it, so the old defensive "missing id" branch is a thrown bug
  path in those four steps instead of a response code (`authn.deactivateUser` keeps its own
  "cannot deactivate yourself" as `VALIDATION`). `authn.setPassword` no longer double-reports a
  missing password as part of a combined "id and password" message. Every contract-backed step
  passes a `TRANSIENT` persistence failure through unchanged, so a busy database is a retryable 503.
- **breaking** `authz-roles`: `can` implements `authz@1`'s `Result<boolean, AuthzError>` signature
  (always `Ok` — the module is config-only). `authz.require:<permission>` answers
  `ctx.fail("UNAUTHENTICATED", ...)` (401, no identity and `canAnonymous` denies it) or
  `ctx.fail("FORBIDDEN", ...)` (403, identity lacks the permission) instead of bare-status
  `ctx.fail`; `describe()` gains `reads: []`/`writes: []` (the peek at `identity` is optional
  consumption, not a declared read).
- **breaking** `ratelimit-memory`: `ratelimit.check:<bucket>` fails `Err(RATE_LIMITED)` (429) instead
  of `ctx.fail(429, …)`; `details.retryAfterSeconds` feeds the `Retry-After` header. `ratelimit.sweep`
  returns `ok({ ...ctx, result })`. Both steps get a `describe()` `reads`/`writes` entry.
- **breaking** `sanitize-svg`: `sanitize.svg` fails `Err(PAYLOAD_TOO_LARGE)` (413, was 400) for an
  oversize file and `Err(VALIDATION)` (400) for malformed markup instead of a bare `ctx.fail(400,
  …)`; on success it returns `ok({ ...ctx, files })`. `describe()` gains `reads: ["files"]` /
  `writes: ["files"]` and an `errors` map keyed by the new statuses.
- **breaking** `audit-persistence`: `Audit.record` returns `Result<void, PersistenceError>` instead
  of resolving silently; the `audit.record` step passes a persistence failure through
  (`ctx.fail(r.error)`), so a locked database now answers a retryable 503 instead of throwing
  through the pipeline as an unhandled rejection. New mandatory `describe()` entry
  (`reads: ["payload"]`, `writes: []`) — the module previously had none.
- **breaking** `site/default`: `resolve` and `resolveLinks` implement `site@1`'s `Result` signatures
  (`SiteError = KestrelError<"TRANSIENT">`); `resolve` answers `Ok(null)` for an unresolvable path
  (unchanged), and both propagate a `content@1` `TRANSIENT` failure — any other `content@1` code
  reaching them would be a bug and throws instead. `pathOf` stays synchronous. The two steps declare
  `describe().reads`/`writes` (`site.resolve:<t>` reads `params.path`, `site.resolveLinks:<t>` reads
  and writes `result`) and `site.resolve:<t>` answers `ctx.fail("NOT_FOUND", …)` instead of the old
  `ctx.fail(404, …)`; `site.resolveLinks:<t>` no longer tolerates a missing `result` (the dataflow
  check now guarantees an earlier step wrote it) and throws if one reaches it anyway.
- **breaking** `media/default`: every asynchronous method of the `Media` instance exported from
  `./impl` returns a `Result`, and the helpers `parseProvenance`, `safeFolder` and `checkPlainText`
  (renamed from `assertPlainText`) do the same. The error classes `MediaRejected` and `MediaConflict`
  are deleted: an invalid folder, provenance, locale or text is `Err(VALIDATION)`, a disallowed
  content type `Err(UNSUPPORTED)`, a file over `maxBytes` `Err(PAYLOAD_TOO_LARGE)`, a taken filename,
  a folder that already exists, a folder moved into itself and a non-empty folder without
  `recursive` are `Err(CONFLICT)`; every blobstore and persistence failure is passed through
  unchanged, so a busy database is a retryable 503 on every step. The message texts are unchanged.
  `migrateKeys` still never fails as a whole: an item whose blob or row operation fails is counted as
  `skipped` and logged. A failing `ensureCollection` or status backfill during `setup()` is a boot
  error, as is a failing `migrateKeys`.
- **breaking** `media/default`: `media.upload` answers `415 UNSUPPORTED` for a disallowed content
  type and `413 PAYLOAD_TOO_LARGE` for a file over `maxBytes` (both 400 before), and a taken filename
  is `409 CONFLICT` via the error model instead of the deleted `mapping()` helper. In a multi-file
  request the per-file entries in `errors` gain `code` next to `status`; a `TRANSIENT` blobstore or
  database failure is no longer a per-file entry (and no longer a thrown 500) but fails the whole
  request with 503.
- **breaking** `media/default`: the fourteen steps return `Result` and every one has a `describe()`
  entry with `summary`, `reads` and `writes` — `media.get`, `media.update`, `media.download` and
  `media.remove` read `params.id`, `media.renameFolder`, `media.folderItems` and `media.removeFolder`
  read `params.path`, `media.upload` reads `files`, and all fourteen write `result`.
  `ctx.fail(400/404/409, …)` becomes `ctx.fail("VALIDATION"/"NOT_FOUND"/"CONFLICT", …)`. An unknown
  `?locale=` on `media.list` is now a 400 even when the result would have been empty.
- **breaking** `references-default`: the seven `References` methods (`missing`, `index`, `unindex`,
  `referrers`, `scan`, `report`, `rebuild`) return a `Result`; only an unknown type or target still
  throws. `references.check:<type>` fails `Err(DANGLING_REF)` (400) instead of `ctx.fail(400, …)`,
  carrying `details.fields: FieldError[]` and `details.refs: [{ field, to, id }]`; the message text
  is unchanged. `references.guard:<target>` and `references.guardAll:<target>` fail `Err(CONFLICT)`
  (409, as before) with the referrer list in `details` (`referrers` / `referenced`); the message
  text the admin parses into a referrer list is unchanged. `references.index:<type>` declares
  `reads: ["result.id"]` in `describe()` instead of falling back to `params.id` and answering a
  bare 500 when neither is set — the boot dataflow check now proves every pipeline supplies it, and
  a missing id at runtime throws (a wiring bug, not an expected failure). `references.guardAll:<target>`
  gets the same treatment for `reads: ["result.ids"]`. Every step passes a contract failure through
  unchanged, so a busy database is a retryable 503 on every step. Every step gets a `describe()`
  entry with `summary`, `reads` and `writes`, including `references.index:<type>` and
  `references.unindex:<type>`, which previously had none.
- **breaking** `links-default`: the five `Links` methods (`extract`, `unextract`, `check`, `report`,
  `rebuild`) return a `Result`; only an unknown type still throws. A probed URL's own
  `ok`/`status`/`error` stays data on the index row, never a step failure — only a persistence
  failure while reading or writing the index fails a step. `links.extract:<type>` declares
  `reads: ["result.id"]` in `describe()` instead of falling back to `params.id` and answering a
  bare 500 when neither is set — the boot dataflow check now proves every pipeline supplies it, and
  a missing id at runtime throws (a wiring bug). `links.unextract:<type>` keeps its `ctx.fail(400,
  "missing id")` check as `Err(VALIDATION)`. Every step passes a contract failure through unchanged,
  so a busy database is a retryable 503 on every step; `describe()` gains `reads`/`writes` on every
  step.
- **breaking** `images/default`: every asynchronous method of the `Images` instance exported from
  `./impl` returns a `Result` (only `sizes()` and `publicPath()` stay plain, they read in-process
  state). The error classes `SizesRejected`, `SizesConflict` (`./sizes`) and `ImagesBusy` (`./impl`)
  are deleted: an empty or malformed registry, a prune name that is still declared or has no
  variants are `Err(VALIDATION)`, a registered size colliding with a config size and a start while a
  fresh job runs or the instance is shutting down are `Err(CONFLICT)`, and every persistence or
  blobstore failure is passed through unchanged, so a busy database is a retryable 503 on every
  step. `mergeSizes` returns `Result<SizeRow[], KestrelError<"CONFLICT">>` instead of throwing. The
  message texts are unchanged (they keep the `images: ` prefix the deleted `mapping()` helper used
  to add). A failing `ensureCollection` or the initial job read during `setup()` is a boot error.
- **breaking** `images/default`: the twelve steps return `Result` and every one has a `describe()`
  entry with `summary`, `reads` and `writes` — `images.remove` reads `params.id`, `images.serve`
  reads `params.id` and `params.file`, `images.removeMany` reads `result.ids`, `images.attach` reads
  `result` and writes `result.variants`, `images.export:<dir>` writes `result.variants`, and the
  remaining steps write `result`. `ctx.fail(400/404/409, …)` becomes
  `ctx.fail("VALIDATION"/"NOT_FOUND"/"CONFLICT", …)`; the wiring guards of `images.removeMany`
  ("no ids in result") and `images.attach` ("no media item(s) in result") are thrown bugs instead of
  a 500 response, because boot's dataflow check now proves an earlier step wrote them. A failed
  variant is still a 404 naming the attempt count, and a pending one still serves the original with
  `x-kestrel-variant: pending`.
- **breaking** `backup/blobstore`: `backup()`, `prepareRestore()` and `versions()` on the `Backup`
  instance exported from `./impl` return a `Result`; a missing backup key is `Err(NOT_FOUND)`
  (`no backup at <key>`) instead of the old `{ prepared: false, key, size: 0, file }` shape, and
  every blobstore failure is passed through unchanged, so a transient blobstore outage is a
  retryable 503 instead of an uncaught rejection. `restoreWhenMissing()` (called from `setup()`) and
  `applyPendingRestore()` still throw on a real failure — that stays a boot error.
- **breaking** `backup/blobstore`: the three steps (`backup.run`, `backup.restore`,
  `backup.listVersions`) return `Result` and every one has a `describe()` entry with `summary`,
  `reads` and `writes`. `backup.restore` keeps answering `VALIDATION` (400) for an unknown version
  and `NOT_FOUND` (404) for a missing backup key, both now carrying `code`/`retryable` through the
  error model instead of a bare status.
- **breaking** `replication/sqlite`: `sync()`, `snapshot()`, `points()` and `prepareRestore()` on the
  `Replication` instance, and the exported `restoreFromBlobs()`, return a `Result`; a restore point
  with no snapshot before it, or naming an unknown `generation`, is `Err(NOT_FOUND)` instead of a
  thrown `Error`, and every blobstore failure is passed through unchanged, so a transient blobstore
  outage is a retryable 503 instead of an uncaught rejection. `restoreOnStart` in `setup()` still
  throws on a real (non-`NOT_FOUND`) failure — that stays a boot error. The direct `node:sqlite`
  handling (`DatabaseSync`, checkpoints, WAL parsing in `wal.ts`) is unchanged.
- **breaking** `replication/sqlite`: the five steps return `Result` and every one has a `describe()`
  entry with `summary`, `reads` and `writes`. `replication.prepareRestore` now answers `VALIDATION`
  for an `at` payload value that does not parse as a number or an ISO-8601 date (silently ignored
  before) and `NOT_FOUND` for an unknown restore point, both carrying `code`/`retryable` instead of
  the bare `404` it threw before.
- **breaking** `redirects/default`: `Redirects.lookup`/`export`/`render` return `Result<…,
  KestrelError<"TRANSIENT">>`; a `content@1` or `blobstore@1` failure propagates as `TRANSIENT`
  (any other code reaching them would be a bug and throws instead), so a busy database or a down
  blobstore is a retryable 503 instead of the old thrown 500 — `redirects.export`'s
  "redirects.json was not written – try again" is now `TRANSIENT` (503) rather than a plain 500.
  `RedirectRuleError` stays an internal exception thrown at rule-compile time; `redirects.validate`
  still catches it, now as `ctx.fail("VALIDATION", …, { row })` (the row number parsed from the
  message, when present) instead of `ctx.fail(400, …)`. `redirects.lookup`'s `ctx.done(...)` returns
  an `Ok` marked with the `DONE` symbol instead of throwing `PipelineDone`. All four steps
  (`validate`, `lookup`, `export`, `render`) declare `describe().reads`/`writes` per the step
  catalogue.
- **breaking** `delivery/static`: `delivery.exportLlms` answers `503` with code `TRANSIENT`
  (retryable, `Retry-After`) instead of `500` when `llms.txt` could not be written; the message
  ("llms.txt was not written – try again") is unchanged. `delivery.publish:<type>` no longer falls
  back to `params.id` and no longer answers `500 "no document id in result or params"`: it declares
  `reads: ["result.id"]`, which the boot dataflow check proves, and throws if it runs without one
  anyway. `delivery.unpublish:<type>` and `delivery.readStatus:<type>` answer
  `ctx.fail("VALIDATION", "missing id")` instead of `ctx.fail(400, …)`. Every step declares
  `reads`/`writes` (`delivery.exportLlms` writes `result.llms`), and a transient failure of
  `persistence@1`, `blobstore@1`, `content@1` or `site@1` reaches the caller as a retryable 503
  instead of a 500.
- **breaking** `delivery/static`: the `Delivery` API behind the steps (`delivery-static/impl.ts`)
  returns `Result<T, KestrelError<"TRANSIENT">>` from `publish`, `unpublish`, `status`, `publishAll`
  and `exportLlms`; any other code from a dependency is a wiring bug and throws. A `renderer@1`
  `Err` (`RENDER_FAILED` or `TRANSIENT`) is recorded on the status row as `state: "error"` with its
  message and the remaining locales are still published — the behaviour a thrown render error had
  before.
- **breaking** `migrations/default`: `list`/`check`/`apply` return a `Result` per `migrations@1`.
  The `MigrationFailed` and `MigrationsBusy` classes are gone: a second `apply()` while one is in
  flight is `Err(failure("CONFLICT", "migrations: apply is running"))`, a migration whose `up`
  throws, whose patch a `validate@1` schema rejects, or whose write `content@1` rejects is
  `Err(migrationFailed(message, { migration, document, locale?, problems? }))` (500, unchanged
  message text), and a transient ledger or `content@1` failure propagates as `TRANSIENT` (503,
  retryable) instead of the old thrown 500 — any other `content@1` or `persistence@1` code reaching
  the module would be a wiring bug and throws. `runBoot` is unchanged from the outside: mode
  `"check"` still fails boot listing what is pending, mode `"apply"` now fails boot with the
  message of the `Err` that `apply()` returned.
- **breaking** `migrations/default`: both steps return `Result` and declare their dataflow —
  `migrations.list` and `migrations.apply` read nothing and write `result`; `migrations.apply`
  passes the contract's error through (`ctx.fail(r.error)`) instead of catching typed exceptions,
  so its statuses stay 409 and 500 but now carry `code` and `retryable`.
- `core`: new `@michaelthielemann/kestrel/cast` with `boundaryCast<T>(value, boundary)`
  (`"json" | "ast" | "dom" | "host"`) — the one sanctioned double cast at an untyped boundary.
- `core`: new `boot({ dev })`, default `process.env.NODE_ENV !== "production"`. In dev mode the runner
  validates `ctx.payload` against `describe().input` (with `describe().query` merged into its
  properties) before every step; a mismatch is a 500 `INTERNAL` naming the step, the pipeline and the
  failing path, logged with outcome `error`. Production never runs it. The validator is
  `validateSchema(schema, value)` in the new `@michaelthielemann/kestrel/schema` — the JSON Schema
  subset the shipped `describe()` blocks use (`type` incl. `integer` and array form, `properties`,
  `required`, `additionalProperties`, `items`, `enum`, `const`, `oneOf`, `anyOf`, `pattern`,
  `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`), no new dependency.
  `runPipeline(pipeline, input, logger, options?)` takes `{ validateInput }`, off by default.
- `core`: step names are a compile-time catalogue. `ModuleDefinition<Name, Steps>` carries its
  module name and step map in the type, `StepsOf<M>` / `StepCatalogue<Modules>` turn a module list
  into the union of the step names it registers (factories as `` `prefix.step:${string}` ``), and
  `pipelineDefiner<Known>()` returns a `definePipeline` bound to that union, so a misspelled or
  unloaded step in a pipeline file is a `tsc` error instead of a boot error.
  `PipelineDefinition<S>` is generic over the step name type and defaults to `string`.
- `content/default`: `validate()` reports an unknown `locale` option as the field error
  `{ field: "locale", message: 'unknown locale "…"' }` instead of throwing, so `content.validate:<t>`
  answers 400 with `details.fields` instead of a 500.
- `images/default`: a blobstore failure while writing one variant is recorded on that variant row
  (state `error`/`failed` with the message) exactly like a render failure, instead of aborting the
  whole `generate` call; a failure while reading the original still fails the call. Inside the sync
  job a persistence failure is recorded on the job row (`state: "error"`) and logged, as a thrown
  error already was.
- `examples/minimal`, `examples/embedded`: new `modules.ts` per example exports the `as const`
  module list, `KnownStep` (`StepCatalogue<typeof modules>`) and a `definePipeline` bound to it via
  `pipelineDefiner`; every pipeline file imports `definePipeline` from `./modules.ts` instead of
  `@michaelthielemann/kestrel/definePipeline`, so a misspelled step name is now a `tsc` error
  naming the closest match instead of a boot failure.
- `scripts/smoke-consumer.sh`: the generated consumer config used a literal `$1` as the
  `authn/single` `passwordHash`, which bash expanded inside the unquoted heredoc and aborted the
  script under `set -u`. The hash is now generated with `hashPassword("smoke")` before the heredoc.
- **breaking** `core`: `Context` gains a readonly `runId` (set by the runner, never settable from a
  payload or header) and an optional `requestId` taken from an incoming `x-request-id` header of
  short printable ASCII. Anything constructing a `Context` literal (test fakes) must supply `runId`.
- **breaking** `core`: `buildResponse(status, body, meta, extraInline)` takes `{ runId?, requestId? }`
  instead of a bare run id. New export `errorResponse(status, error, requestId?)` — the one shape for
  errors raised before a pipeline runs; the h3 adapter uses it instead of its own copy.
- `core`: `ctx.fail(status, message, details?)` accepts a plain object; `RunResult` and the HTTP error
  body gain `step` (the step the failure or throw happened in) and `details`. The body is now
  `{ error, runId, step?, details? }`; the `"<pipeline>/<step>: <message>"` text of a thrown error is
  unchanged. `content/default` passes `details: { fields: FieldError[] }` on a validation failure, so
  a client can map errors to fields without parsing text.
- `core`: `ContextInput` gains `parentRunId`, logged in every `step` line of the run. `events/inmemory`
  puts the emitting `runId` into the envelope and passes it as `parentRunId` when it starts a handler
  pipeline; cron runs have no parent. The `x-request-id` of a request appears in the `http` log line
  and is echoed as a response header by the core server and the h3 adapter alike.
- `core`: new `http.timeouts` config (`requestMs` 30000, `headersMs` 10000, `keepAliveMs` 5000) sets
  `server.requestTimeout`, `server.headersTimeout` and `server.keepAliveTimeout`.
- **breaking** `core`: `stop(options?: { timeoutMs })` resolves with `{ drained }`. It now closes the
  listener first, waits for in-flight runs and for connections still sending a request or receiving a
  response (deadline `timeoutMs` or the new top-level config `shutdownTimeoutMs`, default 30000),
  then drops the remaining connections, stops cron/event triggers and tears the modules down —
  requests in flight at SIGTERM are served instead of cut. The `kestrel` binary exits 1 when the
  deadline is hit and registers `unhandledRejection`/`uncaughtException` handlers that log through the
  logger, attempt a 5 s `stop()` and exit 1.
- `core`: a cron entry whose pipeline is still running from the previous tick is not started again;
  the tick logs a `warn` line naming the pipeline. `Logger` gains an optional `warn` method
  (implemented by `consoleLogger`/`silentLogger`, `logWarn(logger, …)` falls back to `info`).
- `audit/persistence`: entries store the envelope's `eventId` and a redelivered event with a known id
  is skipped. `persistence@1` has no unique constraint, so the check is a read before the write and
  two concurrent deliveries can still both pass it.
- `media-default`: `media_items` gains `status` (`uploading` | `ready` | `failed`) and `checksum`
  (sha256 of the uploaded bytes, hex). `media.upload` writes the row first, then the blob, then
  flips the row to `ready`; a failing blob write leaves `status: "failed"` and rethrows, and a later
  upload of the same name replaces that row instead of colliding with it. `media.get` and
  `media.download` 404 for anything not `ready`, `media.list` (including `?ids=`) filters it out.
  `media.remove` deletes the row before the blob and only logs a failing blob delete. A rename moves
  the blob back when the row update fails. Both fields are additive: existing rows read as
  `checksum: null` and `status: "ready"`.
- `media-default`: new step `media.reconcile` — compares the blobs under the configured prefix with
  the `media_items` keys and returns `{ blobsWithoutRow, rowsWithoutBlob }`; `payload.delete: true`
  deletes the orphan blobs (never rows), keys under `media-variants/` are left to `images-default`.
  No trigger is wired; consumers should call it from a cron pipeline. The companion step
  `media.reconcileDelete` always deletes, so a pipeline can offer the report and the cleanup as two
  routes without trusting a request flag (a step is either a plain step or a `stepFactory`, so
  `media.reconcile` cannot carry an optional argument).
- **breaking** `media-default`: an upload without `provenance` is recorded as `{ origin: "unknown" }`
  instead of `{ origin: "human" }`, and rows written before the field read as `unknown` too — a
  missing declaration is not evidence that a human made the file, which is the wrong default for AI
  labelling. `origin` accepts `human | ai | mixed | unknown`. `media.download` sets
  `X-Content-Provenance` for every origin but `human`, so such items now carry
  `X-Content-Provenance: unknown`. Callers that mean "a human uploaded this" must send it.
- **breaking** `images-default`: sizes declared in code are no longer persisted. Config/default sizes
  are rebuilt from the config at every boot and registered sizes live in the process that took them,
  rebuilt by every `images.register` call; `images_sizes` rows written by earlier versions are
  deleted once at setup with a log line naming the count. A host that registers sizes must register
  them at boot (`kestrel.run("registerImageSizesBoot", …)`), otherwise the instance only knows the
  config/default sizes after a restart. `images.listSizes` still returns the merged view with
  `source`. `images.readStatus` now reports as `orphaned` the sizes that still have variants but are
  no longer declared (instead of leftover registered rows), and `images.prune` deletes those
  variants; pruning a still-declared size or a name without variants is a 400.
- `examples/minimal`: `createPage`/`updatePage` check the body against its schema again after
  `validate.sanitize:pages.body`, so what is stored is schema-valid; the first `validate.check` stays
  in front of the sanitize step, which needs a schema-valid structure to walk.
- **breaking** `images-default`: a variant is retried at most `maxAttempts` times (config, default 5).
  The last failure sets `state: "failed"` instead of `"error"`; sync and resume skip those rows, and
  `images.readStatus` reports `variants.failed` next to `done`/`pending`/`error`. `images.serve`
  404s for a failed variant instead of serving the original in its place, naming the size, the
  attempt count and the last error; a `pending` variant still falls back to the original, now with
  the header `x-kestrel-variant: pending` instead of `fallback`. Changing a size definition lifts the
  quarantine and restores the full attempt budget. A persistence error while recording a failed sync
  job is now logged instead of swallowed.
- Engines: every package requires Node `>=22.13.0` — `node:sqlite` (persistence-sqlite) runs unflagged
  only from that version; earlier 22.x needs `--experimental-sqlite`.
- **breaking** `content@1`: new method `removeTranslation(type, id, locale)` — every provider must
  implement it. `content-default` nulls every localized field of that locale (non-localized fields stay)
  and returns the document in the default locale; unknown locale → `ContentValidationError`, missing
  document or translation → `ContentTranslationError` 404, the last remaining translation → 409 (the
  default locale may be removed while another translation exists). Step
  `content.removeTranslation:<type>` (locale from the route param or `?locale=`) maps these to
  400/404/409. `examples/minimal`: `DELETE /pages/:id/translations/:locale` → `deletePageTranslation`
  (index, extract, publish, llms export, event `page.translationRemoved`).
- `delivery-static`: new step `delivery.exportLlms` and config `llms` (`siteUrl`, `full`, `settings`,
  `titleField`, `seoField`, `headings`; defaults to enabled with paths only, a missing settings type
  leaves only the fallback header) writing `<prefix>llms.txt` (always) and `<prefix>llms-full.txt`
  (`full: true`, needs the `html` format; the stored HTML restricted to `<main>` is converted with
  turndown) from the live publish status rows, skipping `seo.noindex`; the step adds
  `llms: { entries, full }` to the result. `examples/minimal` gains `settings.description`, `pages.seo`
  and the step in `createPage`/`updatePage`/`deletePage`/`setSettings`/`publishAllPages`.
- New module `migrations-default` (`migrations@1`): consumer content migrations `{ id, collection,
  up }` applied once per document and stored locale, validated against the model and — when a
  `validate@1` provider is loaded — the consumer's JSON schemas, recorded in `content_migrations`
  only after success; boot mode `apply` | `check` (boot refuses with the pending list) | `off`;
  steps `migrations.list` / `migrations.apply` (`payload.dry`); one `migrations.applied` event per
  run, never a per-document `<type>.updated`. Helpers export `./helpers`: `defineMigration`,
  `mapBlocks`, `renameBlock`, `renameProp`, `omit`.
- New contract `validate@1` (`targets`, `check`), provided by `validate-jsonschema`.
- `core`: `defineModule({ optional: [CONTRACT] })` orders a module after that provider when one is
  loaded; `deps.find(CONTRACT)` returns the instance or `undefined`.
- `references-default`: a document referencing itself no longer counts as a referrer — `referrers`,
  `referrersMany`, `guard` and `guardAll` ignore self-references, so a page whose link points to
  itself can be deleted.
- `validate-jsonschema`: a failed `{ type: "null" }` branch of a nullable union is no longer reported
  when a deeper problem under the same path explains the failure (the admin used to show "must be
  null" on a repeater container next to the real row error).
- `contracts/testing`: `fakePersistence` mirrors SQLite semantics — reads null-fill schema fields
  absent from the stored document, and a field outside the schema throws (filters, sort, create,
  update) instead of silently matching nothing; the persistence contract test covers both against
  the fake and `persistence-sqlite`.
- `validate-jsonschema`: a discriminated `oneOf` (all branches tagged by `properties.type.const`) no
  longer lets non-object values (`null`, strings, numbers, arrays) pass — ajv's `discriminator` only
  constrains objects, so `withDiscriminators` now also pins `type: "object"` on the union node (and
  leaves a union whose declared type is not `object` untouched).
- `content-default`: `content.get:<single>` answers 200 with an empty document (every model field `null`, `_translations` all
  `false` when locales exist, `_locales: {}` with `?fallback=true`) while the singleton was never set;
  The empty document goes through the step's fixed filter like any other, so
  `content.get:settings?status=published` still answers 404 until something is published; 404 stays for multi types. OpenAPI no longer lists 404 for single-kind `get` steps.
- **breaking**: a step that takes an argument (`content.get:pages`) must be wrapped in
  `stepFactory()` from `@michaelthielemann/kestrel/context`. A `Step` and a `StepFactory` are both
  one-argument functions, so the registry could not tell them apart and called a plain step with the
  argument string to find out. Resolving a step now fails at boot when a factory is used without an
  argument or a plain step with one, and never calls the step to decide. Every shipped module is
  wrapped; third-party modules with factory steps must be updated.
- `core`: boot rejects a config whose `modules` entries are out of order with the loaded modules
  (only when an entry demonstrably names a different loaded module), a module that provides a
  contract but registers its steps under another prefix, and two http triggers that resolve to the
  same route pattern (`GET /pages/:id` and `GET /pages/:slug`). The per-module "requires X which is
  not registered" check is gone; `sortModules` already refuses a missing provider and orders
  providers first.
- `core`: `matchRoute` picks the most specific route (literal before `:param` before `*rest`)
  regardless of registration order, and no longer throws on a malformed percent-escape; an encoded
  `/` in a wildcard tail no longer matches. Router-level responses (health, 400, 404, 413, 500) and
  CORS preflights carry `x-kestrel-run-id` and the mandatory security headers, and a binary result's
  own headers can add to but no longer overwrite them. `content-disposition` follows RFC 6266 with
  an ASCII fallback plus `filename*` for non-ASCII names. Same for the h3 adapter.
- `authz-roles`, `backup-blobstore`, `ratelimit-memory`, `replication-sqlite`,
  `validate-jsonschema`: the instance no longer reaches its steps through a module-level variable,
  so a second `boot()` in the same process no longer takes over the first one's steps. `authz@1`
  implementations from `authz-roles` expose `canAnonymous`.
- `contracts`: `fakePersistence` mirrors SQLite storage semantics (typed columns, ASCII-only `LIKE`
  folding, binary string collation, nulls first ascending, structural json comparison), and the
  persistence contract test pins them for every implementation.
- `examples/minimal`: `GET /pages/:id` only serves published pages, `GET /admin/pages/:id`
  (`pages.manage`) serves any; `createPage`/`updatePage` validate before sanitizing so an
  over-nested payload is rejected before the recursive sanitizer walks it.
- `core`: event triggers are contributed by modules, not wired by the core. `defineModule` accepts
  `triggers: { event(instance, entries, run, logger) }`; boot collects the modules offering the hook
  and calls it in `start()` with the configured event entries, pushing the returned stop function
  onto the shutdown list. Boot no longer looks up `events@1` by name (and no longer casts it): event
  triggers without such a module fail at boot with "event triggers need a module that provides an
  event trigger hook", two modules offering the hook fail naming both, and a module providing its own
  `events@1` with different method names now fails at boot instead of throwing in `start()`.
  `events-inmemory` provides the hook. `EventEntry`, `ModuleTriggers` and `Runner` are exported from
  `@michaelthielemann/kestrel`.

- `media-default`: `media.upload` now processes every file of a multipart request, not just the
  first. Exactly one file keeps today's response (the item, unchanged); two or more return
  `{ items: MediaItem[], errors: [{ filename, status, message }], ids: string[] }` — a rejected
  (400) or conflicting (409) file is recorded in `errors` and does not stop the others (partial
  success, 200). `events.emit:<name>` now also puts `result.ids` on the envelope as `ids` (`id`
  stays `null` for a bulk result). `images.generate` accepts `payload.ids` (from a bulk
  `media.uploaded` event) and generates variants for each, skipping unknown ids.
- **breaking**: repeated query parameters (`?tag=a&tag=b`) now arrive in `ctx.payload` as
  `string[]` instead of collapsing onto the last value; a single occurrence still arrives as
  `string`. Core and the h3 adapter parse identically (`parseQuery`, exported from `@michaelthielemann/kestrel`).
  Steps that expect a scalar read it through the new `first(value)` helper from
  `@michaelthielemann/kestrel/context`.

- `examples/embedded` (and `examples/h3`, which mounts the same config): `createPage` now runs
  `authn.requireUser` + `authz.require:pages.write` like the canonical example in
  `docs/PIPELINES.md`. The config loads `authn-single` (user `editor`, password `kestrel-demo`)
  and `authz-roles`, and a `login` pipeline on `POST /login` hands out the token.

- `examples/minimal`: `setSettings` validates `navigation` against the new
  `schemas/settings.navigation.json` (list of `{ label, path, children? }`, no other properties,
  400 with path and reason). `media-default` now validates `alt`, `title` and `description` as plain
  text (max 2000 characters, no control characters except tab and newline, 400
  `media/default: <field> must be plain text (max 2000 chars)`) instead of running them through the
  HTML allowlist, which would have rewritten legitimate text such as `5 < 6`.

- `core`: boot refuses `http.inlineTypes` containing `image/svg+xml` when no module registers the
  step `sanitize.svg` – inline SVG delivery is now tied to the sanitizer the docs assume
 .

- **breaking**: `events.emit:<name>` now sends `{ event, at, identity, params, id }` instead of
  `{ event, at, identity, params, result }`. `id` is derived from `ctx.result.id` →
  `ctx.result.document.id` → `ctx.params.id` → `null`; `result` is included only with the step
  argument `events.emit:<name>?with=result`. `images.generate` now reads the media id
  from `payload.id` only (the `payload.result.id` fallback is gone).

- `core`: JSON log lines from `consoleLogger` (`step`, `info`, `error`) now start with `time` — a
  local ISO 8601 timestamp with milliseconds and UTC offset.

- `core`: the context is now shallowly frozen between steps (`createContext` and after each step in
  `runPipeline`). A step that mutates a context field in place now throws a `TypeError` and fails the
  pipeline with status 500 instead of silently mutating shared state; `{ ...ctx, result }` and
  `return ctx` keep working as before. `payload`, `params`, `headers`, `files`, and `result` contents
  stay mutable.

- **breaking**: renamed read-only steps to verbs and prefixed module collections with their module
  segment. No data migration — existing deployments regenerate the collections and get
  regenerated (`publishAll` for delivery status, boot registration + `images.sync` for the image
  registry/variants).

  | Kind | Old | New |
  |---|---|---|
  | Step | `delivery.status` | `delivery.readStatus` |
  | Step | `images.sizes` | `images.listSizes` |
  | Step | `images.status` | `images.readStatus` |
  | Step | `media.folders` | `media.listFolders` |
  | Step | `replication.points` | `replication.listPoints` |
  | Step | `replication.status` | `replication.readStatus` |
  | Step | `backup.versions` | `backup.listVersions` |
  | Collection | `publish_status` | `delivery_publish_status` |
  | Collection | `image_sizes` | `images_sizes` |
  | Collection | `image_variants` | `images_variants` |
  | Collection | `image_jobs` | `images_jobs` |

First shape of the system:

- core: contracts via `defineContract`, boot check, pipeline runner, HTTP/event/cron triggers,
  multipart uploads and binary results, `kestrel` CLI
- contracts: persistence@1, authn@1, authz@1, blobstore@1, events@1, content@1 (i18n, enum, ref, completeWhen), site@1, renderer@1
- core: /health, X-Kestrel-Run-Id, nosniff/no-store on every response, access log, client ip with trustProxy
- core: `ctx.done(result)` ends a pipeline early with status 200 (counterpart of `ctx.fail`)
- modules: events-inmemory, persistence-sqlite, authn-single, authn-multi, authz-roles, ratelimit-memory, content-default,
  references-default, links-default, blobstore-filesystem, blobstore-s3, media-default, backup-blobstore,
  audit-persistence
- kestrel-openapi: OpenAPI 3.1 from triggers, pipelines and step descriptions (`describe()` in defineModule)
- sanitize-svg + core http.inlineTypes: sanitized SVG uploads served inline
- validate-jsonschema: payload fields against JSON Schema files (ajv); HTML sanitizing at format:"html" positions (sanitize-html); `watch` reloads changed schema files without restart
- replication-sqlite: Litestream-style continuous replication (snapshots + WAL segments), PITR, retention
- delivery-static + renderer-plain: static delivery with publish status per locale
- media-default: provenance (human/ai/mixed) per item, X-Content-Provenance on download
- adapter kestrel-h3: HTTP triggers as an h3 event handler for Nuxt/Nitro (`examples/h3`)
- embedded mode: `http: null`, `kestrel.triggers` + `matchRoute` for host frameworks (`examples/embedded`)
- example consumer under `examples/minimal`
- core: modules receive `deps.logger`; optional `teardown()` runs on `kestrel.stop()` in reverse boot order; boot failures after setup tear down already-constructed modules
- redirects-default: admin-managed redirect rules; `redirects.lookup` in site resolution, `redirects.json` exported to the blobstore for an edge proxy
- blobstore@1: `move(from, to)` (filesystem rename, S3 copy+delete)
- media-default: persistent folders (create/rename/delete routes), blob keys `media/<folder>/<filename>`
  (`prefix` config) so the filesystem blobstore mirrors the library without colliding with replication
  snapshots, the static site or `redirects.json`; one-off key migration on boot, resumable after an
  interrupted move; references.guardAll step; `GET /media/folders` no longer reports a `""` entry for
  items in the root
- blobstore-filesystem: `move`/`remove` prune directories they empty (the root stays);
  blobstore-s3: `CopySource` keeps its slashes and percent-encodes the segments
- media-default: `media.list` with `recursive: true` matches the exact subtree of `folder` via a range
  scan instead of a LIKE prefix, so sibling folders like `2026x` or `2026-alt` no longer match `2026`
- blobstore-s3: `pnpm test:s3` runs the `blobstore@1` contract test against MinIO in Podman
- kestrel-openapi: `StepDescription.extendsOutput` merges a step's additions into the output schema of the
  preceding step instead of replacing it (`redirects.export` now shows `redirects` on
  `POST /admin/publish-all/pages` and `PUT /redirects`)
- images-default: image variants (size registry, generation on upload, resumable sync job, prune,
  attach/serve/export) on top of `media-default`, WebP only, original untouched
- delivery-static: optional `media` config copies referenced originals and `done` variants into the
  site export (`<prefix><target><folder>/<filename>[.<size>.<ext>]`) and rewrites their URLs in the
  rendered output; unresolved references are logged and left untouched; a resolved reference whose
  blob is missing, or a media row with an unsafe folder/filename, fails the publish instead of
  writing a broken or escaping path; the URL match is now segment-bounded (`/file-x` no longer matches `/file`)
- references-default: `references.referrersMany:<target>` step and `GET /admin/references/to/<target>?ids=a,b,c`
  routes batch up to 200 referrer lookups in one request, alongside the existing single-id routes
- references-default: internal links inside `json` fields (block trees) are indexed alongside `ref`
  fields — every `kestrel:<type>:<id>` and `{ type: "internal", collection, id }` per locale, mapped
  through the configured targets; each index row and every `referrers`/`referrersMany`/`report` entry
  carries `via: "field" | "body"`, so `references.guard`/`guardAll` now refuse deleting media or pages
  that are only used in a block; `INTERNAL_REF`/`collectInternalRefs` moved to `kestrel-contracts/links`
- **breaking** site@1 + site-default: the website vocabulary leaves `content@1`, which is now generic
  document CRUD. `SiteRules`, `LinkTarget` and `resolveLinks` are gone from `content@1` (`LinkTarget`
  now lives in `kestrel-contracts/links`); path ↔ document resolution, `pathOf` and the rewriting of
  `kestrel:<type>:<id>` are the new contract `site@1`, provided by `site-default`. The steps
  `content.resolve:<t>` and `content.resolveLinks:<t>` are renamed to `site.resolve:<t>` and
  `site.resolveLinks:<t>`, and configs that resolve site paths must activate
  `@michaelthielemann/kestrel-site-default` after `content-default`. `delivery-static` requires
  `site@1` in addition. The HTTP surface is unchanged.
- contracts: the query vocabulary (`Filter`, `Condition`, `FindOptions`, `Page`) moved to its own
  `kestrel-contracts/query`, shared by `persistence@1`, `content@1`, `site@1`; `content@1` no longer
  imports from `persistence.ts`; `kestrel-contracts/persistence` still re-exports the same names
- events@1: `emit` is documented as synchronous and now aggregates handler errors into an
  `AggregateError` instead of stopping at the first one; the `events.emit:<name>` step logs a
  listener failure instead of failing the emitting pipeline
- docs: submodule template allows flat helper files; README rule by content
- `persistence-sqlite`: every connection now also sets `PRAGMA busy_timeout` (new optional config
  `busyTimeoutMs`, default 5000 — a locked database makes the caller wait instead of failing at once
  with `SQLITE_BUSY`), `PRAGMA foreign_keys = ON` and `PRAGMA synchronous = NORMAL` next to the WAL
  mode it already used. The README documents the pragmas and states the one-process assumption
  (`replication-sqlite`'s second connection in the same process is supported, a second process on
  the same file is not).
- **breaking** `backup-blobstore`: `backup.restore` no longer writes over the open database. It
  downloads the blob to `<file>.restore-pending` and writes the marker `<file>.restore-marker`; the
  module's `setup()` swaps both in on the next start (removing `<file>`, `-wal` and `-shm` first) and
  logs `applied pending restore`. A marker without a staged file is dropped. The step result is now
  `{ key, size, file, pending: true, appliedOnRestart: true }` instead of `{ restored, key, size }` —
  callers must restart the process for a restore to take effect. `Backup.restore()` is replaced by
  `prepareRestore()` (stage) and `restoreWhenMissing()` (the boot path for `restoreOnStart`).
- `blobstore-s3`: the S3 client is configured with explicit timeouts and a retry limit instead of the
  SDK defaults — new config `timeoutMs` (default 10000, used as both `connectionTimeout` and
  `requestTimeout`) and `maxAttempts` (default 3).
- `delivery-static`, `images-default`: the module's `Config` type is derived from `configSchema`
  (`z.output`) instead of a hand-written interface cast with `as unknown as`. Since `llms` carries a
  schema default it is always present, `delivery.exportLlms` no longer has an "llms is not
  configured" path.
- `content-default`: `content.list:<t>` validates its query parameters — `limit` and `offset` must be
  integers (`limit` >= 1, `offset` >= 0), `limit` at most the new config `maxLimit` (default 200),
  and an unknown `sort` field now throws `ContentQueryError` (exported from `./impl`) instead of a
  generic `Error`. All four cases fail the run with 400 instead of being silently dropped or
  answering 500; the OpenAPI query schema carries `maximum: maxLimit`.
- `openapi`: the `Error` component schema documents the optional `step` and `details` fields the HTTP
  error body can carry.
