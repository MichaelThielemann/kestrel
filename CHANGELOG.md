# Changelog

## Unreleased

Net changes since 5.8.1.

### Breaking

- The pipeline grammar gains an atomic group: `steps` accepts `{ atomic: [...] }` next to a plain
  step name, and the runner wraps such a group in one all-or-nothing scope it obtains from a
  module hook. `PipelineDefinition["steps"]` is now `readonly PipelineEntry[]`, not
  `readonly string[]`; code that reads, filters or maps a pipeline's steps as plain strings must
  flatten first with the exported `pipelineSteps()`. `ResolvedStep` and
  `PipelineStepManifest` gain an optional `atomic` ordinal; `ModuleManifest` gains a required
  `atomicScope` boolean, so a hand-built manifest must add it.
  - `ModuleDefinition` (and `ModuleInput`) gain an optional `atomicScope(instance, info, body)`
    hook, published as `AtomicScope` from the new `@michaelthielemann/kestrel/atomic` export path.
    At most one loaded module may declare it; a pipeline with a group and no provider, or two
    providers, fails to boot naming the pipeline or the two modules.
  - `StepDescription` gains an optional `atomicSafe` boolean, default `false`. A step inside a
    group whose `describe()` does not declare `atomicSafe: true` fails boot, naming the pipeline
    and the step.
  - `persistence/sqlite` implements the scope: one `BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK` per
    group, serialized by a FIFO mutex so a concurrent read never observes an uncommitted row.
    `createMany` now uses `BEGIN IMMEDIATE` and joins an outer scope instead of opening its own.
    Two new config keys, `acquireTimeoutMs` and `scopeTimeoutMs`. `scopeTimeoutMs` defaults to
    `5000`; `acquireTimeoutMs` defaults to `busyTimeoutMs + 10000`. An explicit `acquireTimeoutMs`
    that does not exceed `busyTimeoutMs` is rejected at setup, naming the key. A persistence call
    made after its own atomic scope rolled back or timed out **throws** instead of writing (only
    reachable from work a step did not await); a call made after the scope committed writes
    normally, with a warning logged.
  - Every DB-only, single-document, request-bounded step of `content-default`, `revisions-default`,
    `references-default`, `links-default`, `events-queue`, `delivery-static` (`readStatus` only)
    and `authn-multi` (`verifyUser`, `deleteUser`) now declares `atomicSafe: true`; every other
    shipped step keeps the default `false`.
  - `fakePersistence` (the contracts package's testing fake) gains the same `scope`/`failScope`/
    `scopeTimeoutMs`/`acquireTimeoutMs` surface, so a module test can exercise a grouped pipeline
    without SQLite, including its own FIFO queue, an acquire budget and the two terminal states of
    a closed scope. **`FakePersistence` gains four new required members**: anyone who built a
    hand-written implementation of that interface's type (rather than using `createFakePersistence`)
    must add them. The core's `testing/runPipeline.ts` test helper gains a typed `atomicScope`
    option with no default.
  - `insights.readManifest`'s output schema follows the two new manifest fields.
- Event delivery is a separate module from the `events@1` bus. `events-inmemory` now provides
  `events@1` and nothing else — no `events.emit` step, no event trigger hook. Configure exactly one
  delivery module next to it: `events-direct` (new, inline — subscribes event-trigger pipelines to
  the bus and runs them within the emitting request) or `events-queue` (outbox — see below). An
  instance without a delivery module fails to boot as soon as a pipeline has an event trigger
  (`event triggers need a module that provides an event trigger hook`) or uses `events.emit`
  (`unknown step "events.emit"`); two delivery modules fail to boot with `step "events.emit" is
  already registered by <module>`.
- `events-direct`'s `events.emit` no longer swallows a subscribed handler's rejection: it answers
  500 `INTERNAL` with the aggregated failure as `cause` instead of logging and ignoring it. This
  only affects a programmatic `events.on` handler that throws; a pipeline handler never throws.
- `events-queue` no longer provides `events@1` and now requires it (`persistence@1` + `events@1`);
  it keeps its own `events.emit` (writes one row per subscribed pipeline, never touches the bus),
  the worker and the admin steps. It subscribes on the bus, at `setup()`, to every event name a
  configured pipeline trigger names, so an event raised through `events@1` by a module (for example
  `migrations.applied`) is still queued and a failed insert still rejects that `emit`.
- `events-queue`'s dead-letter and retry are per pipeline: one row per `(event, pipeline)`, so a
  failing pipeline's retries no longer re-run the other pipelines subscribed to the same event.
  `events.listDead` items gain a required `pipeline` field (`""` for a row stored before this
  change); queue counters grow accordingly, since they now count `(event, pipeline)` rows. **No
  ordering is guaranteed between the pipelines subscribed to one event.** Rows stored before this
  change (or written while the delivery table did not exist yet) carry no pipeline; the worker fans
  them out to every currently subscribed pipeline at the start of its first tick after upgrading.
- Every event a pipeline receives now carries `eventId` (a fresh UUID unless the emitter supplied
  one), `event` and `at` — additive to the payload, not a contract change — including events raised
  through `events@1` by a module. `eventId` is the documented dedup key for at-least-once delivery.
  A consumer step that validates the event payload against a schema with
  `additionalProperties: false` must allow these three fields, or validation now rejects an event
  it accepted before.
- `core`: `Deps` (the argument to a module's `setup()`) gains a required `eventTriggers` property,
  the configured event triggers in configuration order. `Kestrel["contracts"]` is now typed
  `ContractLookup & { names(): string[] }` instead of `Deps & { names(): string[] }`; a reader of
  `kestrel.contracts` is unaffected, a consumer constructing a `Deps` by hand must add the field.
- `core`: `sortModules` adds a soft ordering edge from a module declaring `emits` to the module
  providing the event trigger hook, unless that module already depends on it, so an event a module
  raises during its own `setup()` can already be delivered once the instance starts. This changes
  the setup order only for such a module; every other module keeps the order the config lists.
  **`emits` is load-bearing for this edge**: a module that raises an event through `events@1` during
  its own `setup()` and does not declare that event in `emits` may be set up before the delivery
  module exists, and with `events-queue` that event is then lost — there is nobody subscribed yet to
  catch it.
- Rolling back to the previous major with `events-queue` configured requires a drained queue first
  (`pending` and `running` at zero, visible through `events.readQueueStatus`): a fanned-out row is
  one row per pipeline where the previous major expects one row per event, and its worker would
  otherwise run every registered handler for each row it claims.
- `core`: `Introspection` (the read-only view a module's `attach(instance, kestrel)` receives)
  gains a required `health()` method next to `describe()` and `observe()`. A hand-built
  `Introspection` value, such as a test double, must add it.
- `sortModules` applies `defineModule`'s `before: readonly Contract<unknown>[]` as a real ordering
  edge: a module declaring `before: [C]` is now set up before the provider of `C`, regardless of
  where either module sits in `kestrel.config.modules`. A module whose target's provider depends on
  it, directly or transitively — including a module that both `requires` and declares `before` on
  the same contract — fails the boot as a dependency cycle naming the path, since "set up before
  the thing I need" cannot be satisfied. The `BootWarning` member `module-order` is removed: a
  hand-written `modules` list that this reordering silently fixed no longer produces a warning,
  since there is no longer anything to warn about.
- `content-default`: a content field name may no longer start with `_`, on every path and under no
  feature condition. Boot fails naming the type and the field. That namespace is reserved for
  members the system adds to a document (`_locale`, `_links`, `_translations`, and any future one), and
  closes a collision that nothing previously guarded.
- `delivery-static`: `delivery.publish` merges its result into `_delivery` instead of replacing it
  with `{ document, delivery }`, and `delivery.exportLlms` writes `_llms` instead of `llms` — both
  now members of the reserved underscore namespace. `delivery.publish` and `delivery.unpublish`
  take the document id from `result.id`/`params.id` or, when neither is present, from an event
  envelope's `payload.id`, so both can run as the first step of a pipeline an event triggers.
  `delivery.publish` answers `VALIDATION` (400) when no id is available; it used to throw, which
  surfaced as `INTERNAL` (500).
- Both event delivery modules gain the step `events.relay`, and `EVENT_DELIVERY_STEPS` lists it
  next to `events.emit`. Placed after a pipeline's last `events.emit:`, it reports how that run's
  own events were delivered and adds `_events: { status, pipelines: [{ event, pipeline, status,
  attempts, dead, error }] }` to the result — so a pipeline ending in an emit now has that member
  in its response and its OpenAPI schema. The step is not `atomicSafe`; boot rejects it inside an
  atomic group.
  - `events-direct`: the subscribed pipelines already ran, inline, during `events.emit`; the relay
    only reports the outcome (`attempts` is always `1`, `dead` is always `true` on an error, since
    nothing here retries). Recorded outcomes older than 60 seconds are dropped on the next emit,
    with one `warn` naming the count.
  - `events-queue`: the relay **delivers** the run's own rows inside the request, through the same
    `attempts`/backoff/dead-letter machinery the worker uses. A new config key `relayMs` (default
    5000, `0` disables the relay) bounds how long it may spend; a row it does not reach stays
    `pending` for the worker. `events_queue` rows gain a `runId` column, filled from the event
    envelope, and a row belonging to a run is written with `availableAt = createdAt + relayMs`
    instead of being immediately due, so the worker takes it only once no relay claimed it in time.
    `events.listDead` items gain a required `runId` field (`""` for a row that names none).
  - Both relays require `ctx.result` to be an object or `undefined`: a result that is already some
    other value (an array, a string, …) is a wiring error and throws, the same way
    `authz.listRoles` treats it.
  - `events-queue` gains a config key, `relayPipelines`: an array of pipeline names, or `"all"`
    (the default, the behaviour above unchanged for every subscribed pipeline). A row whose
    pipeline is left out of the list gets no head start (`availableAt = createdAt`, same as a row
    with no `runId`) and the relay never claims it by id, so it is the worker's from the moment
    the response goes out; `events.relay`'s `_events` report still names it, with a new fourth
    status, `"queued"` (`RelayEntry["status"]` in `@michaelthielemann/kestrel-contracts`), so a
    client can tell delivery is still pending. This is the setting for a pipeline whose delivery
    work must not run inside the emitting request (rendering image variants on upload, writing a
    login audit) while another subscriber of the same event keeps its head start. Naming a
    pipeline the booted manifest does not know fails boot at `attach()`, naming the module and the
    unknown pipeline(s). `events-direct` has no equivalent key: its delivery is inline by nature.
- `core`: `boot()` fails outright, with a `KestrelBootError` naming the pipeline and the step, for
  shapes it previously let through: a step that writes `result` without declaring `output`,
  `extendsOutput`, `extendsItems` or `binary: true`; an object schema inside one of those that
  declares `properties` without a `required` key (the error also names the JSON path); and a
  step's `extendsOutput` or `extendsItems` that cannot fold onto the active output schema.
  `extendsOutput` now merges into every branch of a `oneOf`/`anyOf` instead of silently collapsing
  it to the extension alone, and `extendsItems` merges into the list-shaped branches of a union and
  falls back to a root merge on the others; the error names the step, which of the two keywords it
  used, the reason, and, where relevant, the earlier step that set the active schema. The reason is
  one of: another type, a type array, a schema without a declared type, an `allOf` schema, `type:
  "object"` together with `oneOf`/`anyOf`/`allOf`, a schema with both `oneOf` and `anyOf`, a union
  with a non-object branch (a boolean branch included), an extension that is itself not an object
  schema, or, for `extendsItems` only, no list-shaped branch in the union, or list items that are
  not an object schema (a plain type or a union) at the root or in a union branch. Every one of
  these previously coerced silently instead of failing boot.
- `core`: `StepDescription` gains `terminalOutput`, the complete shape of `result` when a step ends
  the run with `ctx.done()` — never folded with any other step's `output`, `extendsOutput` or
  `extendsItems`, and never applied to a run that continues past the step. With `validateOutput`
  (always on in `testing/runPipeline`), a step that calls `ctx.done()` without declaring it, or
  whose early result does not match it, fails the run naming the step; a step that declares only
  `terminalOutput` but changes `result` without calling `ctx.done()` fails as well. Boot cannot
  detect a `ctx.done()` call, so a mismatch surfaces only at run time — add `terminalOutput` to
  every step that calls `ctx.done()`, the same schema as `output` when the early result has that
  shape, and declare `writes: ["result?"]` with no `output` for a step that only ever writes
  `result` through `ctx.done()`. Boot fails for `terminalOutput` on a step with no write to
  `result`, and for `terminalOutput` together with a `binary` step in the same pipeline.
- `redirects-default`: `redirects.lookup`, which declared no `output` at all, now describes its hit
  as `terminalOutput`: `{ redirect: { to, status } }`, with `status` narrowed to
  `301 | 302 | 307 | 308` and the schema closed (`additionalProperties: false`). The 200 of a route
  running it already published the page; it now also documents this redirect shape, combined as
  `anyOf`, and generated types become a union.
- `media-default`: `media.upload`'s 200, `oneOf[item, list]`, is now `anyOf` as well: the continuing
  branch (after `events.relay`) carries the item or list result plus `_events`, and the idempotent
  `ctx.done()` paths — which never reach `events.relay` — carry the item or list result alone.
  `_events` is therefore not on every member of the union; a client narrows with `'_events' in res`,
  the only way TypeScript narrows a union like this, not `res._events`. Responses themselves are
  unchanged.
- `media-default`: the step `media.folderItems`, deprecated since 5.4.0 in favour of
  `media.listFolderItems`, is removed; call `media.listFolderItems` instead.
- `revisions-default`: `revisions.reassignAuthor` no longer reads `reassignTo` from the payload or
  the event hand-over itself. It declares `reads: ["verifiedUser"]` and requires a preceding step —
  `authn.verifyUser:reassignTo` or `authn.verifyUser:result.reassignTo` — to verify the target and
  write it there; a pipeline that omits such a step fails to boot naming both steps, instead of
  reassigning to an unverified target at runtime. `examples/minimal`'s `reassignRevisionAuthor` and
  `retryReassignRevisionAuthor` pipelines already run the verify step first.
- `Manifest` gains a required `warnings: BootWarning[]`, the same entries as `kestrel.warnings`, so
  `describe()` and `insights.readManifest` carry the boot warnings. Code that builds a `Manifest` by
  hand adds `warnings: []`.
- `new KestrelBootError(module, reason, code)` now requires a third argument, `code: BootErrorCode`;
  code that constructs a `KestrelBootError` directly (rather than catching one `boot()` throws) adds it.
- `core`: the `./dataflow` export path is gone. `checkDataflowCollecting` was only ever meant for
  `boot()`'s own use; `checkDataflow`, the throwing check pipelines already relied on, remains
  available from the package's main export.
- `core`: `Kestrel.steps` is now typed as the new exported `Steps` interface (`has`, `names`,
  `owner`, `list`, `resolve`) instead of the internal `StepRegistry` class. `register()` and
  `failedToRegister()` are boot-time-only operations with no reader outside `boot()` and are no
  longer part of the public type; code that only read a booted instance's steps is unaffected.
  `RegisteredStep`, already `list()`'s return type, is now exported alongside `Steps`.
- `site-default`'s `site.resolve` and `resolveLinks`, and `delivery-static`'s `delivery.publish` and
  `delivery.exportLlms`, no longer fill an empty localized field from the default locale unless the
  default locale's own values pass the request's filter too (e.g. `status=published`); with no such
  default locale the field stays empty instead of showing a draft value — including a linked page's
  slug (`resolveLinks`, so a link no longer points at a path taken from a draft default locale) and a
  page's title/description in `llms.txt`/`llms-full.txt`. `_translations` now lists only the locales
  that pass the filter themselves. A locale that does not pass the filter itself was already never
  replaced by another one, and still isn't. A page that relied on inheriting a field, a link target's
  slug, or an `llms.txt` title/description from a default locale that is only a draft renders with
  that field, link or entry empty after upgrading; publish the default locale, or fill the field
  directly in each locale, to keep it.
- The same rule now also covers `content-default`'s `content.get`/`content.list` steps: whenever a
  step argument carries a fixed filter (e.g. `content.list:pages?status=published`, already what
  every shipped public read pipeline uses), `_translations` on the response is narrowed to the
  locales that pass that filter too. This is automatic wherever a public read pipeline's step
  argument already names the filter (as `content.list:pages?status=published` does); a consumer
  whose collection pipelines apply a public filter some other way (outside the step argument) must
  move it into the step argument for the narrowing to see it. The narrowing applies to every fixed
  filter alike, not only a public one: an editorial step such as
  `content.list:pages?status=draft` now reports `_translations` as "complete and matching that
  filter" too, not just "complete". `site-default`'s slug-through-the-default-locale lookup now applies the
  full filter, not only its non-localized entries, so a locale whose only route to a path is a
  draft default locale's slug answers 404, the same as an unknown path, instead of 200.
  `delivery.exportLlms` re-checks a source locale's own current values instead of trusting its
  `delivery_publish_status` row being `live` (that row can lag one failed or queued publish behind).
  `delivery.publish` removes a locale's previous static output once it can no longer be published at
  all (no slug of its own or inherited), instead of leaving the old file live at its old path. A step
  argument may no longer combine a fixed filter with `fallback=true`; boot refuses it, naming the
  step and pointing at `site.resolve` — `fallback` is status-unaware by contract, so a filtered read
  must never use it. Every `site@1` implementation must follow the fallback/`_translations` rule now;
  the shared contract suite (`@michaelthielemann/kestrel-contracts/site.contract.test`) tests it.
- **Every media file has exactly one public URL, and the API returns it.** `media-default` stores an
  original under `<prefix><id>/<name>`. `<name>` is fixed at upload: the uploaded file name reduced
  to `[A-Za-z0-9._-]`, with the extension of its content type (`Photo 1.JPG` sent as `image/jpeg` is
  stored as `Photo-1.jpg`). `media.upload`, `media.get`, `media.list` and `media.update` return it as
  `path`, `<publicPath>/<id>/<name>` (new config key `publicPath`, default `"/media"`). Renaming or
  moving an item and renaming a folder change metadata only: no blob moves, and neither the key nor
  `path` changes. `filename` starts out equal to `<name>` and is the display name from then on. A name
  is still unique within its folder; a clash answers 409 with `details.field: "location"` (was
  `"key"`). A name that would collide with a path next to the file — `variants`, the directory of an
  image's variants, or `file`, the download route — is stored with `-upload` appended.
  - `allowedTypes` and `deniedTypes` compare the media type without parameters and ignoring case, so
    `image/svg+xml; charset=utf-8` is denied wherever `image/svg+xml` is.
  - An upload turns its row `ready` only while the row is still `uploading`. When `media.syncPublic`
    abandoned a stalled upload meanwhile, the upload removes what it wrote and answers `TRANSIENT`
    (503); uploading the file again succeeds.
  - A media item in any output no longer carries `key`, `checksum` or `status`.
  - Anonymous callers read media by id only: `media.list` without `ids`, and `media.listFolders`,
    answer 401 to a caller without an identity. Set `anonymousList: "all"` to allow listing the
    library anonymously.
  - Media stored by 5.x are not converted. The start-up key migration is removed, and setup fails when
    a stored item's key is not `<prefix><id>/<name>`, naming the first such item. Start 6.0.0 with an
    empty media store, and with empty `images_variants` and `images_retired` collections: rows written
    before 6.0.0 have no `slot`, so the one-row-per-size rule below does not cover them.
  - New step `media.serve` answers a file at its public URL (`params.id`, `params.name`), cacheable
    for a year as `immutable`; any other name is 404. `media.download` is unchanged.
  - `media.remove` and `media.removeFolder` delete the copy and the blob first and the row last, then
    sweep the item's files once more. A failed blob delete now fails the step with the blob store's
    error; it used to be logged. `media.removeFolder`'s result gains `ids`. Run `images.remove` /
    `images.removeMany` after them, not before.
- **Image variants have their URL before an image can be used.** New step `images.plan` decides each
  size's format, extension, width and height from the original and makes every variant path answer
  with the original's bytes and type until the rendered variant replaces them at the same path. With
  a queue-style delivery module, placing and rendering are separate jobs connected by the new event
  `images.planned`, so an item never waits for a render to become usable; with inline event delivery,
  `images.generate` renders straight into the paths and a size it could not render is placed by
  `images-default`'s background loop right after the request. `images.attach` adds `available` per
  item: `false` while an image still lacks a variant path, and such an item lists no variant; an
  output never names a path without a file. Variant rows gain the state `planned` (never in an
  output); an attached variant carries its final `width`/`height` and `path` in every state. A variant
  that fails keeps answering with the original instead of 404; an image that cannot be decoded gets
  its variant paths the same way, and its rows turn `failed` only once those paths exist. A size
  whose format changes, and a pruned size, keep their old path answering with the original's bytes
  until the item is deleted (new collection `images_retired`); a format change moves the size's own
  row to the new path, so an item never has two rows for one size. `original`-format sizes render
  as JPEG for types other than JPEG, PNG, WebP and AVIF; every render has exactly the planned
  dimensions, and `cover` keeps the declared aspect without enlarging. `images.serve` answers a
  size's current file and every file a format change or a prune retired, and 404 for any other file;
  until a render is at the path, and after a render failed for good, it answers with the original's
  bytes and type (header `x-kestrel-variant: original`) instead of 404. Variants are generated for
  `ready` media items only. `publicPath` must be `/` followed by path segments, without a trailing
  `/`.
  - `images_variants` gains a unique `slot` (`<mediaId>/<size>`) and `images_retired` a unique `slot`
    (`<mediaId>/<file>`): the store keeps at most one row per item and size, so two planners of one
    item at once create one set of rows.
  - A plan or a render re-reads its media item after writing; when the item was deleted meanwhile —
    in this process or another — it removes what it wrote. `images.remove` waits for a plan or a
    render of the same item already running in this process.
  - A missing original is a data problem: `images.plan` and `images.generate` answer `INTERNAL` (500)
    for it instead of `TRANSIENT`, unless the item was deleted meanwhile. The repair pass in
    `images.resume` and the sync job log an item they cannot place or render and go on with the next
    one; `images.resume` resumes a stalled sync job either way. The repair pass reads only media items
    created in the last 24 hours.
  - A failed write of a rendered variant, private or public, counts an attempt like a failed render,
    so a size whose copy cannot be written gives up after `maxAttempts` instead of being retried for
    good.
  - `images-default` raises `media.updated` with `ids` through `events@1` for items it made available,
    after `images.prune`, and for items whose variants changed because a size was added or its spec
    changed. It declares the event in `emits` and uses `events@1` optionally.
  - When a size is added or a size's spec changes (via `images.register` or at start), `images-default`
    notices and its background sync places the new or changed variants of every existing image.
- **Public copies.** `media-default` and `images-default` gain an optional `publicCopy: { prefix }`.
  With it, each module keeps a copy of every ready original and every variant path at
  `<prefix><publicPath without the leading "/">/<id>/<name>` and `…/<id>/variants/<size>.<ext>`. The
  copy is written by the step that makes the file visible — upload, variant planning and rendering
  including the background sync job and retries — and removed when the item is deleted. A failed copy
  fails that step like a failed blob write. New steps `media.syncPublic` and `images.syncPublic`
  reconcile the copies with the stored items and add `_publicMedia` / `_publicVariants` to the result;
  `media.syncPublic` also treats an upload stuck longer than the new `uploadStaleAfterMs` (default 15
  minutes) as failed, and `images.syncPublic` plans missing variants and starts a sync job that
  renders unrendered ones. Both syncs page through their rows by id, so rows deleted or added during
  a run never make them skip another, and `images.syncPublic` also reads a file's owner again right
  before it removes the file, so a concurrent upload, plan or delete never costs a live item its copy.
  Setup fails when the copy location overlaps the module's own `prefix`; boot fails
  when `publicCopy` is set and no pipeline runs the module's serve step, or when a pipeline runs a
  `syncPublic` step without `publicCopy`.
- `StepDescription` gains an optional `anonymous: "required"`: the step's output is also published
  without an access check, so every pipeline running it must let an anonymous caller through. With
  `publicCopy`, `media.serve` and `images.serve` declare it. `authz-roles` checks it when attached and
  fails boot, naming the pipeline, the step and the permission anonymous callers lack, or the step
  that requires a signed-in caller. Another `authz@1` provider has to make the same check itself.
  `insights.readManifest`'s output schema follows the new field.
- A binary step result may now set its own `cache-control`; without one, or with an empty one,
  responses stay `no-store`.
  `media.serve` uses it to mark an original `immutable`; `images.serve` keeps `no-store`, because a
  variant path changes content when its render replaces the original's bytes.
- **`delivery-static` no longer handles media.** The `media` option is removed — a config that still
  sets it fails validation — and with it the rewriting of media URLs in rendered output, the copying
  of media into the output prefix and the reads of `media_items` and `images_variants`. Rendered
  output is stored byte for byte. `rewriteMedia`, `MediaMatch`, `MediaConfig` and
  `contentTypeByExtension` are no longer exported from `./impl`. Pages reach media through the URLs the
  API returned; set `publicCopy` on the media modules instead. New option `reservedPaths`: a page, or a
  renderer asset, whose path equals or lies under one of them is not written, and the page's status is
  `error`. Every asset is checked before the page is written, so such a publish leaves the live page
  as it was.
- `blobstore-filesystem` replaces a file atomically (a temporary file in the same directory, then a
  rename), so a reader never sees a partly written file. Keys ending in `.kestrel-tmp` are rejected.
  The temporary name has a fixed length, so a key's last segment may still use the file system's
  whole name limit.
- `examples/minimal` serves `GET /media/:id/:name` and `GET /media/:id/variants/:file` with
  `media.serve` and `images.serve` alone. `authz.require` checks a signed-in caller's roles only, so a
  signed-in user whose roles lack `media.read` was refused a file that is published to everyone.

### Added

- `@michaelthielemann/kestrel-contracts/content-locale`: `satisfiesFilter`, `publishedLocale` and
  `narrowListTranslations` — the shared rule behind the two entries above, for any module that
  builds a public view on top of `content@1`. `satisfiesFilter` decides membership through
  `content.list` itself, so a `Condition` entry (`{ in: [...] }`, `{ ne: ... }`, …) is evaluated
  with the store's own semantics instead of being reimplemented, and never turns into a false
  negative or a thrown error at request time — including when `filter` names a field the type does
  not declare (an internal link to a type outside the filter's model, such as a settings singleton
  with no `status` field, is simply unserved: `resolveLinks` marks it broken, the same as before),
  and when `id` is missing on a multi type, which is `false` rather than "does any document pass".
  `narrowListTranslations` chunks its `in` list at 500 ids, so a page larger than that sends several
  bounded queries per locale instead of one unbounded one. `publishedLocale` reads with `content@1`'s
  own `fallback: true` once more at the default locale too when `fallback` is requested there, so
  `_locales` (the per-field origin map) still comes back the same as a direct `content@1` read would.
- `core`: `resolveResultSchema` (`@michaelthielemann/kestrel/schema`) reports every shape a
  pipeline's `result` can end in: the folded `output`, then each step's distinct `terminalOutput`,
  as one `anyOf`; `kestrel-openapi` publishes a route's 200 through it.
- `insights`: the manifest schema describes `terminalOutput` and `atomicSafe` (the latter was
  missed when `atomicSafe` was introduced). Its schema-valued step-description members are now open
  objects (`{ type: "object", additionalProperties: true }`) instead of a bare `{ type: "object" }`,
  so generated types read them as `{ [key: string]: unknown }`.
- `authz-roles`: the factory step `authz.validateRoles:<path>` reads an array of role names at
  `payload.<path>` and rejects it with 400 `VALIDATION` (unknown names in `details.unknown`) unless
  every entry is a configured role name; an absent value passes. It writes nothing and needs no
  attached instance. `examples/minimal`'s `createUser` and `updateUser` pipelines now run
  `authz.validateRoles:roles` right after `authz.require:users.manage`, so a role name typo no
  longer creates or updates a user silently. A pipeline that omits the step still boots and works
  unchanged — it simply does not validate role names.
- A step may now declare a trailing `?` in `reads`, not only in `writes`: an optional read does not
  require the key to be available at boot, either from an earlier step or from the trigger. Boot
  still rejects a pipeline where a *later* step writes that key, since the read would then always
  see nothing — the same `checkDataflow`/`KestrelBootError` mechanism as an undeclared or
  unsatisfied read, naming the pipeline, the reading step, the writing step and the key.
  `revisions.record` declares `revisionParent?` and `revisions.reportRestore` declares
  `restoreReport?`, closing a gap where both read a context key no `describe()` named.
- `core`: `boot()` returns non-fatal conditions as `kestrel.warnings: BootWarning[]`, in addition to
  logging them through `logger.warn`. `BootWarning` is a discriminated union on `code`; a future
  minor release may add further codes, so code reading `kestrel.warnings` must handle one it does
  not recognize. Two codes ship: `unemitted-event`, for an event trigger whose event no pipeline
  emits via `events.emit` and no module declares in `emits`; and `unwritten-optional-read`, for an
  optional read (`"key?"`) whose key no registered step writes and no trigger provides — almost
  always a typo in the key — naming the pipeline, the step and the key.
- `authn-multi`: the factory step `authn.verifyUser:<path>` looks up the user id at `payload.<path>`
  — a plain path, no fallback between locations — rejects an unknown or inactive one (404
  `NOT_FOUND` / 400 `VALIDATION`), and writes the canonical `{ id, name }` to a new context key,
  `verifiedUser`; a given name, if any, is never trusted. Absent or `null` writes `null`. It
  verifies a user reference generically: `authn.verifyUser:reassignTo` reads `payload.reassignTo`,
  `authn.verifyUser:result.reassignTo` reads `payload.result.reassignTo` (an event hand-over
  shape), and its `input` schema follows the path. It does not check the caller, so an HTTP
  pipeline needs its own `authn.requireUser` and `authz.require` in front of it.
- `Deps` gains `bootStartedAt?: number`, the epoch ms `boot()` captured at its very start, before
  any module's `setup()` ran, and shared by every module's `setup()` call in this boot. Optional,
  so a `Deps` built outside `boot()` still type-checks. `replication-sqlite` and `backup-blobstore`
  declare `before: [persistence@1]` and use this field to judge whether their database or backed-up
  file was created during the current boot (see "Changed" below).
- New package `@michaelthielemann/kestrel-events-direct`: inline event delivery, split out of
  `events-inmemory`. Requires `events@1`, provides the event trigger hook and `events.emit`.
- `@michaelthielemann/kestrel-contracts` gains `defineStepSet`/`stepSets`
  (`contracts/stepSet.ts`): a declared step set names a role (e.g. `events.delivery`), the step
  prefix it governs and the exact steps every provider of that role registers. `AUTHN_STEPS` and
  the new `EVENT_DELIVERY_STEPS` (`events.emit`) are collected in `STEP_SETS`. The generated
  README step tables and the new `docs/step-portability.md` mark every step as portable (a set
  member), beside (under a governed prefix but not a member) or none.
- `@michaelthielemann/kestrel-contracts` gains `EventIdentity`, `EventEnvelope`,
  `withEventIdentity` and the shared `eventDeliveryStepTests` suite (`events.envelope.ts`,
  `events.steps.contract.test.ts`), so `events-direct` and `events-queue` produce and verify the
  same `events.emit` envelope from one implementation.
- `core`: new `boot({ validateOutput })` (default off) and `testing/runPipeline` (always on)
  validate `ctx.result` after every step that writes it against the pipeline's output schema
  folded up to that point (`@michaelthielemann/kestrel/schema`'s new `resolveOutputSchema`,
  subpath-only), failing with the step name and the JSON path on a mismatch. A step whose write is
  declared optional (`result?`) and left `ctx.result` unchanged is skipped. `validateOutput`
  defaults to off, so production pays nothing for it unless a deployment opts in.
- `authz-roles`: two new steps. `authz.describePipelineAccess` writes `result.pipelineAccess`, one
  entry per booted pipeline: `granted` when the caller passes every `authz.require:<perm>` step of
  that pipeline, `denied` when it fails one, `unknown` when the pipeline has none. The decision is
  the one `authz.require` makes, including the `anonymous` grants when the context has no identity,
  so a client can hide what it may not run without a copy of the role table; the answer lists every
  booted pipeline, so the step belongs behind `authn.requireUser`. `authz.listRoles` writes
  `result.roles`, the configured role names in config order; it performs no check of its own and is
  meant to sit behind an `authz.require:<perm>` step, so only callers who may already manage the
  instance learn the role table. `examples/minimal` has a `listRoles` pipeline (`GET /roles`, behind
  `authz.require:users.manage`). `./impl` also exports `requiredPermissions` and `PipelineVerdict`.
- `core`: a module can declare a synchronous `health(instance)` hook, with no I/O, that reads its
  own state instead of the outcome of a call: `{ ok: true, note? }` or
  `{ ok: false, reason, restartRequired }`. `kestrel.health()` aggregates every declaring module
  into `{ ok, restartRequired, modules }`, reachable on the booted `Kestrel` and through
  `Introspection` in `attach()`. `persistence-sqlite` reports the store unusable, with
  `restartRequired: true`, once a rollback has failed; contention is never reported.
  `replication-sqlite` reports a prepared restore as `{ ok: true, note }`, since the instance
  keeps serving until a host restarts it to apply the restore.
- `images-default`: `images.attach` also adds `variantCounts: { done, pending, error, failed }` to a
  media item or list, tallying the effective sizes owned by `images-default`'s own eligibility rule
  (an image, not SVG, not GIF) and size list: a size with no row yet, or a `done` row whose spec is
  outdated, counts as `pending`; a row for a size nobody declares any more is ignored. All zero for a
  non-eligible item, the same as an empty `variants[]`. Declared `required` in `attach`'s
  `extendsItems`, next to `variants`.
- Every event delivery module registers `events.readDeliveryStatus`, answering `{ dead, scope,
  since, lastDeadAt }`: the deliveries the module gave up on. `events/queue` counts its dead-letter
  rows across every process (`scope: "store"`); `events/direct` counts the failed deliveries of the
  process that answers, since it started (`scope: "process"`). `EVENT_DELIVERY_STEPS` lists it next
  to `events.emit` and `events.relay`. A failed delivery never makes `health()` report the instance
  unhealthy.
- `core`: `checkBoot(input, { setup })` (root export) runs every check `boot()` runs and returns
  every problem as data instead of throwing at the first one: `errors: BootProblem[]` (`errors[0]`
  is what `boot()` throws), `warnings: BootWarning[]`, and `notChecked` for a module or pipeline a
  problem it depends on made impossible to check safely. `setup` has no default —
  `setup()`/`attach()`/`teardown()` reach whatever storage the selected modules' config names — and
  is `"none"` (no module code beyond `configSchema`), `"all"`, or `{ only: [...] }` naming the config
  `use` entries allowed to run. `KestrelBootError` gains a `readonly code: BootErrorCode`; codes are
  covered by semver from 6.0.0, `reason` and every message text are not. Per-item loaders
  (`loadModule`, `pipelineFiles`, `loadPipelineFile`) let a caller load a project file by file and
  keep going after one failure.
- A new package, `@michaelthielemann/kestrel-upgrade` (bin `kestrel-upgrade`, commands `check`,
  `fix`, `data`), finds the 5.8 -> 6.0 breaks a project meets, previews a mechanical fix for the
  ones it can edit, asks about the ones a person must decide, offers switching event delivery to
  the queue where the project can support it, and reads a database copy for the checks only stored
  data answers. `fix` shows a unified diff per file and asks `y`/`n`/`d` before writing; without a
  terminal, `--write` needs `--yes` or is refused. Questions are answered over a real
  `node:readline` prompt, from `--answers <file>`, or from `--yes`'s defaults — a question with no
  safe default stays open regardless. It never installs, commits, pushes or reaches the network;
  see `docs/upgrading.md`. It exports a sandbox helper (`@michaelthielemann/kestrel-upgrade/sandbox`)
  that composes with `checkBoot()` for a CI gate, and a plugin API
  (`@michaelthielemann/kestrel-upgrade/plugin`) a host CLI registers its own project loader and
  rules through instead of shipping a second copy of the engine.
- `kestrel-upgrade`'s plugin API, finalized against its first real host: `UpgradePlugin.load()`
  returns `LoadResult` (`{ project?, issues }`), the same shape the built-in loader already has, so a
  partial load failure surfaces as `load/failed` findings instead of losing the rest of the project;
  it also takes a third parameter, `cache: Map<string, unknown>`, shared by every `load()` call within
  one `check`/`fix` invocation (every re-ask round, every edit preview) so a plugin can skip repeating
  an expensive prepare step. `UpgradePlugin` gains `overrides` (replaces or disables a built-in rule
  by id, reported as `plugin/rule-replaced`/`plugin/rule-disabled`; two plugins claiming the same id
  is a load error), `ownsPackages` (package names the built-in dependency rules never read or edit,
  even under this repo's own npm scope), and `locateSteps`/`locateModelFields` (locates a pipeline's
  step array or a content type's fields object literal directly, for a project layout the built-in
  search does not recognize; `RuleContext` carries the active plugin's own locators to
  `pipelines/verified-user` and `model/underscore-field`). Version detection
  (`mixedMajors`, `deps/kestrel-range`) now checks this repo's own fixed package list instead of a
  name prefix, so a plugin's own package is never mistaken for one of this repo's own. The edit,
  verify and all-or-nothing combine primitives (`applyEdits`, `verifiesAfterEdit`,
  `combineEditParts`), plus the AST reading primitives a locator is written with, are published from
  a new `@michaelthielemann/kestrel-upgrade/codemods` export.
- `kestrel-upgrade`'s plugin API gains three more pieces closing gaps found against its first real
  host: `insertStepAfterEmitOutsideGroup` (and `emitStepIsLocatable`) now take the same optional
  `locateSteps` as `insertPipelineStep`/`renameContentField`, threaded from `RuleContext` the same
  way, and both are published from `@michaelthielemann/kestrel-upgrade/codemods` alongside them.
  `--data-report`'s parsed content now lands in a separate `LoadedProject.dataReport`, instead of
  overwriting `LoadedProject.data`, so a plugin's own `load()`-stored data survives a `data`-report
  run (`model/underscore-field` reads its stored counts from `dataReport`). `UpgradePlugin` gains
  `dataModel?(root)`, supplying the typed content model (`DataContentModel`/`DataContentType`/
  `DataContentField`) the `data` command's underscore-field counter needs for a project layout where
  it cannot be read from a `content-default` module's config on `kestrel.config.ts`; the counter
  itself, and the rest of the `data` command, stays SQLite-only either way.
- `kestrel-upgrade`'s plugin API moves from wholesale rule replacement toward hooks the built-in rules
  themselves consult, after a real host's plugin needed to re-implement two of them and missed later
  fixes to both. `LoadedProject` gains `contentModel?: DataContentModel`, which `model/underscore-field`
  (including its orphaned-column warning) reads directly when present, instead of a `content-default`
  module's config on `kestrel.config.ts`; `check`/`fix` derives it from `UpgradePlugin.dataModel` when
  `load()` did not set it directly, so a plugin need only describe its content model once.
  `UpgradePlugin` gains `switchEdits?(ctx, relayPipelines)`, supplying `offer/event-queue`'s switch (its
  edits as the same all-or-nothing parts `combineEditParts` takes, plus deployment markers that forbid
  it) for a project layout where events-direct is not a `kestrel.config.ts` module-list entry; the
  built-in rule keeps every one of its own gates (an open event-payload or emits finding, the boot
  preview, no default when unverified) and only asks the hook for the edits and the markers, so a
  plugin no longer has to replace this rule to support its own layout. `RuleContext` gains `verifyEdits(edits, { pipelines })`, the diffed,
  higher-level form of `previewBoot` (now documented as the low-level one): it folds a boot-preview
  error diff together with whether every named pipeline was actually checked, so a rule cannot mistake
  an unchecked pipeline for a verified one; `offer/event-queue` now verifies its own switch this way.
  `LoadedProject.pipelineFiles` is a list of `{ file, pipelines }` instead of one file per pipeline
  name, so a project layout keeping several pipelines in one file is reported once per file by a rule
  that walks every one, not once per pipeline sharing it. `UpgradePlugin.load()`'s TSDoc documents that
  a cached value in its `cache` parameter must be path-independent, or rebased onto the current
  `scratch` on every call, and that `load()` itself (a config import, a plugin's own prepare step) runs
  unconditionally, before any consent question — `--run-setup` only ever gates a module's own `setup()`.
- `kestrel-upgrade`'s plugin API closes three more gaps a real host's plugin met once it moved onto the
  hooks above. `DataContentModel` gains `file?: string`, the file `model/underscore-field` reads and
  splices a verified-zero-count rename into; `LoadedProject.configFile` (previously always the target,
  even for a plugin whose content model lives elsewhere) is used when absent, so the rename is auto
  again instead of manual for such a project. `replaceModuleListEntry` (and its
  `ReplaceModuleEntryOptions`) is published from `@michaelthielemann/kestrel-upgrade/codemods`, so a
  plugin's own `switchEdits` can build a hand-written-module-list switch without reimplementing it.
  `locateSteps` and `locateModelFields` are additive, not a replacement: previously supplying either
  one to `insertPipelineStep`, `insertStepAfterEmitOutsideGroup` or `renameContentField` disabled the
  built-in search entirely, even for a pipeline or type the locator itself had nothing to say about;
  now an empty result from `locateSteps`, or `undefined` from `locateModelFields`, falls back to the
  exact built-in search for that target, so a plugin's locator only needs to answer for the layouts it
  actually recognizes.

- `events-queue` coalesces: an event whose data carries a string `coalesceKey` is queued at most
  once per subscribed pipeline and key while an earlier row of that key has not started; a claim,
  by the worker, a lane's own loop or the relay, clears the key so a fresh event with the same key
  can be enqueued again once that row is running. A key found on some other, non-pending row (for
  example one a pre-6.0 process claimed without knowing the column) is cleared and the row written,
  instead of the event being silently dropped.
- `events-queue` runs named lanes: `lanes: { "<lane>": ["<pipeline>", …] }` gives each lane its own
  worker loop, which claims and runs one row at a time, retrying at once rather than waiting
  `pollMs` when it loses a claim race to another process; a claim that instead fails outright (a
  persistence error) is logged and waits `pollMs`, never spinning. A due row of one lane never
  waits for a row of another lane or of the main loop (the implicit lane for every pipeline `lanes`
  does not name), and the relay never claims a lane row. Each lane's claim also reclaims that
  lane's own expired locks, so a crashed process's row is retried by its own lane without waiting
  for the main loop. The main loop re-scans, at most every 30 seconds in every process and again at
  once in the process that served it right after `events.retryDead`, for a lane it does not know of
  still holding a row, and starts that lane's loop; a lane found this way keeps its loop across that
  process's own later `stopWorker`/`startWorker` pairs too, so a lane dropped from the config (or a
  retried dead row of one) never strands its rows.
  `events.readQueueStatus` reports every lane this process currently knows of — configured, or
  found holding a row — with `pending`, `running` and `oldestPendingAt` under `lanes`.

### Changed

- `replication-sqlite`: `setup()` no longer silently skips restoring the database when the file
  already exists. When `restoreOnStart` is set and the file was not just restored from a pending
  marker or automatic restore in this same `setup()` call, `setup()` now checks whether the file
  was created during the current boot while the replica holds a restore point (judged against
  `Deps.bootStartedAt`, with a local table-count fallback where the file system reports no birth
  time) and fails naming the file and its `-wal`/`-shm` siblings if so, telling the operator to
  move them aside and start again — the shape of a misordered module list that would otherwise
  start from an empty database. A file just restored by `backup-blobstore` configured on the same
  file is recognized through a small sidecar file, `<file>.restored-at`, and skipped without either
  module naming the other. A birth time is treated as unavailable, not as a false alarm, both when
  the file system reports none and when it reports one identical to the change time (the signature
  of a file system that fakes birth time from change time). The blobstore is asked whether a
  restore point exists only for a file that already looks fresh (or whose birth time is
  unavailable); an old file is never checked against the blobstore at all, and a blobstore failure
  only fails the boot for a file that already looked fresh. Every other skip is now logged with its
  reason, where previously it was silent.
- `backup-blobstore`: `setup()` gets the same check as `replication-sqlite` — including the shared
  `<file>.restored-at` sidecar and the "move aside" wording — minus the table-count fallback, since
  the backed-up file is not necessarily SQLite; an unavailable birth time is only logged, not failed.
- A `reassignTo` value in `authn.verifyUser`'s request body or event hand-over no longer requires a
  `name` alongside `id`, and also accepts a bare user id string.
- `authn-single` and `authn-multi` share one behavioural test suite for the five steps both
  register (`login`, `identifyUser`, `requireUser`, `loadIdentity`, `logout`), also run against a
  new in-memory `authn@1` fake, so the three stay in lockstep.
- `revisions.read`/`restore`/`label` are now pinned to reject a revision id that belongs to another
  document or collection, and `images.serve`/`images.read` to never return another media item's
  variant for a matching size name.
- `persistence-sqlite`, `site-default`: `createOne`/`findOne`/`updateOne` now declare
  `output: { type: "object" }`; `site.resolveLinks` restates the `_links` field as its own
  `extendsOutput`, alongside `site.resolve`'s existing `output`.
- `openapi`: the fold that derives a pipeline's response schema from its steps' `describe().output`
  moved into `@michaelthielemann/kestrel/schema` (`resolveOutputSchema`, subpath-only); the
  generated OpenAPI document is unchanged except for one route's `required` array order (the
  `resolvePage` route in `examples/minimal`, now folded through a merge instead of passed through
  unchanged — same fields, alphabetical order).
- Every object schema in a step's `output`, `extendsOutput` or `extendsItems` now declares
  `required`, listing exactly the properties the step always returns. Responses are unchanged — the
  underlying data was always there — but the generated OpenAPI document now describes them
  precisely: a consumer's generated types stop marking an always-present field as optional (media
  item lists, folder listings, delivery, replication and link/reference reports, among others).

