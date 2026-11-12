# images/default
One variant per effective size for every eligible image a `media@1` provider — `media-default` —
reports as ready, at its own public URL before it is ever rendered: placed on upload, rendered in the background or inline depending on the
event delivery mode, completed/repaired by a resumable sync job, listed on media metadata, served by
path, exportable, pruned or retired only on explicit request. The original is never touched.
Effective sizes = config/default sizes merged with `images.register`ed ones (a name colliding with a
config size is `CONFLICT`). The default sizes render WebP; a size may set `format: "original"` to
keep the source format (JPEG for a type sharp cannot re-encode as itself, e.g. HEIC or TIFF).

## Reading media through `media@1`

This module requires `media@1` (`@michaelthielemann/kestrel-contracts/media`) and reads media only
through it: whether an item exists and is ready, its type, the type the provider publishes it with,
its size, stored dimensions, folder and display name, and its bytes. It never reads another module's
collection or a storage key of the original. The module's setup wraps the `persistence@1` handle
with `ownedPersistence` before `createImages` ever sees it, so the only handle the implementation
holds reaches `images_sizes`, `images_variants`, `images_jobs`, `images_retired` and `images_hidden` (`COLLECTIONS`),
and any other collection is a wiring error that names this module. Boot fails when no active module provides `media@1`
(`missing-provider`), and a config that still sets the removed `media` option fails its schema.

Readiness is the provider's: an item is live exactly while `file(id)` answers it. When attached, this
module removes the rows, private variants and public copies of every item that has rows here but is
no longer ready (a delete whose `images.remove` never ran, for example after it failed midway), so
such leftovers disappear with the next start in every deployment. The sweep runs in the background
and stops between chunks of 200 items once the module is closed, so a shutdown never waits for it;
the next start picks up what is left. An item that is
not ready — still uploading, failed, or being deleted — is never planned, rendered, served,
exported or counted, and `images.generate` or `images.retryFailed` with its id answers `NOT_FOUND`.
Which types get variants is one rule, `ELIGIBLE` in `generate.ts`: `image/*` except `image/gif` and
`image/*+xml` (SVG and every other XML image type, which a browser would open as a document that can
run script). The module evaluates it with `mediaTypeAllowed` and hands the same filter to the
provider's `scan` and `count`, so both always agree.

## Paths exist before rendering

A size's path, dimensions and format are decided from the *original* — never from the render — the
moment the item is placed: `plannedDimensions` computes the exact width/height an `inside` or
`cover` fit will produce from the oriented original (after EXIF rotation), and the format follows
the size's own `format` (`webp`, or the type's native format for `original`). This is why a variant's
`width`/`height` are already meaningful before any render ran, and why the render always produces
exactly the planned pixels — the client never guesses them.

Placing and rendering are two different pieces of work. New step `images.plan` places every
effective size of one item: it creates the variant row (state `planned`) and, with `publicCopy`
configured, writes the original's own bytes to the variant's public path — only once that write
lands does the row turn `pending` and the item count as available. `images.generate` does the
rendering: it replaces the placeholder (or, in the direct event-delivery mode, renders straight into
the path without ever writing a placeholder first) and turns the row `done`. With a queuing event
delivery module, an upload's placing runs in its own short pipeline (`images.plan`, then
`events.emit:images.planned`) so an item becomes usable without waiting for a render; rendering
subscribes to `images.planned` and can run in its own lane. With inline event delivery,
`images.generate` alone does both in the upload request, and a size it could not render there is
left `planned` and picked up by this module's own background loop right after the request — never
inside it. An original is handed to sharp only when its leading bytes identify it as the media type it is
stored with (`contentMatchesMediaType`), so a file of another format, SVG among them, never reaches a
decoder through a raster type; such an original counts as one sharp cannot decode, and a row whose
original changed its content fails its attempt with `the original's content does not match its media
type <type>`. An image sharp cannot decode gets its rows too (dimensions from the media item, error
`cannot decode`): they stay `planned` until the original's bytes are at every path, and turn
`failed` only then, so such an item becomes available like any other and never lists a path without
a file.

