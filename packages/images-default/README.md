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
