# images/default
One variant per effective size for every raster image in `media-default`: generated on upload,
completed/repaired by a resumable sync job, listed on media metadata, served by path, exportable,
pruned only on explicit request. The original is never touched. Effective sizes = config/default
sizes merged with `images.register`ed ones (a name colliding with a config size is `CONFLICT`);
WebP only.

Sizes are declared in code, so none of them are stored: config sizes come from the config on every
boot and registered sizes live in the process that took them, rebuilt by every `images.register`
call. A host that registers sizes must therefore register them at boot — until it does,
`images.listSizes` and `images.serve` only know the config/default sizes, and `images.readStatus`
reports nothing as orphaned (`registrySeen: false`) because it cannot yet tell a leftover from a
size that has not been registered again yet. Size rows written by earlier versions are deleted once
at setup, with a log line naming the count. `images_variants` is unaffected: variants stay in the
database, and `images.readStatus` reports variants of sizes nobody declares any more under
`orphaned`, which `images.prune` deletes. Config: `sizes` (defaults `thumb 320, small 640, medium 1024, large 1600, xl 2400`, all
`inside`/`webp`/82), `prefix`, `publicPath`, `media.collection`, `chunk`, `staleAfterMs`,
`maxAttempts` (default 5), `renderTimeoutMs` (default 30000).
Steps: `images.register` (`VALIDATION` on an empty or malformed list, `CONFLICT` on a config
collision), `images.listSizes`, `images.generate` (id from params/payload/event; `VALIDATION`
without an id, `NOT_FOUND` for an unknown one), `images.sync` (`CONFLICT` while a fresh job runs),
`images.resume` (cron), `images.retryFailed` (`NOT_FOUND` for an unknown id), `images.prune`
(`VALIDATION` for a name that is still declared or has no variants), `images.readStatus`,
`images.remove` (`VALIDATION` without an id), `images.removeMany` (after `media.folderItems`, reads
`result.ids`), `images.attach` (adds `variants[]` to `result`), `images.serve` (binary;
`VALIDATION` without id/file, `NOT_FOUND` otherwise), `images.export:<dir>`.
Every step passes a persistence or blobstore failure through unchanged, so a busy database is a
retryable `TRANSIENT` (503).
Not included: AVIF, request-time resizing, rewriting `src`/`srcset` in delivered HTML.

## What happens when generation fails or hangs

**A crash mid-render** leaves the variant row at `state: "pending"` with the attempt already
counted, never at a stale `"done"`. The next `images.generate` or sync pass picks it up, and
`images.serve` hands out the full-size original meanwhile (header `x-kestrel-variant: pending`).
A job row whose `updatedAt` is older than `staleAfterMs` counts as abandoned, so `images.sync` and
the `images.resume` cron take it over instead of answering `CONFLICT`.

**A render that hangs** (a pathological image that keeps sharp busy, a blocked file descriptor) is
given up on after `renderTimeoutMs`. sharp cannot be aborted, so the render is left to finish in the
background and its result is dropped: the variant already carries the failed attempt, and writing
the late result would resurrect a variant the admin was told had failed. The timeout counts as a
normal failed attempt with the error text `render timed out after <n>ms`. Without it the render
would hold its slot for good and the sync job would never reach the next image.

**Repeated failure** is bounded by `maxAttempts`: the last failure sets `state: "failed"` instead of
`"error"`, and generate/sync/resume skip the variant from then on, so one broken original cannot
burn the whole budget of the job forever. `images.serve` no longer hides such a variant behind the
original: a `pending` one still falls back to it, a `failed` one is `NOT_FOUND` naming the attempt
count and the error. `images.readStatus` counts `failed` per size next to `done`/`pending`/`error`
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
`@michaelthielemann/kestrel-images-default` – module `images/default`: provides no contract; requires `blobstore@1`, `persistence@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `sizes` | array | no | – |
| `prefix` | string | no | `"media-variants/"` |
| `publicPath` | string | no | `"/media"` |
| `media` | object | no | `{"collection":"media_items"}` |
| `media.collection` | string | no | `"media_items"` |
| `chunk` | integer | no | `20` |
| `staleAfterMs` | integer | no | `60000` |
| `maxAttempts` | integer | no | `5` |
| `renderTimeoutMs` | integer | no | `30000` |

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `images.register` | Replace the sizes registered by this instance – code-declared sizes are held in memory, never stored | – | `result` | { sizes: object[] } | object[] | 400 empty list or invalid size definition; 409 a size collides with a config size |
| `images.listSizes` | Effective sizes (defaults/config merged with the sizes registered in this process) | – | `result` | – | object[] | – |
| `images.generate` | Generate variants for one media item (id from params.id or payload.id), or for each id in payload.ids (unknown ids are skipped) | – | `result` | { id?: string, ids?: string[], … } | object \| object | 400 missing media id; 404 media item not found |
| `images.sync` | Start a sync job, or resume a paused/error/stale one | – | `result` | – | { id: string, state: "running" \| "paused" \| "done" \| "error", total: number, done: number, failed: number, cursor: string, startedAt: number, updatedAt: number, finishedAt: number \| null, error: string \| null, … } | 409 a fresh job is already running |
| `images.resume` | Resume a paused/error/stale job, or no-op (for cron) | – | `result` | – | object \| null | – |
| `images.retryFailed` | Put every variant that gave up after maxAttempts back to pending with a fresh attempt budget – all of them, or one media item's (id from params.id or payload.id) – and start the work that regenerates them | – | `result` | { id?: string } | { variants: number, media: number, job: object \| null, … } | 404 media item not found; 409 images are shutting down |
| `images.prune` | Delete the variants of sizes that are no longer declared | – | `result` | { sizes: string[] } | { sizes: number, variants: number, … } | 400 missing sizes, or a name is still declared or has no variants |
| `images.readStatus` | Sizes with usage/variant counts, current job, the variants that gave up with their last error, and sizes whose variants are left over from a size the code no longer declares | – | `result` | – | { sizes: object[], job: object \| null, orphaned: object, registrySeen: boolean, failed: object, … } | – |
| `images.remove` | Delete one media item's variants (blob + rows) | `params.id` | – | – | – | 400 missing id |
| `images.removeMany` | Delete variants for every id in result.ids (from media.folderItems) | `result.ids` | – | – | – | – |
| `images.attach` | Add variants[] to a media item or list (result.id or result.items) | `result` | `result.variants?` | – | { variants: object[], … } | – |
| `images.serve` | Binary variant, or the original with x-kestrel-variant: pending while it isn't ready yet | `params.id`, `params.file` | `result` | – | – | 400 missing id or file; 404 media item or size not found, or the variant gave up after maxAttempts |
| `images.export:<arg>` | Copy every done variant to <arg>/<folder>/<filename>.<size>.<ext> | – | `result.variants` | – | { variants: object, … } | – |

Used by 15 of 72 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