Sizes are declared in code, so none of them are stored: config sizes come from the config on every
boot and registered sizes live in the process that took them, rebuilt by every `images.register`
call. A host that registers sizes must therefore register them at boot — until it does,
`images.listSizes` and `images.serve` only know the config/default sizes, and `images.readStatus`
reports nothing as orphaned (`registrySeen: false`) because it cannot yet tell a leftover from a
size that has not been registered again yet. Size rows written by earlier versions are deleted once
at setup, with a log line naming the count; a variant or retired row without a `slot` (written before
6.0.0) stops setup instead, since this version cannot read it. Whenever the effective size set changes — a new size, or
an existing one with a new width/height/fit/format/quality — this module compares it against the
stored rows and starts its background sync job to place and render the difference on every existing
item, raising `images.variantsChanged` (see below) per chunk it touches. The comparison counts the ready items
`media@1` reports as eligible (`count(ELIGIBLE)`) against the rows of each size, so an image that has
no rows yet — its plan is still queued, or its provider has lost its bytes — also starts that job at
every start until it is placed or deleted; the job then skips it after logging why. The job pages
through `scan(ELIGIBLE)` with the provider's cursor, so a job paused by another process resumes where
it stopped, and its `total`, `done` and `failed` count those eligible ready items only. `images_variants` is otherwise
unaffected by a size change alone: variants stay in the database, and `images.readStatus` reports
variants of sizes nobody declares any more under `orphaned`, which `images.prune` retires (see
below).

Config: `sizes` (defaults `thumb 320, small 640, medium 1024, large 1600, xl 2400`, all
`inside`/`webp`/82), `prefix`, `publicPath` (default `/media`), `publicCopy` (optional `{ prefix }`),
`chunk`, `staleAfterMs`, `maxAttempts` (default 5), `renderTimeoutMs` (default 30000).
Steps: `images.register` (`VALIDATION` on an empty or malformed list, `CONFLICT` on a config
collision), `images.listSizes`, `images.plan` (id from params/payload/event; places without
rendering), `images.generate` (id from params/payload/event; `VALIDATION` without an id, `NOT_FOUND`
for an id `media@1` does not report as ready), `images.sync` (`CONFLICT` while a fresh job runs), `images.resume` (cron: also
places and renders any item still `planned`, or any recent item with no rows at all), `images.retryFailed`
(`NOT_FOUND` for an id `media@1` does not report as ready), `images.prune` (`VALIDATION` for a name that is still declared or
has no variants; retires rather than deletes the path), `images.readStatus`, `images.remove`
(`VALIDATION` without an id), `images.removeMany` (after `media.listFolderItems` or
`media.removeFolder`, reads `result.ids`), `images.attach` (adds `available` and `variants[]`/
`variantCounts` to `result`), `images.serve` (binary; `VALIDATION` without id/file, `NOT_FOUND`
otherwise), `images.syncPublic` (reconciles the public copy tree), `images.export:<dir>` (nests its
counts under their own key in `result`, so running it after `media.export` in one pipeline keeps
that step's counts). Every step passes a persistence or blobstore failure through unchanged, so a
busy database is a retryable `TRANSIENT` (503).

## Public copies

With `publicCopy: { prefix }` configured, every variant's public path also gets a copy at
`<publicCopy.prefix><publicPath without its leading "/">/<id>/variants/<size>.<ext>` (e.g.
`site/media/<id>/variants/thumb.webp`) — the original's bytes until the render replaces them at the
same path, so a static export or a bucket whose `site/*` is served directly always has *something* at every listed
path, never a 404. `images.syncPublic` reconciles that tree: it removes copies (and rows) of items
that are gone, places a ready item missing a size, rewrites a copy that does not match its row, and
removes a foreign file — all restricted to files directly under `<id>/variants/`, never anything
this module did not put there — and starts the sync job when a row still waits for its render. It
decides that an item is gone, or that a file has no owner, by reading that item's rows right before
it removes anything, never from a list it read earlier; it pages through rows by id, so rows it
removes on the way never make it skip others; and after writing a copy it reads the owner again and
removes the copy when the item was deleted meanwhile. Serve the copy tree with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, as
the Node origin does; a placeholder holds the original's bytes under the variant's extension until the
render replaces it. A render's copy takes its `Content-Type` from `publicFormOf` in
`@michaelthielemann/kestrel-contracts/helpers/mediaType`; a placeholder, a retired path and `images.serve`'s
fallback carry the original's `publishedType` from `media@1`, the type its provider serves the
original with itself (`media-default` sends `application/octet-stream` for a name stored as `.bin`),
so the same bytes never reach two paths with two types. The variant URL shares the item's public
directory with the original's: configure `publicPath` and `publicCopy` exactly as on
`media-default`, and give this module a `prefix` other than `media-default`'s (it may lie under it,
such as `media/variants/` under `media/`). Boot fails if the copy tree overlaps this module's own storage
`prefix`, if `publicCopy` is set but no pipeline runs `images.serve`, or if a pipeline runs
`images.syncPublic` without `publicCopy` set.