### Fixed

- `authz-roles`: a caller whose role claim is `constructor`, `toString`, `valueOf`,
  `hasOwnProperty`, `__proto__` or another `Object.prototype` key no longer trips an inherited,
  non-array value and a 500; role lookups go through a `Map`, not a plain object index, in both
  `authz.can`/`authz.require` and `authz.describePipelineAccess`.
- `events-queue`: an instance with no event trigger anywhere in the manifest now installs an empty
  delivery table at `setup()` instead of leaving delivery uninstalled, so `events.emit` drops the
  event instead of writing a row with no pipeline that nothing could ever fan out or process.
- `kestrel-upgrade`: a scratch copy that failed partway through (copying a file, symlinking
  `node_modules`) leaked its own temp directory — it was already tracked for signal-based cleanup, but
  nothing removed it on a normal, non-signal failure. `createScratchCopy` now removes and untracks its
  own partial copy before rethrowing.
- `kestrel-upgrade`: `check`/`fix` remapped every finding's and edit's `file` from the scratch copy back
  to the project root unconditionally, corrupting a path that was never inside the scratch copy to
  begin with — `DataContentModel.file` (always a project-root path, since `dataModel(root)` only ever
  receives the real root) and a path reached through a symlinked `node_modules` package resolving
  outside it. For a project root that is not a sibling of the scratch dir at the same depth, the
  corrupted path made `verifyAndApply` find nothing to read, downgrading an otherwise-verified
  `model/underscore-field` rename to manual. Only a path that resolves (following symlinks) to inside
  the scratch dir is remapped now; every other path reaches the report unchanged.

