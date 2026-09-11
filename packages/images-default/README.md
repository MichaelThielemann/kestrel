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
`maxAttempts` (default 5).
Steps: `images.register` (`VALIDATION` on an empty or malformed list, `CONFLICT` on a config
collision), `images.listSizes`, `images.generate` (id from params/payload/event; `VALIDATION`
without an id, `NOT_FOUND` for an unknown one), `images.sync` (`CONFLICT` while a fresh job runs),
`images.resume` (cron), `images.prune` (`VALIDATION` for a name that is still declared or has no
variants), `images.readStatus`, `images.remove` (`VALIDATION` without an id), `images.removeMany`
(after `media.folderItems`, reads `result.ids`), `images.attach` (adds `variants[]` to `result`),
`images.serve` (binary; `VALIDATION` without id/file, `NOT_FOUND` otherwise), `images.export:<dir>`.
Every step passes a persistence or blobstore failure through unchanged, so a busy database is a
retryable `TRANSIENT` (503).

A variant that keeps failing is retried at most `maxAttempts` times; the last failure sets
`state: "failed"` instead of `"error"`, and sync/resume skip it from then on — `images.readStatus`
counts `failed` next to `done`/`pending`/`error`. `images.serve` no longer hides such a variant
behind the full-size original: a `pending` variant still falls back to the original (with
`x-kestrel-variant: pending`), a `failed` one is `NOT_FOUND` naming the attempt count. Redefining
the size lifts the quarantine and restores the full attempt budget.
Not included: AVIF, request-time resizing, rewriting `src`/`srcset` in delivered HTML.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-images-default` – module `images/default`: provides no contract; requires `blobstore@1`, `persistence@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `sizes` | array | no | – |
| `prefix` | string | no | `"media-variants/"` |
| `publicPath` | string | no | `"/media"` |
| `media` | object | no | `{"collection":"media_items"}` |
| `media.collection` | string | yes | – |
| `chunk` | integer | no | `20` |
| `staleAfterMs` | integer | no | `60000` |
| `maxAttempts` | integer | no | `5` |

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `images.register` | Replace the sizes registered by this instance – code-declared sizes are held in memory, never stored | – | `result` | { sizes: object[] } | object[] | 400 empty list or invalid size definition; 409 a size collides with a config size |
| `images.listSizes` | Effective sizes (defaults/config merged with the sizes registered in this process) | – | `result` | – | object[] | – |
| `images.generate` | Generate variants for one media item (id from params.id or payload.id), or for each id in payload.ids (unknown ids are skipped) | – | `result` | { id?: string, ids?: string[], … } | object \| object | 400 missing media id; 404 media item not found |
| `images.sync` | Start a sync job, or resume a paused/error/stale one | – | `result` | – | { id: string, state: "running" \| "paused" \| "done" \| "error", total: number, done: number, failed: number, cursor: string, startedAt: number, updatedAt: number, finishedAt: number \| null, error: string \| null, … } | 409 a fresh job is already running |
| `images.resume` | Resume a paused/error/stale job, or no-op (for cron) | – | `result` | – | object \| null | – |
| `images.prune` | Delete the variants of sizes that are no longer declared | – | `result` | { sizes: string[] } | { sizes: number, variants: number, … } | 400 missing sizes, or a name is still declared or has no variants |
| `images.readStatus` | Sizes with usage/variant counts, current job, and sizes whose variants are left over from a size the code no longer declares | – | `result` | – | { sizes: object[], job: object \| null, orphaned: object, registrySeen: boolean, … } | – |
| `images.remove` | Delete one media item's variants (blob + rows) | `params.id` | – | – | – | 400 missing id |
| `images.removeMany` | Delete variants for every id in result.ids (from media.folderItems) | `result.ids` | – | – | – | – |
| `images.attach` | Add variants[] to a media item or list (result.id or result.items) | `result` | `result.variants` | – | { variants: object[], … } | – |
| `images.serve` | Binary variant, or the original with x-kestrel-variant: pending while it isn't ready yet | `params.id`, `params.file` | `result` | – | – | 400 missing id or file; 404 media item or size not found, or the variant gave up after maxAttempts |
| `images.export:<arg>` | Copy every done variant to <arg>/<folder>/<filename>.<size>.<ext> | – | `result.variants` | – | { variants: object, … } | – |

Used by 14 of 69 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