## Retired paths

A path, once listed, keeps answering until the item itself is deleted — even after the size behind
it stops existing. A format change (`webp` ↔ `original`, or one `original` type to another) retires
the *old* path: a record in `images_retired` remembers it, its copy is overwritten with the
original's bytes, and the size's own row moves to its *new* path and is placed and rendered there.
`images_variants.slot` (`<mediaId>/<size>`) is unique, so an item never has two rows for one size;
changing the format back makes the old file current again instead of keeping it retired. `images.prune` does the same for a
size that is no longer declared at all: retire, overwrite the copy with the original, delete the
private blob and the variant row — the path stays, `images.prune`'s `{ sizes, variants }` counts what
it touched. `images.serve` and the content rule below treat a retired file exactly like a variant row
that never got its render: always the original's bytes and type. This is what lets a page published
before a size or format changed keep working without a republish; only `images.attach`'s own
`variants[]` stops listing the retired path for pages rendered afterwards.

## Hidden items

`images.hideMany` hides the variants of every id in `result.ids`, typically right after
`media.trash` or `media.trashFolder`: its row in `images_hidden` marks it hidden, and its public copies
under `<id>/variants/` — current sizes and retired paths alike — are removed. Until
`images.showMany` (after `media.restore`) lifts the mark, `images.serve` answers 404 for each of its
paths, `images.export:<dir>` leaves its variants out, `images.attach` lists no variants for it and
reports it as not `available`, and nothing writes a public copy for it again: not the placeholder of
a new size, not the end of a render, not a retired path, not `images.syncPublic`, which also removes
any copy of it that it finds. Every writer of a public copy checks the mark before and after it
writes, so a copy written while a hide in another process lands is withdrawn again. Its rows, its
private variants and its renders stay and go on as
usual, so `images.showMany` only writes the copies again, from the stored renders or, where none is
done yet and for a retired path, from the original. A media trash keeps the item ready for
`media@1`, so its variants survive restarts and `images.syncPublic` either way; the hidden mark is
what keeps them off the public paths. The mark goes with the item's variants when it is deleted, and
the start sweeps it away for an item `media@1` no longer has. An id `media@1` does not know is not
marked.