## 5.8.1 – 2026-09-22

### Fixed

- `replication-sqlite`: every restore of a generation with at least one WAL segment produced a
  database that failed with `database disk image is malformed`. The snapshot was written with
  `VACUUM INTO`, which renumbers pages, while the segments carry WAL frames addressed by the live
  file's page numbers. The snapshot is now the main database file with the committed WAL frames
  applied on top, so it shares the page layout of the frames shipped after it. A restore now opens
  the rebuilt file and runs `PRAGMA quick_check` before handing it over; a failure is
  `Err(TRANSIENT)` naming the generation and the point restored, and leaves no file behind.
  Replicas written by earlier versions cannot be restored: purge the prefix so the next
  `replication.sync` starts a fresh generation.

## 5.8.0 – 2026-09-20

### Added

- Deleting a user now decides what happens to what they wrote. `authn.deleteUser` takes an optional
  `reassignTo` (an existing, active user, not the deleted one; 400/404 otherwise, and the user stays),
  answers `{ ok: true, reassignTo: { id, name } | null }` and travels in the `user.deleted` payload
  when the event is emitted with `?with=result`.
- New step `revisions.reassignAuthor` in `revisions-default`: it rewrites the author of every
  revision of one user, either to another user or, without a target, to the anonymous author
  `{ id: null, name: null }`; content, snapshots, count and order stay untouched. The capability sits
  on the module instance, not in `revisions@1` — that contract is published and therefore frozen, so
  it grows the way `authn/multi` offers user administration beside `authn@1`.
- New steps `audit.anonymize` (clears `identityId` and every param naming one user; the event and its
  time stay, and an entry is never moved to another user) and `audit.prune` with the new config key
  `retentionDays` in `audit-persistence`.
- `examples/minimal` wires both: two pipelines on the event `user.deleted`
  (`reassignRevisionAuthor`, `anonymizeAuditUser`), the admin routes
  `POST /admin/users/:id/revisions/reassign` and `POST /admin/users/:id/audit/anonymize` to re-run a
  failed one (both steps are idempotent), a nightly `pruneAudit` cron and `retentionDays: 365`.
  `docs/api.md` gained a "Personal data" section listing what is stored where and how it disappears.

### Changed

- `content-default`: the README now states how a consumer-defined field type reaches the backend —
  declared as the `content/default` type it is stored as, its value shape enforced by a `validate@1`
  provider through `validate.check:<type>.<field>` before `content.create/update/set`, which answers
  `VALIDATION` (400) with `details.fields` naming the field, localized fields included. The module
  keeps its closed field type set; no config or contract change was needed. Tests cover the boot of
  such a resolved model, the rejection of a model that still names the custom type, and valid,
  invalid, localized, absent and `null` values.
- Engines: every package (and the root workspace) now requires Node `>=22.18.0`, the true
  minimum — `.ts` config and pipeline files are loaded through Node's type stripping, which is
  unflagged only from 22.18 onward; `node:sqlite` alone only needed 22.13.