When a trash and a restore of the same item run at the same time, their `images.hideMany` and
`images.showMany` can arrive in the other order than the moves they follow. Both steps therefore also
read `result.trashVersions`, which `media.trash`, `media.trashFolder` and `media.restore` write: the
item's trash version, which rises with every move into or out of the trash. The row in
`images_hidden` keeps the version of the last hide or show, also after a show, and a hide or show
with a lower version leaves the item as it is. So the move that happened last decides, and the
variants end up hidden exactly when the item ended up in the trash. Without `result.trashVersions` (or
through `Images.hide` and `Images.show` without `versions`), each call applies as it comes. An entry
that is not a whole number of at least zero counts as missing.

Both steps read `result.ids`, leave the result as it is, raise no `images.variantsChanged` (the
`media.trashed` and `media.restored` events already mark the pages that show the item) and can run
again without harm. Hiding waits for a placement or render of the item that is under way in this
process; a crash between `media.trash` and `images.hideMany` leaves the variants public until the
pipeline runs again with the same ids. That works because `media.trash` and `media.restore` put an
id that is already trashed or ready into `result.ids` too. Nothing finds such an item on its own,
since `media@1` reports it as ready.

## `images.variantsChanged`

`images-default` raises its own event `images.variantsChanged` (`{ id: null, ids, identity: null,
params: {} }`, at most 200 ids per event) through the optional `events@1` contract — declared in
`emits`, never required — whenever it changes what a page would need to re-render for: an item it
placed (made `available`), the items a size-set change or `images.prune` touched. It never raises
`media.updated`, which belongs to the pipeline that edits a medium; a pipeline that marks the pages
showing a medium (`delivery.markDependents:media`) subscribes to both. A rejected emit (no
subscriber, or a subscriber that throws) is logged with the affected ids and does not undo the
change; without any `events@1` provider nothing is raised at all, since nothing could be
subscribed.

## Behaviour

Concurrent requests to generate variants for the same media item share one render instead of running
it twice; two callers that start a sync job in the same instant share the same start, so only one job
row is ever created. Placing never runs more than four public-copy writes at a time.

Within one process, placing, rendering, `images.remove` and the public-copy sync's writes of one item
run one at a time, so `images.remove` waits for a plan or a render of that item already in progress;
a render stops after the size it is rendering once a remove of its item is waiting. Across processes the
store decides: a plan or a render reads the media item through `media@1` again after its last write
and, when the item stopped being ready meanwhile, removes everything it wrote; a render marks its row `done` only if the row
still has the path and spec it rendered for, and otherwise drops what it wrote at a path the row no
longer has; a placement that finds its row already rendered puts the render back at the path. Two
planners of one item at once end with one row per size.