- `revisions@1` `record`: a `save` whose snapshot and status are identical (deep, key-order-independent)
  to the current head's is no longer recorded; the call succeeds and returns the head's summary
  instead. A `restore` is always recorded, and so is the first save after one, since its parent is
  not the head. A skipped (oversized) snapshot never counts as identical, on either side. Both
  `revisions-default` and `testing/fakeRevisions` implement this, and the contract test suite covers
  it.

### Fixed

- `examples/minimal` now documents and tests its bootstrap `admin` password (`kestrel-demo`,
  the same demo password `examples/embedded` documents) instead of shipping an undocumented
  scrypt hash nobody could log in with.

## 5.7.0 – 2026-09-19

### Added

- New contract `revisions@1` (`@michaelthielemann/kestrel-contracts/revisions`) with a contract test
  suite and the in-memory `testing/fakeRevisions` for other packages' tests: an append-only history
  per collection, document and locale. `record` appends a full snapshot and moves the head and
  answers `NOT_FOUND` for a `parentId` outside that history, `list`
  pages it newest first without snapshots and names the head, `read` adds the snapshot, `label`
  names a revision, `prune` applies retention and `remove` drops a document's or one locale's
  history. Importing the contract puts `revisionParent` on the context: the revision the next
  `record` of that run branches from, and `restoreReport` (`RestoreReport`): what a restore of that
  run had to leave out.
- New module `revisions/default` (`@michaelthielemann/kestrel-revisions-default`) providing
  `revisions@1` on `persistence@1`, with `content@1` optional for the default locale. Branching
  follows from `parentId` alone: a save's parent is the head, a save made by a restore is the
  restored revision, which forks the line there — switching branches is restoring that branch's tip
  and saving again. Deliberately no merge. Steps `revisions.record:<collection>` (after
  `content.create`/`content.update`, reads the saved document from the result),
  `revisions.restore:<collection>` (puts the snapshot into `body` and `payload` so the existing
  update chain validates, sanitizes, saves, indexes and publishes it), `revisions.list`,
  `revisions.read`, `revisions.label`, `revisions.prune` (cron), `revisions.remove` and
  `revisions.removeTranslation`.
- `revisions/default` survives a content model that moved on since a snapshot was taken.
  `revisions.restore:<collection>` reads the current field set from the optional `content@1`
  dependency's `model()` and leaves snapshot fields the model no longer has out of the body instead
  of failing the write; fields the model gained after the snapshot stay at their current value. The
  new step `revisions.reportRestore` adds the outcome to the finished result as
  `restore: { revisionId, dropped, missing }`, and `revisions.read` returns the same analysis next to
  the snapshot, so a UI can warn before a restore rather than after. Without `content@1`, or for a
  collection the model does not describe, the snapshot goes over unchanged as before and no report is
  written. Nested structures stay the validator's business: a restored body that fails
  `validate.check:<c>.body` still answers 400 with the validator's own details, and a removed block
  type is a case for a content migration, not for restore.