`available` (on `images.attach`'s output) is `false` for an eligible image that has at least one size
still `planned` (no object at its path yet), `true` once every size has one — including for a
non-eligible item (not an image, SVG, GIF, or any other XML image type such as `image/foo+xml`,
which a browser would open as a document that can run script), which has no variants at all and is
always available.
`variants[]` never lists a `planned` size; `variantCounts` (`{ done, pending, error, failed }`)
counts a `planned` row as `pending` too, alongside a size with no row yet or a `done` row whose spec
no longer matches the effective size; a row for a size nobody declares any more is ignored.

Not included: AVIF, request-time resizing, rewriting `src`/`srcset` in delivered HTML.

## What happens when generation fails or hangs

**A crash mid-render** leaves the variant row at `state: "pending"` with the attempt already
counted, never at a stale `"done"`. The next `images.generate` or sync pass picks it up, and
`images.serve` hands out the full-size original meanwhile (header `x-kestrel-variant: original`).
A job row whose `updatedAt` is older than `staleAfterMs` counts as abandoned, so `images.sync` and
the `images.resume` cron take it over instead of answering `CONFLICT`. The job's counters are
written after each image rather than only at the end of a chunk, so a long-running chunk is never
mistaken for a stalled job by `images.readStatus` or the `staleAfterMs` takeover. `images.resume`
also places and renders any row still stuck at `planned` (a placement that never finished) and any
media item created in the last 24 hours with no rows at all (a generation that never started). An
item it cannot place or render — for instance one its provider reports as ready but whose bytes it
has lost, which `images.plan` and `images.generate` report as `INTERNAL` (`the stored bytes of
media/<id> are missing`) — is logged and skipped, and the
stalled job is resumed regardless. The sync job skips such an item the same way and counts it as
failed; only a `TRANSIENT` failure stops the job, which `images.resume` then resumes.

**A render that hangs** (a pathological image that keeps sharp busy, a blocked file descriptor) is
given up on after `renderTimeoutMs`. sharp gets the same limit, rounded up to whole seconds, and stops
its own processing when it passes; an encoder that reports no progress (AVIF) runs to its end in the
background regardless, and its result is dropped: the variant already carries the failed attempt, and
writing the late result would resurrect a variant the admin was told had failed. The timeout counts as
a normal failed attempt with the error text `render timed out after <n>ms`, and the remaining sizes of
the same item are not rendered in that run; they stay as they are for the next one. Without it the render
would hold its slot for good and the sync job would never reach the next image. A `planned` row
whose render fails this way is left `planned`, not counted as an attempt, and handed to the
background loop to place right after the request.

**Repeated failure** is bounded by `maxAttempts`, and a rendered variant whose private blob or
public copy cannot be written counts as a failed attempt too: the last failure sets `state:
"failed"` instead of `"error"`, and generate/sync/resume skip the variant from then on, so one broken
original cannot burn the whole budget of the job forever. `images.serve` does not hide such a variant behind the
original: it keeps answering with the original's bytes and type, marked `x-kestrel-variant: original`,
exactly like a `pending` one — a variant never 404s once it has been placed.
`images.readStatus` counts `failed` per size next to `done`/`pending`/`error`
and adds `failed: { variants, recent }` — the totals over all sizes plus the twenty most recently
failed variants with `mediaId`, `size`, `attempts`, `error` and `updatedAt`, which is what an admin
UI shows.

**Getting out of it** is `images.retryFailed`: it sets every `failed` variant back to `pending` with
`attempts: 0` — all of them, or one media item's with `params.id`/`payload.id` — and then does the
work. For a single item it regenerates right away and answers `job: null`; for all of them it opens
a sync job that starts at the first media item, because a paused job's cursor may already have
passed the affected ones. It answers `{ variants, media, job }`, and `{ variants: 0, media: 0, job:
null }` when nothing had given up. Redefining a size lifts the quarantine the same way, since a new
spec is new work. There is deliberately **no cancel**: a sync job holds no external resource, every
step it takes is a single idempotent variant write, and it stops by itself at the end of the
library — a cancel would only add a state in which rows are half-written and the next `images.sync`
has to guess whether to trust them. Stopping it is `close()` (teardown), which pauses the job at its
cursor.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-images-default` – module `images/default`: provides no contract; requires `blobstore@1`, `persistence@1`, `media@1`; optional `events@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `sizes` | array | no | – |
| `prefix` | string | no | `"media-variants/"` |
| `publicPath` | string | no | `"/media"` |
| `publicCopy` | object | no | – |
| `publicCopy.prefix` | string | no | – |
| `chunk` | integer | no | `20` |
| `staleAfterMs` | integer | no | `60000` |
| `maxAttempts` | integer | no | `5` |
| `renderTimeoutMs` | integer | no | `30000` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `images.register` | Replace the sizes registered by this instance – code-declared sizes are held in memory, never stored | – | `result` | { sizes: object[] } | object[] | 400 empty list or invalid size definition; 409 a size collides with a config size | – | no |
| `images.listSizes` | Effective sizes (defaults/config merged with the sizes registered in this process) | – | `result` | – | object[] | – | – | no |
| `images.plan` | Decide every effective size's format, extension, dimensions and path for one media item (id from params.id or payload.id), or for each id in payload.ids, and make its public copies answer with the original's bytes; never renders | – | `result` | { id?: string, ids?: string[], … } | object \| object | 400 missing media id | – | no |
| `images.generate` | Generate variants for one media item (id from params.id or payload.id), or for each id in payload.ids (unknown ids are skipped) | – | `result` | { id?: string, ids?: string[], … } | object \| object | 400 missing media id; 404 media item not found or not ready | – | no |
| `images.sync` | Start a sync job, or resume a paused/error/stale one | – | `result` | – | { id: string, state: "running" \| "paused" \| "done" \| "error", total: number, done: number, failed: number, cursor: string, startedAt: number, updatedAt: number, finishedAt: number \| null, error: string \| null, … } | 409 a fresh job is already running | – | no |
| `images.resume` | Place and render any item left unfinished (a repair pass), then resume a paused/error/stale sync job, or no-op (for cron) | – | `result` | – | object \| null | – | – | no |
| `images.retryFailed` | Put every variant that gave up after maxAttempts back to pending with a fresh attempt budget – all of them, or one media item's (id from params.id or payload.id) – and start the work that regenerates them | – | `result` | { id?: string } | { variants: number, media: number, job: object \| null, … } | 404 media item not found or not ready; 409 images are shutting down | – | no |
| `images.prune` | Retire the variants of sizes that are no longer declared: their paths keep answering with the original's bytes until the item is deleted | – | `result` | { sizes: string[] } | { sizes: number, variants: number, … } | 400 missing sizes, or a name is still declared or has no variants | – | no |
| `images.readStatus` | Sizes with usage/variant counts, current job, the variants that gave up with their last error, and sizes whose variants are left over from a size the code no longer declares | – | `result` | – | { sizes: object[], job: object \| null, orphaned: object, registrySeen: boolean, failed: object, … } | – | – | no |
| `images.remove` | Delete one media item's variants and retired paths (blob + rows) | `params.id` | – | – | – | 400 missing id | – | no |
| `images.removeMany` | Delete variants for every id in result.ids (from media.listFolderItems, media.removeFolder or media.purge) | `result.ids` | – | – | – | – | – | no |
| `images.hideMany` | Hide the variants of every id in result.ids (from media.trash or media.trashFolder): their public copies are removed and their paths are neither served, exported nor copied again until images.showMany, while rows and stored variants stay; raises no images.variantsChanged; with result.trashVersions (from the same steps), an id whose variants a later move already showed is left alone | `result.ids`, `result.trashVersions?` | – | – | – | – | – | no |
| `images.showMany` | Show the variants of every id in result.ids again (from media.restore) and write their public copies; raises no images.variantsChanged; with result.trashVersions, an id whose variants a later move already hid stays hidden | `result.ids`, `result.trashVersions?` | – | – | – | – | – | no |
| `images.attach` | Add available, variants[] and variantCounts to a media item or list (result.id or result.items); a variant whose path has no object yet is never listed, and a hidden item lists no variants and is not available | `result` | `result.available?`, `result.variants?`, `result.variantCounts?` | – | { available: boolean, variants: object[], variantCounts: object, … } | – | – | no |
| `images.serve` | The variant at its public URL (params.id, params.file), or the original's bytes when no render is at that path yet; x-kestrel-variant: original marks the fallback | `params.id`, `params.file` | `result` | – | – | 400 missing id or file; 404 media item not found, not ready or hidden, or the file is neither a current nor a retired size | – | no |
| `images.syncPublic` | Reconcile the public copies of every ready item's variants and retired paths with the stored rows: place missing sizes, write missing or mismatched copies, and remove copies of deleted or hidden items and foreign files (adds _publicVariants: { written, removed, planned, missing } to the result) | – | `result._publicVariants` | – | { _publicVariants: object, … } | – | – | no |
| `images.export:<arg>` | Copy every done variant of a ready, not hidden media item to <arg>/<folder>/<filename>.<size>.<ext> | – | `result.variants` | – | { variants: object, … } | – | – | no |

Used by 23 of 109 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