- `revisions/default` retention: `keep` (50) newest per document and locale plus every revision that
  was ever live (`statusField`/`liveStatuses`), every labelled one, the head, every branch tip and
  every branch point; survivors are re-parented onto their nearest surviving ancestor, so a
  `parentId` chain never breaks. `pruneOnWrite` (true) prunes the written group on every save, the
  `revisions.prune` step does the whole store. A snapshot beyond `maxSnapshotBytes` (1 MiB) is
  recorded as `skipped: true` with a `warn` log line and no content — the save never fails for it,
  only restoring such a revision does (409).
- `examples/minimal`: `GET /admin/pages/:id/revisions`, `GET …/:revisionId`,
  `POST …/:revisionId/restore`, `PATCH …/:revisionId` (label) and a nightly `pruneRevisions` cron;
  listing and reading need `pages.manage`, restoring and labelling `pages.write`. `createPage` and
  `updatePage` record right after the content step, `deletePage` and `deletePageTranslation` drop
  the history with the document or the translation. Restoring emits `page.restored`.

## 5.6.0 – 2026-09-19

### Added

- `images/default`: config `renderTimeoutMs` (default 30000). A render that does not return within
  it is given up on and counts as a normal failed attempt with the error text `render timed out
  after <n>ms`. Previously a hung-but-alive render kept its entry in the in-flight map for good:
  the attempt was never counted, the variant never reached `failed`, and the sync job stopped at
  that image. sharp offers no way to abort a render, so the timed-out render is left to settle in
  the background and its result is dropped rather than written over the recorded failure.
- `images/default`: step `images.retryFailed` (`POST /admin/images/retry-failed` in
  `examples/minimal`, behind `images.manage`). It sets every variant that gave up after
  `maxAttempts` back to `pending` with `attempts: 0` — all of them, or one media item's via
  `params.id`/`payload.id` — and then does the work: one item is regenerated right away
  (`job: null`), all of them start a sync job at the first media item, because a paused job's
  cursor may already have passed the affected ones. Answers `{ variants, media, job }`, `404` for
  an unknown id. Until now only redefining a size or deleting the media item lifted the quarantine.
- `images/default`: `images.readStatus` additionally reports `failed: { variants, recent }` — the
  number of variants that gave up across all sizes (the per-size counts only cover declared sizes)
  and the twenty most recent ones with `mediaId`, `size`, `attempts`, `error` and `updatedAt`, so
  an admin UI can show why they failed. Additive; the per-size `variants` counts are unchanged.

- `core`: every `ConfigVariable` in the manifest (`kestrel.describe()`, `insights.readManifest`)
  carries `value` — the effective value, i.e. what the config sets, otherwise the default, `null`
  when `status` is `missing` — and `redacted`. The value is a JSON snapshot: functions, class
  instances and Buffers become type labels, a `Date` its ISO string, strings beyond 200 characters,
  arrays beyond 20 items and objects beyond 20 keys are truncated with a marker, and nesting deeper
  than five levels or a cycle reads `"[object]"` / `"[circular]"`. Both fields are additive; the
  contract stays `insights@1`.
- `core`: a redacted variable reports `value: null`, `redacted: true` and no `default`. Redaction
  follows the schema (`.describe("secret")`, which now also emits `writeOnly: true` into the
  generated JSON Schema, plus `format: "password"` and `x-secret: true` for a hand-written one), the
  key name (`password`, `secret`, `token`, `credential`, `authorization`, `passphrase`, `salt`,
  `dsn`, connection strings, and `key`/`keys` qualified by `api`, `access`, `private`, `signing`, …;
  a bare `key` stays visible, and numbers and booleans are never redacted by name), a value that is
  a URL carrying `user:password@`, and any redacted ancestor. The same net runs inside a shown
  value, where a nested credential key reads `"[redacted]"`.
- `insights`: `insights.readManifest` declares `value` and `redacted` on a config variable in its
  output schema. The route stays admin-only — the example pipelines guard it with
  `authn.requireUser` and `authz.require:insights.read`.
- `scripts/workspace.test.ts`: walks every package's config schema and fails when a key that reads
  like a credential is not marked secret in the schema.

## 5.5.0 – 2026-09-19

### Breaking

- `examples/minimal`: `DELETE /users/:id` deletes the user for good instead of deactivating them;
  deactivating moved to `POST /users/:id/deactivate`, the counterpart of `POST /users/:id/activate`.
  A consumer that wired `DELETE` to `deactivateUser` keeps its own mapping — the routes live in
  `kestrel.config.ts`, not in the module.

### Added

- `authn-multi`: the steps `authn.updateUser` (`params.id`, body `{ username?, roles? }`, answers the
  user) and `authn.deleteUser` (`params.id`, answers `{ ok: true }`), plus the methods `updateUser`
  and `deleteUser` on the module's `AuthnMulti` interface. A username stays unique (409 `CONFLICT`),
  roles are free non-empty strings, a role change and a deactivation end that user's sessions, a
  delete removes their sessions with them, and nobody can delete themselves (400).
- `authn-multi`: the config `adminPermission` (default `users.manage`) and an optional `authz@1`
  dependency guard the last admin: deactivating, deleting or taking the permission away from the
  last active user who holds it answers 409 `LAST_ADMIN`. Without an authz module nobody is known
  to be an admin and the guard stays silent.
- `examples/minimal`: the pipelines `updateUser` (`PATCH /users/:id`, emits `user.updated`) and
  `deleteUser` (`DELETE /users/:id`, emits `user.deleted`).
- `core`: `RunEndEvent` carries `message` for a run that ended with a status of 400 or above —
  the text the caller received, truncated at 500 characters and never a stack. An unexpected
  `throw` contributes `"<pipeline>/<step>: unexpected <ErrorName>"` only; its own text and stack
  stay in the log.
- `insights`: `stats().recentFailures` is a ring buffer of the last failed runs, newest first,
  with `{ at, runId, pipeline, trigger: { kind, name }, status, ms, code?, step?, message? }`. Its
  size is the new module config `recentFailures` (default 50, `0` turns it off). `insights@1`
  gains the field on `Stats` and the step `insights.readStats` declares it in its output schema.

## 5.4.0 – 2026-09-18

### Breaking

- `core`: the runner checks every successful step against its `describe().writes`, in every
  environment. A changed top-level context key that is not the root of a declared path, or a
  declared path without `?` that is missing afterwards, ends the run as 500 `INTERNAL`
  (`step "<name>" writes "<key>" without declaring it` / `step "<name>" declares writes "<path>"
  but did not write it (declare "<path>?" for a conditional write)`) with the stack in the log and
  `step` in the error body. Module authors mark conditional writes with `?`. Shipped fixes:
  `validate.sanitize` and `validate.sanitizeHtml` (`payload.<field>?`), `redirects.lookup`
  (`result?`), `images.attach` (`result.variants?`).
- `core`: a factory step's `describe(arg)` is called once at registration with the placeholder
  argument `<arg>`; a throw is a `KestrelBootError` naming step and cause instead of a manifest
  entry with `description: null`. `StepManifest.description` is never `null` any more
  (`kestrel.describe()`, `insights.readManifest`).
- `core` (testing): stand-in steps in `testing/runPipeline` register with `writes: ["result?"]`;
  a stand-in that seeds another context key declares it through the new `writes` option.
- `media-default`: `media_items.key` is declared `unique`. Two concurrent uploads of the same
  filename into the same folder end as one item and one `CONFLICT` (409, `details: { collection:
  "media_items", field: "key" }`) instead of two rows over one blob. Migration: existing rows with
  duplicate keys make `ensureCollection` throw at boot naming the key; find them beforehand with
  `SELECT "key", COUNT(*) AS n FROM "media_items" WHERE "key" IS NOT NULL GROUP BY "key" HAVING n > 1;`
  and delete or re-key the surplus rows.
- `media-default`: uploading the same folder, filename and bytes again answers 200 with the item
  that is already stored instead of 409; `media.upload` then ends the pipeline itself, so a
  following `events.emit:media.uploaded` does not run, and for several files in one request `ids`
  lists only the newly stored items. `Media.upload()` on `…/impl` returns `Result<{ item, created }>`.
- `core`: `ConfigVariable.required` is true only when neither the variable nor any ancestor is
  optional or defaulted; the generated config tables and `examples/minimal/manifest.json` change
  accordingly.

### Added

- `core`: modules may declare `emits: readonly string[]` for events they emit from a contract
  method instead of an `events.emit` step; the manifest lists it as `ModuleManifest.emits`.
  `migrations-default` declares `emits: ["migrations.applied"]`. Boot logs a warning (no abort)
  for an event trigger whose event no pipeline emits via `events.emit:<name>` and no module
  declares in `emits`.
- `events-queue` (new package `@michaelthielemann/kestrel-events-queue`, module `events/queue`,
  provides `events@1`, requires `persistence@1`, config all optional: `pollMs` 500, `batch` 20,
  `maxAttempts` 5, `backoffSeconds` `[5, 30, 120, 600]`, `lockTtlSeconds` 300, `retentionDays`
  7): `emit` persists the event in `events_queue` and returns, an in-process worker runs the
  listener pipelines afterwards with retry, backoff and dead-letter; expired locks are reclaimed
  after `lockTtlSeconds`. Steps `events.emit:<name>` (fails 503 `TRANSIENT` when the row cannot
  be written), `events.readQueueStatus`, `events.listDead` (`?limit`), `events.retryDead:all`,
  `events.retryDead:one` (`params.id`), `events.purgeDone`. Alternative to `events-inmemory`,
  never both; delivery is at least once, listener pipelines must be idempotent. The `events@1`
  contract test does not apply to it (it asserts synchronous delivery).
- `media-default`: step `media.listFolderItems`. `media.folderItems` stays registered as a
  deprecated alias with the same behaviour and goes away in the next major version;
  `examples/minimal` uses the new name.
- docs: `pnpm docs:generate` and `docs:check` also write and verify the package table in the
  root `README.md` from every `packages/*/package.json`.
- `core`: `ConfigVariable.status: "set" | "default" | "missing"` (type `ConfigStatus`) next to the
  unchanged boolean `set`; `default` reports the effective default, including one a defaulted
  ancestor supplies. `insights.readManifest`'s schema requires `status`.
- `media-default`: the README documents the three key families (`media/<folder>/<file>` originals,
  `media-variants/<id>/<size>.webp` variants from `images/default`, `site/media/<folder>/<file>.<size>.webp`
  copies published by `delivery-static`) and the idempotent upload.

### Fixed

- `openapi`: the CLI only tolerates a missing `package.json` (`ENOENT`); any other read error
  throws.
- `images-default`: the `whenIdle()` test hook keeps no module-level state.
- `replication-sqlite`: the teardown log says that pending WAL frames stay in the local WAL and
  ship on the next sync.
- core test suite: `describe.scan` fails a `module.ts` it cannot parse instead of skipping it,
  lists the three step-less modules explicitly, and follows helper chains of any depth to
  `ctx.payload`.
- `media-default`: `media.remove` deletes the blob only when no other row points at that key.
- `insights`/`core`: the manifest no longer shows the child of an optional or defaulted config
  object as required and not set.

### Changed

- Lint: `@typescript-eslint/no-unsafe-type-assertion` is an error in every package (tests
  included), so a narrowing `as T` on an `unknown` value can no longer bypass `boundaryCast`. The
  405 assertions across the workspace became typed generics, type guards, narrowing through
  existing checks or `boundaryCast<T>(value, boundary)` at a genuine untyped source (sqlite rows,
  S3 responses, JSON, ajv output, host objects); `core` shares one `isRecord` guard. No
  consumer-visible behaviour change: no new throws on reachable paths, no changed messages or
  return values.

## 5.3.0 – 2026-09-11

- `core`: `kestrel.describe()` answers the static manifest of the booted instance — modules
  with `use`, package version, contracts, config schema (JSON Schema derived from the Zod
  schema) and config variables (path, type, required, default, secret, set; never a value),
  steps with owner, factory flag and description, pipelines with resolved steps, triggers.
  `kestrel.observe(observer)` registers a `RunObserver` (`runStart`, `runEnd`, `stepStart`,
  `stepEnd` with duration, status and outcome) the runner feeds independently of the logger.
  New module lifecycle hook `attach(instance, { describe, observe })`, called once at the end
  of boot; a returned function runs on `stop()`. Config fields holding credentials are marked
  `.describe("secret")` (`authn-multi`, `authn-single`, `blobstore-s3`) so the manifest shows no
  default for them. The core's version in the manifest comes from a `VERSION` constant, so an
  embedded (bundled) instance reports the released number.
- `contracts`: `insights@1` (`manifest()`, `stats()`).
- `insights-default` (new package `@michaelthielemann/kestrel-insights`, config `{}`): provides
  `insights@1`; steps `insights.readManifest` and `insights.readStats` (count, failed = every
  non-ok outcome, errors = 5xx, nearest-rank p50/p95 ms over the last 1000 samples per pipeline
  and per step spec, active runs, uptime, event-triggered runs per event name; `ratelimit`
  stays `[]`). `examples/minimal` wires `GET /admin/insights/manifest` and
  `GET /admin/insights/stats` behind `authz.require:insights.read`.
- `content-default`: step `content.describeModel` answers the parsed model (`locales`,
  `defaultLocale`, `types`); `examples/minimal` serves it as `GET /admin/content/model` to every
  logged-in user.
- `pnpm docs:generate` writes a generated section (config variables, steps, the example's
  pipelines) between `kestrel-docs` markers into every module README and
  `examples/minimal/manifest.json`; `pnpm docs:check` fails CI on drift.
- `images-default`: sharp `^0.35.4` (libvips and libheif advisories).

## 5.2.0 – 2026-09-09

### Breaking

- `core`: `describe().input` and `describe().query` are enforced in production. Before every
  step the runner validates `ctx.body` against `input` and the declared query parameters against
  `query` (on a coerced copy: `"10"` → 10, `"true"` → true, one value → array where declared;
  undeclared query parameters are ignored); a mismatch answers `VALIDATION` 400 with `step` and
  `details.problems` instead of reaching the step (before: dev-only, 500 `INTERNAL`; never in
  production). Body schemas of the shipped modules are closed (`additionalProperties: false`)
  unless a step deliberately takes open objects, so unknown body fields are now rejected.
  `boot({ dev })` and `RunOptions.validateInput` are gone. The `Context` gains `body` and `query`
  (the HTTP body and query separately; `payload` stays their merge); `ContextInput` takes both.
  Module authors: every step that reads `ctx.payload` must declare `input`/`query` — a static
  test in the core's suite fails otherwise — and `testing/runPipeline` runs real steps with
  `modules: [{ module, instance }]`.
- `core`: the package exports a curated list of subpaths instead of `./*`: `.`, `./cast`,
  `./catalogue`, `./context`, `./dataflow`, `./defineConfig`, `./defineContract`,
  `./defineModule`, `./definePipeline`, `./errors`, `./load`, `./logger`, `./result`, `./runner`,
  `./schema`, `./testing/runPipeline`. No longer importable: `./boot` (use `boot` from the root),
  `./cli`, `./registry`, `./sort`, `./triggers/*` and every test file. ESLint now also guards
  `core` (no contract, module or host framework), `contracts` (only the core) and `h3` (no contract
  or module).

- `events@1`: a handler receives a shallowly frozen copy of the emitted data, so one handler can
  no longer change what the next one sees; assigning to it throws inside the handler. Rule 3
  (submodules emit no events) now names its one exception, `migrations.applied`, and the reason.
## 5.1.0 – 2026-09-08

- **breaking** `blobstore@1` is a byte store: `put(key, data, { contentType? })` takes the bytes and
  an optional content-type hint (stored as object metadata by `blobstore-s3`, ignored by
  `blobstore-filesystem`), `get` returns `Uint8Array | null`, `list` returns `{ key, size }`; the
  `Blob` type is gone. The module owning an object knows its type: media from `media_items`,
  images from the variant row's format, delivery from the file extension. `blobstore-filesystem`
  writes no `.meta.json` sidecars any more; the ones earlier versions left under its root are
  ignored by `list` and can be deleted once with `find <root> -name '*.meta.json' -delete`; keys
  ending in `.meta.json` stay rejected.
- `replication-sqlite`: `replication.snapshot` and `replication.prepareRestore` called before the
  first sync of a process no longer ship WAL segments into a `gen/null/` generation (the frames are
  covered by the snapshot the call takes); `replication.listPoints`, retention and restore ignore
  objects under a generation that is not a timestamp, so stray `gen/null/` segments written by
  earlier versions are invisible — delete them from the blobstore by hand.
## 5.0.3 – 2026-09-07

- `core`: `http.proxyHops` (default 1) and `http.trustedHeader`. With `trustProxy` the client address
  is now the `X-Forwarded-For` entry counted `proxyHops` from the right (the end proxies append to)
  instead of the spoofable left end, and a chain shorter than `proxyHops` yields no address; a
  `trustedHeader` names the client outright and a missing header yields no address. Without an
  address `http.allow` refuses the request and `ctx.ip` is absent. `clientIp(req, options)` takes an
  options object (the boolean form still works).
- `h3`: new handler options `proxyHops` and `trustedHeader` next to `trustProxy`;
  `createKestrelHandler` now derives `ctx.ip` through the core's `clientIp()` with the same
  precedence (trusted header, then the `X-Forwarded-For` entry `proxyHops` from the right, then
  the socket peer) instead of h3's left-most `X-Forwarded-For` entry. Behind a proxy that appends
  to the chain, `ratelimit.check` therefore buckets per real client again.
- `ratelimit-memory`: a request without a derivable client address is counted in one shared key
  `"unknown"` per bucket (documented; the behaviour itself is unchanged).

## 5.0.2 – 2026-09-07

5.0.1 was tagged but never published to npm; this release carries both changes.

- `core`: `http.allow` — a list of IPv4/IPv6 addresses or CIDR ranges the standalone HTTP server
  answers at all; every other client gets `403 forbidden` before routing (health and CORS preflight
  included). Empty or absent keeps the server open; the peer address is the socket's, or the first
  `X-Forwarded-For` entry with `http.trustProxy`; IPv4-mapped IPv6 peers are checked as IPv4. An
  entry that is neither an address nor a CIDR range is a boot error naming the entry.
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
