# Architecture Decisions

The architecture decision log — one file, newest first, each entry recording why a standing decision stands and nothing else.

## How an entry is written

A new entry gets the next `ADR-NNNN` number and goes at the top of the log, above the Index below it,
which is updated to match. An entry's sections, in order: **Status**, **Context** (the problem, without
the answer), **Decision** (what was chosen, as bullets), **Consequences** (the costs and gains that follow
from it), and optionally **Future** (what is deliberately left open). Status is one of: `accepted`;
`accepted (amended — see "Amendment[s]" below)` when a later finding corrects or extends the original
decision without reversing it; `accepted — supersedes <what>` when this entry replaces an earlier
approach outright; `accepted (ratified post-hoc, after <what> had already landed)` for a decision written
up after the fact; or `accepted; revised once after <what>` for a decision whose own text was rewritten
once, with the revision noted inline. An entry is never marked superseded or rejected in place — the
original Decision and Consequences stay as written, and a correction is a new **Amendment** (or
**Addendum**, for added detail that doesn't correct anything) section appended to that same entry, dated
implicitly by its position in the file. Nothing here is ever deleted; a decision that stops applying gets
an Amendment saying so, not a rewrite.

## Index

- [ADR-0029 — A package's eager module-load graph is a boot-order hazard distinct from ADR-0028's reuse rule](#adr-0029--a-packages-eager-module-load-graph-is-a-boot-order-hazard-distinct-from-adr-0028s-reuse-rule)
- [ADR-0028 — Generic storage-driver primitives live in `@kestrel/core`, not `@kestrel/media`](#adr-0028--generic-storage-driver-primitives-live-in-kestrelcore-not-kestrelmedia)
- [ADR-0027 — `normalizeSlugPath` trims each segment, not just the whole string's ends](#adr-0027--normalizeslugpath-trims-each-segment-not-just-the-whole-strings-ends)
- [ADR-0026 — Append-only revisions: every content write gets a history row, unmigrated installs fail loud](#adr-0026--append-only-revisions-every-content-write-gets-a-history-row-unmigrated-installs-fail-loud)
- [ADR-0025 — publish runs become an owned, resumable sequence; resume supersedes, it does not redeliver](#adr-0025--publish-runs-become-an-owned-resumable-sequence-resume-supersedes-it-does-not-redeliver)
- [ADR-0024 — `planPublish` becomes an outbox handler; the `updated` envelope payload gains `before`](#adr-0024--planpublish-becomes-an-outbox-handler-the-updated-envelope-payload-gains-before)
- [ADR-0023 — `mediaCleanup` becomes an outbox handler; media's synthetic writes get a real outbox row](#adr-0023--mediacleanup-becomes-an-outbox-handler-medias-synthetic-writes-get-a-real-outbox-row)
- [ADR-0022 — `reindexRefs` failures are no longer isolated; they retry then dead-letter](#adr-0022--reindexrefs-failures-are-no-longer-isolated-they-retry-then-dead-letter)
- [ADR-0021 — Outbox delivery is at-least-once; handlers must be idempotent](#adr-0021--outbox-delivery-is-at-least-once-handlers-must-be-idempotent)
- [ADR-0020 — The durable event write moved from `emitEvents` into `persistStep`](#adr-0020--the-durable-event-write-moved-from-emitevents-into-persiststep)
- [ADR-0019 — The typed step channel, for real: StepFn returns Effect<void, KestrelError>](#adr-0019--the-typed-step-channel-for-real-stepfn-returns-effectvoid-kestrelerror)
- [ADR-0018 — Gate denials join the tagged channel; richtext gets a write-time brand seam](#adr-0018--gate-denials-join-the-tagged-channel-richtext-gets-a-write-time-brand-seam)
- [ADR-0017 — Error-channel completion: the last legacy shell shape deleted, two additive members](#adr-0017--error-channel-completion-the-last-legacy-shell-shape-deleted-two-additive-members)
- [ADR-0016 — Perf budgets are re-priced by measurement, and re-pricing requires an ADR entry](#adr-0016--perf-budgets-are-re-priced-by-measurement-and-re-pricing-requires-an-adr-entry)
- [ADR-0015 — Documentation is a verified contract, not prose](#adr-0015--documentation-is-a-verified-contract-not-prose)
- [ADR-0014 — Every extension point is a port against the contracts package](#adr-0014--every-extension-point-is-a-port-against-the-contracts-package)
- [ADR-0013 — Publishing owns immutable snapshots; delivery is a derived adapter](#adr-0013--publishing-owns-immutable-snapshots-delivery-is-a-derived-adapter)
- [ADR-0012 — One database file, per-module ownership enforced by an adapter](#adr-0012--one-database-file-per-module-ownership-enforced-by-an-adapter)
- [ADR-0011 — Effect inside, Promises at the boundary](#adr-0011--effect-inside-promises-at-the-boundary)
- [ADR-0010 — Config- and schema-driven pipelines](#adr-0010--config--and-schema-driven-pipelines)
- [ADR-0009 — CMS-managed redirects publish an artifact on save, through a fail-able write effect](#adr-0009--cms-managed-redirects-publish-an-artifact-on-save-through-a-fail-able-write-effect)
- [ADR-0008 — Saving and publishing are two actions, and previewing is neither](#adr-0008--saving-and-publishing-are-two-actions-and-previewing-is-neither)
- [ADR-0007 — A `site` singleton for the site-wide half of the page head](#adr-0007--a-site-singleton-for-the-site-wide-half-of-the-page-head)
- [ADR-0006 — A page picks its layout, and the page owns the `<NuxtLayout>`](#adr-0006--a-page-picks-its-layout-and-the-page-owns-the-nuxtlayout)
- [ADR-0005 — Two scaffolder entry points over one template, and a build-time app-shell guard](#adr-0005--two-scaffolder-entry-points-over-one-template-and-a-build-time-app-shell-guard)
- [ADR-0004 — A real typecheck gate (`pnpm typecheck`)](#adr-0004--a-real-typecheck-gate-pnpm-typecheck)
- [ADR-0003 — Reference integrity: precise invalidation, warned-stale references, unique slugs](#adr-0003--reference-integrity-precise-invalidation-warned-stale-references-unique-slugs)
- [ADR-0002 — Collection-derived DB schema with a runtime sync engine](#adr-0002--collection-derived-db-schema-with-a-runtime-sync-engine)
- [ADR-0001 — Password hashing: native `scrypt`, not an Argon2/bcrypt addon](#adr-0001--password-hashing-native-scrypt-not-an-argon2bcrypt-addon)

## ADR-0029 — A package's eager module-load graph is a boot-order hazard distinct from ADR-0028's reuse rule

**Status:** accepted.

**Context.** Moving `layers/public`'s publish orchestration into `@kestrel/publishing` put
`packages/kestrel-publishing/src/server/pipelines/publish.ts` in that package's own barrel (`src/index.ts`).
Nitro's `01.register-public-pipelines.ts` plugin — an early-numbered layer plugin — imports
`buildPublicPipelines()`, which reaches `buildPublishPipelines()`, inside the same package barrel as
`publisher.ts`. ES module evaluation is eager and whole-graph: importing any export from a package's barrel
executes every top-level statement in every file that barrel re-exports, whether or not the specific import
needed it. `publisher.ts` had a static `import { clearVariants, saveDiscoveredVariants } from
'@kestrel/media'` — and `@kestrel/media`'s own barrel eagerly `buildCollection()`s its `media`/
`media_settings` tables at import time, which needs the field-type registry already seeded. The registry is
seeded by `layers/core`'s auto-discovery Nuxt module at build/config time for genuine build-time consumers,
but a `01.*`-numbered Nitro plugin runs at a different boot phase, ahead of whatever had historically been
the first thing to touch `@kestrel/media` (previously always a `02.*`-or-later plugin). This is a different
failure class from ADR-0028's: that one is about a primitive being reused by two unrelated consumers and
where its code should live; this is about *when* a package's module graph gets evaluated relative to other
boot-order dependencies, regardless of whether the primitive is reused at all. It surfaced as a real
e2e-only failure (`[kestrel] unknown field type "text"`), invisible to every vitest suite, because vitest's
own global test setup seeds field types unconditionally before any test runs — the real app has no such
blanket safety net; boot order is the only thing that saves it.

**Decision.** Two mitigations, not one:

1. **Never let a static import pull a heavier package into an early boot phase's module graph.**
   `publisher.ts`'s `@kestrel/media` need became a dynamic `await import('@kestrel/media')` inside
   `publishFull()` itself — deferred to the first actual publish, long after boot either way. A dedicated
   rail in `test/architecture/layer-edges.test.ts` enforces that no file under
   `packages/kestrel-publishing/src/**` carries a static import of `@kestrel/media`.
2. **Generic, boot-order-sensitive primitives move to `@kestrel/core`**, which has no downstream package
   dependency of its own and is therefore safe to import from any boot phase. `contentTypeFor`/
   `cacheControlFor`/`precompressedEncoding`/`META_KEYS`/`isMetaKey` (needed both by the deploy-output module,
   the earliest phase of all, and by the moving `publisher.ts`) and `pagePathTag`/`translationGroupTag`
   (needed by `page-resolve.ts`, reached by the same early `01.*` plugin) moved to `@kestrel/core`'s
   `static-artifacts.ts` and `data-tags.ts`. This looks like ADR-0028's reuse rule (and satisfies it too),
   but the primary reason is eager-load safety, not code reuse: `@kestrel/core` is the one package
   guaranteed safe to import at any boot phase, a stronger property than "both consumers already depend
   on it."

**`META_KEYS`'s home.** `META_KEYS` (`sitemap.xml`, `robots.txt`, `llms.txt`, `llms-full.txt`,
`redirects.json`) is conceptually publishing vocabulary, not a generic core one — it stays on
`@kestrel/core` for the boot-order reason above, not because it stopped being publishing-domain knowledge.

**Amendment — the plugin-order module.** The filename-sort convention this ADR originally treated as the
only ordering guarantee Nitro plugins have is now superseded, not merely mitigated. `layers/core/modules/
plugin-order` declares the execution order of Kestrel's own plugins as data (`PLUGIN_ORDER`, with
machine-checked `after` dependencies), pushed ahead of Nitro's own directory scan, with a build-time failure
on drift between the declared list and the files on disk. The filename-sort convention is retired for
anything this module governs; it survives only for a consumer's own, still-auto-scanned plugins.

Plugin init order is no longer a hazard: mitigation (2) above already moved every boot-order-sensitive
primitive into `@kestrel/core`, and `@kestrel/media`/`@kestrel/collections`/`@kestrel/publishing`'s barrels
now self-guard the field-type-registry race directly — verified by a repo-wide rail
(`test/architecture/kestrel-discovery.test.ts`) that checks every workspace package's module graph for an
unguarded `buildCollection()` call. **Ruling: `META_KEYS` and the other four static-artifact symbols stay
on `@kestrel/core`**, which has no downstream package dependency and is safe to import from any boot phase
regardless of who controls plugin ordering now.

**Consequences.** The filename-sort convention is enforced for Kestrel's own plugins by the plugin-order
module rather than by lexicographic accident. A package barrel's eager module-load graph remains a real
cross-cutting boot-order surface: any new cross-package static import inside a file reachable from an
early-numbered plugin needs the same check mitigation (1) encodes for `@kestrel/media`.

## ADR-0028 — Generic storage-driver primitives live in `@kestrel/core`, not `@kestrel/media`

**Status:** accepted (ratified post-hoc, after the split had already landed).

**Context.** Extracting `layers/media` into `packages/kestrel-media` moved `layers/core/server/utils/
storage.ts`/`storage.local.ts`/`storage.s3.ts` along with it at first — but `layers/public`'s
static-output deploy (`publisher.ts`'s `outputDriver`) already depended on the SAME `StorageDriver`/
`PutOptions`/`DeleteOptions` interfaces and `createLocalDriver`/`createS3Driver` factories for its own,
unrelated build/publish target. Neither interface nor factory carries any media-specific knowledge — both
take an explicit config object and know nothing about `runtimeConfig.media` or the `media` collection.

**Decision.** Split the file at its real seam: the generic driver contract + implementations
(`StorageDriver`, `PutOptions`, `DeleteOptions`, `createLocalDriver`, `createS3Driver`, `S3DriverOptions`)
moved into `@kestrel/core` (`src/server/utils/storage{,.local,.s3}.ts`) — core infrastructure both media
and public already depend on. `MediaRuntimeConfig`/`mediaRuntimeConfig()`/`useStorageDriver()` — the
media-specific config-reading wiring that CHOOSES and CONFIGURES a driver from the resolved `media`
namespace — stayed in `@kestrel/media`, importing the generic pieces back from `@kestrel/core`.

**Consequences.** `layers/public`'s static-output deploy keeps depending only on `@kestrel/core` (already
its dependency) rather than gaining an unrelated dependency on `@kestrel/media`. `aws4fetch` (the S3
driver's one third-party dependency, already vetted for the media extraction) moved to `@kestrel/core`'s
own `dependencies` — thin, no new supply-chain surface. The general rule this sets for future extractions:
a primitive with zero domain-specific knowledge, reused by more than one unrelated consumer, belongs in
the package both consumers already share — not in whichever domain happened to introduce it first.

## ADR-0027 — `normalizeSlugPath` trims each segment, not just the whole string's ends

**Status:** accepted. `normalizeSlugPath` (`pipeline/core/slug.ts`) trimmed only the raw string's leading/
trailing whitespace before splitting on `/`, so a segment-internal space (e.g. `"! /"`) survived into the
output and normalizing its own output changed it again (`"! /"` → `"/! "` → `"/!"`) — found by the package's
own unseeded `fc.assert` property suite, which is meant to catch exactly this. Fixed by trimming each
segment after the split, restoring the function's stated idempotence; the property test is now seeded
(deterministic) and a fixed `"! /"` example test pins the regression.

## ADR-0026 — Append-only revisions: every content write gets a history row, unmigrated installs fail loud

**Status:** accepted.

**Context.** Content writes had no history: an overwrite or a bad edit was simply gone, with no way to see
what a record looked like a moment ago short of restoring a full DB backup. The current row (the
collection's own table) needed to stay the untouched read model — no new columns, no shape change any
existing reader has to account for — while a parallel, append-only ledger accumulates alongside it.

**Decision.**
- `persist.ts` appends one row to a new `<collection>_revisions` table inside the same `better-sqlite3`
  transaction as the record write itself (mirrors how the outbox envelope already lands atomically with the
  write, ADR-0020) — for `createOne`/`createMany`/`updateOne`/`updateMany`; `deleteMany` is untouched,
  tombstones and rollback are later work. `snapshot` is the full persisted row, JSON-encoded. One
  shape-specific caveat: `updateMany` has no `RETURNING` on its batch UPDATE, so its snapshot is a
  client-side synthesis (`{...before, ...patchValues}`), not a re-read of the stored row; every other shape
  snapshots the real, re-read row.
- Revisions tables are dynamic — one per registered collection, like the collection's own table — compiled
  at runtime and provisioned through the same desired-schema mechanism that provisions every collection
  table (dev auto-sync / `db:migrate`); the desired-schema mechanism is its migration parity.
- **Unmigrated-install consequence, ruled deliberately.** If a `<collection>_revisions` table is missing, the
  write throws — loudly, rolling back the whole transaction — rather than degrading. This is a deliberate
  divergence from ADR-0025's missing-table degrade ruling: the two cases are not the same shape. A degraded
  publish run loses only progress tracking — the publish still happens. A degraded revision write would
  silently skip appending to an append-only ledger while still committing the record change — a silent gap
  in the history that is data-loss class, since a later rollback or rebuild against that ledger would lie
  about what happened. Errors-cheap wins here: fail the write, and let the boot-time schema-drift warning
  name the remedy (`db:migrate`) instead of shipping a silently incomplete history.

**Consequences.** Every content write now costs one INSERT + one `MAX(revision)` read inside its existing
transaction. A collection's revisions table must exist before its first write reaches production —
enforced by the schema layer, not by a fallback, so an operator who skips `db:migrate` after upgrading
gets a hard failure with a named remedy instead of a silently thinner history. `rebuildFromRevisions` can
restore a row from its last revision; before the tombstone amendment below it could not distinguish
"genuinely deleted" from "merely missing" and would resurrect a deleted record.

**Future.** Tombstones and a rollback pipeline, retention with a real per-def `schema_version` (`1` is a
placeholder literal today — no cheap existing collection-def hash was available to stamp instead), and
migration of existing installs are all later work; see Amendments below for the current state.

**Amendments — current state.** Three follow-on changes landed after the original decision:

- **Delete tombstones and rollback.** `deleteOne`/`deleteMany` append a tombstone revision (`tombstone
  INTEGER NOT NULL DEFAULT 0`; a tombstone writes the JSON literal `"null"` for `snapshot`, which stays
  `NOT NULL` at the DB level) in the same transaction as the delete, closing the resurrection gap the
  original decision flagged. `rollback` (`POST /api/<collection>/rollback/<id>`, body `{ revision }`) is a
  default write pipeline that upserts the current row to the target revision's snapshot and appends a fresh
  revision describing that write, reusing `persist.ts`'s own `emitOutbox`/`appendRevision` rather than a
  parallel write path. Its outbox event follows the write unit's `before`, loaded fresh at rollback time:
  `null` (the record was tombstoned) reads as `<collection>.created`, since the record reappears for any
  consumer watching the outbox and this lets `reindexRefs`/`planPublish` treat a restore like a fresh
  create; a non-null `before` reads as the ordinary `<collection>.updated`.
- **Real `schema_version`, upcasting, and retention pruning.** `schemaVersionOf` hashes a collection def's
  structural shape with SHA-256 and stores the first 32 bits as a plain `number` — deterministic across
  processes, fitting the existing `schema_version INTEGER` column. Revision upcasting is a dedicated
  registry local to `revisions.ts` (`registerRevisionUpcast`/`applyRevisionUpcast`), not a reuse of
  `@kestrel/contracts`' `registerUpcast`, because that walker presumes author-assigned sequential versions
  and an unordered 32-bit def-hash cannot offer that guarantee; the dedicated registry instead walks
  explicit `toVersion` edges and terminates only when it lands exactly on the current def's version, with a
  cycle guard. `rollback` and `rebuildFromRevisions` both apply the same strict upcast pass and map an
  unresolved mismatch to the tagged `Quarantined`; `rollback` is more lenient in one respect, running the
  (possibly-upcast) snapshot through `decodeInput` right after and letting a mismatch that happens to decode
  fine pass with a logged warning, since "decodes fine" is only column-shape-accurate. A 32-bit hash
  collision (~2⁻³² per pair) makes the version-equality check true before any registry lookup runs and is
  invisible to the upcast layer — accepted residual risk, not a bug. Retention
  (`KestrelConfig.revisions?: { keep?: number | 'all', maxAgeDays?: number }`, default `{ keep: 'all' }`)
  combines `keep`/`maxAgeDays` as a union of prunability with one absolute protection over both — the
  newest revision is never pruned, which also means a tombstone in that slot is never pruned — and runs off
  an idle outbox tick, bounded and cursor-based, so pruning never delays dispatch and a prune failure never
  crashes the worker loop.
- **Migration for existing installs.** `migrateRevisions` (wrapped by the `db:migrate-revisions` task)
  seeds revision `1` for every row written before append-only revisions existed, across every registered
  collection. It refuses to run without `{ force: true }`, assumes the `<collection>_revisions` tables
  already exist (checked in one sweep before any seeding starts), and only iterates currently registered
  collections. `created_at` is taken from the row's own `updatedAt` rather than migration wall-clock time.
  One transaction per collection, never one spanning the whole run — a failure rolls back only that
  collection's inserts, and a re-run is safe via per-row idempotence.

## ADR-0025 — publish runs become an owned, resumable sequence; resume supersedes, it does not redeliver

**Status:** accepted (amended — see "Amendment" below; the original text argued for redelivery on resume,
which review found unsound once `zz.publish.ts`'s actual boot sequence was accounted for).

**Context.** A publish (`publishInvalidation({ type: 'full' })`, driven by `zz.publish.ts`'s boot run and
reconciler) previously left no durable trace beyond the per-route `publish_status` rows: a process killed
mid-publish had no record of the run itself, and the admin editor had no way to ask "is a publish in
progress right now, and did the last one succeed?" beyond inferring it per-route.

**Decision.**
- A publish run is now an owned, persisted sequence — `command -> snapshot -> delivery -> done` — tracked
  one row per run in a new `publish_runs` table (`packages/kestrel-publishing/src/server/database/publish-runs.ts`), joined
  into the publishing ownership manifest alongside `publish_deps`/`publish_status`. `startPublishRun`
  (`packages/kestrel-publishing/src/server/utils/publish/orchestrator.ts`) updates that row IN PLACE across the sequence —
  never append — so exactly one row exists per run, durable through a crash. `startPublishRun` never throws
  for a delivery failure — it resolves with the outcome recorded as data — so a caller that wants the
  queue's retry-on-failure back (production wiring does) has to turn a `failed` result back into a thrown
  error itself; see `zz.publish.ts`'s `run` callback.
- The delivery step (the actual render+write work) is an injectable port (`PublishDelivery`), so the
  orchestrator itself stays testable without a live Nitro build; production wiring (`zz.publish.ts`) drives
  it through the real `publishInvalidation({ type: 'full' })`, for FULL runs only — the lighter incremental
  (tag) publishes a content/media write triggers stay a direct call, untracked, since those are not the
  "owned sequence" this covers.
- The admin progress read is a pipeline (`publishRuns`, `packages/kestrel-publishing/src/server/pipelines/publish-runs.ts`),
  collection-less and admin-gated exactly like `_outbox/dead` (`resource: '_publish/runs'`) — it reports
  `publish_runs` as-persisted, so a completed or failed run never reads back as `running`. Bounded to the
  newest `PUBLISH_RUNS_RETENTION` rows, matching the retention `startPublishRun` prunes down to.
- Missing-table fallback: a `publish_runs` table that does not exist yet (a not-yet-migrated consumer
  deploy) degrades `startPublishRun` to an UNTRACKED direct delivery with a warning, rather than busy-
  looping the publish queue on a permanent insert failure. `resumePublishRuns` degrades the same way to a
  no-op read (mirrors `publish-status.ts`'s established missing-table resilience).

**Amendment — resume policy: supersede, not redeliver.** The original decision here was redeliver: a run
left `running` after a crash would be redelivered once at the next boot, reasoning that a full-site
regeneration is idempotent so at-least-once redelivery is simpler than manual intervention. This was
unsound against the actual wiring: `zz.publish.ts`'s boot sequence enqueues an unconditional full publish
immediately after resume runs regardless of what resume found, so a crashed run's work is always redone by
the boot run anyway, making a redelivery inside `resumePublishRuns` pure duplication. Worse, it was a real
hazard — `resumePublishRuns` was the only caller besides the queue that ever invoked delivery directly, so
it bypassed the queue's single-flight guard, and a redelivery racing an incremental (tag) publish could
collide over the runtime publisher's shared module-level variant accumulator; and if the redelivery crashed
the same way the original run did, the row would stay `running` forever and the boot enqueue would never
fire — an infinite boot loop making no progress. `resumePublishRuns` now marks each `running` row `status:
failed` with a distinct recorded reason ("process died mid-run; superseded by the boot publish"), with no
delivery invocation at all — a plain, fast DB update that cannot itself crash the process or race the
queue, and always lets the boot enqueue fire. The site itself is still made consistent, by the boot run's
own unconditional full publish, not by resume.

**Consequences.** A crashed full publish now self-heals on the next boot instead of silently staying
half-applied until someone notices — via the guaranteed boot full publish, not via resume redelivering
anything. The queue remains the only automatic caller that ever invokes a delivery; resume never bypasses
its single-flight guard, so there is no accumulator race to reason about there. (The `publish:run` Nitro
task is a documented exception: an operator-triggered manual run that calls `publishFull` directly,
outside the queue, and is not tracked in `publish_runs`.) Incremental (tag) publishes remain entirely
unaffected: no new table traffic, no behavior change.

**Future.** Nothing yet surfaces `publish_runs` in the admin UI itself — the pipeline is the data source a
future badge/progress view would read; no existing component currently polls in-memory queue state that
needed rewiring.

## ADR-0024 — `planPublish` becomes an outbox handler; the `updated` envelope payload gains `before`

**Status:** accepted.

**Context.** `planPublish` was the last of the non-critical after-steps still inline (`zz.publish.ts`'s own
`planPublishStep`, `registerAfterStep({ critical: false })`). Its classification (`classifyWrite`) needs
BOTH the record's prior and current state to detect a path/status change — `pathChanged`/`statusChanged` are
undetectable from `after` alone. As an inline after-step this was free (`ctx.work.events` carried both sides
in memory); as an outbox handler it is not — the envelope is the only thing that outlives the write's own
process, and the `updated` envelope's payload (`emitOutboxForUnit`/`emitMediaOutbox`, both written at
version 1) had only ever carried `after` (`payload = after ?? before`), because no consumer needed `before`
until now. `reindexRefs`/`mediaCleanup` never needed it (identity-only, or `deleted`'s payload = `before`
already).

**Decision.**
- `planPublish` moves to an outbox handler (`packages/kestrel-publishing/src/server/handlers/plan-publish.ts`), registered on
  the `*.created`/`*.updated`/`*.deleted` collection wildcards — content AND media writes both feed it.
  `zz.publish.ts` keeps only the runtime (queue + deps index), the boot publish, and the reconciler; it no
  longer builds or registers an after-step.
- The `updated` envelope payload changes IN PLACE at version 1, at both emitters, to `{ before, after }`
  (both full rows): `emit-events.ts`'s `emitOutboxForUnit` (had both in `unit.before`/`unit.row` already)
  and `media-write.ts`'s `emitMediaOutbox` (its callers now always read the full prior row too — see below).
  `created` stays payload=`after`, `deleted` stays payload=`before`: neither has an "other side" to carry.
  This is an in-place shape change, not a version bump + upcast: pre-release branch, no external consumers,
  outbox rows are transient operational data, not a published wire contract. The
  upcast machinery (`upcastToLatest`) stays reserved for genuinely released event shapes.
- **Amends ADR-0023's "Payload convention."** That entry accepted an identity-minimal `{ id }` "before" for
  `updateAsset`'s alt-edit path specifically because no consumer needed more. `planPublish` now does — not
  a live bug for `media` today (`pathChanged`/`statusChanged` are always false for it regardless, since
  media has neither a `path` nor a `status` column), but a fix for contract uniformity. Both call sites in
  `media-write.ts`'s consumers now pass the real prior row, not identity-only.
- **Defensive fallback.** An `updated` envelope whose payload does not match `{ before, after }` (a row
  written under the pre-change shape) is treated as before-unknown by the handler: `statusChanged` and
  `pathChanged` are both forced `true` (so an unpublished record is never silently read as "no change
  happened"), but `prune` is always suppressed in this branch — the real old `path`/`status` are genuinely
  unrecoverable, so a synthesized prune could target a route that was never this record's. Conservative
  here means non-destructive: a possibly-missing render is safe to catch up later; a wrong prune is not.

**Error semantics.** Same move ADR-0022 already made for `reindexRefs`: `planPublish` throws normally now
instead of being bus-isolated — a failure fails the whole dispatch for that outbox row, which retries up to
the worker's attempt budget and then dead-letters, visibly. Because a retry re-runs every handler registered
for the event, not just the one that failed (`outbox-worker.ts`'s `runHandlers`), a `planPublish` failure on
e.g. `pages.updated` drags `reindexRefs`'s already-succeeded handler for the same envelope along for every
retry too, and vice versa — ADR-0022 already flagged this coupling in advance. Both handlers are idempotent,
so the redundant reruns converge rather than compound.

**Consequences.** A stale (pre-shape) row is a one-time-per-row event: redelivery always re-reads the
current row, and every new `updated` row is written in the new shape from the moment this lands. The
`publishOnSave` glue (previously cached once per boot inside `zz.publish.ts`'s plugin closure) is now read
fresh off `useRuntimeConfig()` on every dispatch — a handler has no boot-time closure to cache it in.

## ADR-0023 — `mediaCleanup` becomes an outbox handler; media's synthetic writes get a real outbox row

**Status:** accepted.

**Context.** `mediaCleanup` was the last of `media`'s two non-critical after-steps still inline (ADR-0022
already moved `reindexRefs`). Its trigger was worse than stale, though: the media library's own write paths
bypass core CRUD entirely and never ran `persist`/`emitEvents`, so they never wrote an outbox row —
`emitMediaWrite` only ever replayed the plain after-step list (`runWriteAfterStepsSync`), synchronously and
in-process. A `mediaCleanup` outbox handler driven only by the generic CRUD `remove()` path would silently
never fire for the media library's own delete. The covered set is every synthetic-write call site that
already called `emitMediaWrite`: `deleteAffected`/`relocateMedia`/`duplicateMedia` (relocate/duplicate/
delete), `updateAsset` (alt-edit), the overwrite branch of the upload pipeline, and `backfillRow`
(derivative-manifest rewrite).

**Decision.** `mediaCleanup` moves to an outbox handler (`packages/kestrel-media/src/server/handlers/media-cleanup.ts`),
registered on the exact `media.deleted` event. To feed it, `media-write.ts` gains `emitMediaOutbox`: every
synthetic write path above now writes a real `EventEnvelope` row into `outbox_content`, in the SAME
`better-sqlite3` transaction as its own row write — the same primitives (`insertOutboxRow`/`nextSequence`)
and the same atomicity argument `persist.ts`'s `emitOutbox` already relies on. `emitMediaWrite` stays,
narrowed to the after-steps that still are plain after-steps (in practice only `planPublish`, since
`writeRedirects` and any extension after-step are no-ops for `media` via their own `when` guard, not because
they are excluded from composition — see `emitMediaWrite`'s TSDoc).

`emitMediaOutbox` takes the caller's own `MediaDb` (the exact object its row write runs against) and
resolves the matching raw connection from that object — never a separately-fetched `useDb()` singleton,
which can legitimately diverge from the write's own db. A ctx-bearing caller (`updateAsset`, the
overwrite-upload path) passes its real `ctx.facts.now`/`correlationId`/`causation` as an explicit, required
`facts` argument; the plain utils with no `ctx` (`deleteAffected`/`relocateMedia`/`duplicateMedia`,
`backfillRow`) pass an explicit `NO_PIPELINE_CTX` brand instead, resolving internally to a fresh
timestamp/id pair — a compile-time-checked opt-out, not an omitted argument. The envelope payload is the
full row wherever the caller already has it in hand for free, and identity-minimal (`{ id }`) elsewhere — a
consumer must re-read current state off its own aggregate regardless, so this only changes how much the
payload saves a consumer, never what it is allowed to assume is authoritative.

**The ADR-0012 ownership exemption.** `emitMediaOutbox`'s raw write into `outbox_content` deliberately
bypasses the per-module ownership guard `module-db.ts` otherwise enforces — content's outbox table can
never legitimately be part of any other module's manifest, so a checked `prepare` has no way to reach it.
The seam reuses `outbox.ts`'s own enforcement-free primitives directly, the same way `persist.ts`'s
`emitOutbox` already does for a real CRUD write. This is the second named ADR-0012 exemption in the media
layer, alongside `findMediaUsagesForMany`'s cross-collection read — `test/architecture/ownership.media.test.ts`
pins that no other file anywhere in `layers/`, `packages/kestrel-core/src`, `packages/kestrel-media/src`,
or `packages/kestrel-publishing/src` reaches a raw-connection escape hatch outside the named
adapter/primitive owners and these two exemptions.

**Consequences.** The media library's own delete/relocate/duplicate/alt-edit/overwrite/backfill paths now
also reach the `*.updated`/`*.deleted` collection wildcards (currently only `reindexRefs`), not just their
own inline cleanup — harmless today (media carries no ref-bearing field), but real going forward. Error
semantics follow ADR-0022: no swallowing, retry then dead-letter, visible in the dead-letter table.
`mediaCleanup`'s idempotency rests on the storage driver's `delete` being a no-op on an already-missing key,
not on any DB-side dedup — the handler holds no state of its own. Storage GC for a plain CRUD delete now
depends on the outbox poller: a process with no `04.outbox-worker` running (a one-shot CLI invocation, a
`nuxt generate` prerender) leaves the deleted row's blobs on disk until a worker process eventually polls —
the media library's OWN `deleteAffected` still deletes its objects inline regardless, so this gap is scoped
to the generic CRUD `remove()` path, not the media library's own UI-driven delete.

## ADR-0022 — `reindexRefs` failures are no longer isolated; they retry then dead-letter

**Status:** accepted.

**Context.** As a `registerAfterStep({ critical: false })` after-step, `reindexRefs` ran isolated: a throw
never blocked or surfaced against the content write, and never retried — the index just stayed stale until
the next successful write or a manual `rebuildRecordRefs`. Moved to an outbox handler, it inherits
ADR-0021's delivery contract instead.

**Decision.** No error swallowing. A `reindexRefs` throw fails the dispatch for that outbox row, which
retries up to the worker's attempt budget and then dead-letters — visible, not silent.

**Consequences.** Handlers for one event share the row's fate: a retry re-runs every handler for that
event, and dead-lettering the row blocks all of them for it — `mediaCleanup`/`planPublish` are also outbox
handlers now (ADR-0023, ADR-0024), so a persistently failing `reindexRefs` re-runs and can ultimately block
those two for the affected record too, one more reason every handler must stay idempotent. A
systematically-failing `reindexRefs` (e.g. a malformed collection registration) shows up as dead-lettered
rows an admin can inspect, where it previously left no trace at all beyond a stale index. The content write
itself is unaffected either way — the handler runs off the critical path, after the write's own transaction
has committed.

## ADR-0021 — Outbox delivery is at-least-once; handlers must be idempotent

**Status:** accepted.

**Context.** Exactly-once delivery would need a single transaction covering both a handler's own writes and
the outbox row's processed marker. `better-sqlite3` transactions are synchronous (`fn` runs to completion
with no suspension); an outbox handler is `Promise`-returning by design (it decodes a payload, builds a
command, and runs a normal — inherently async — pipeline). A synchronous transaction cannot span a
handler's `await`s, so exactly-once as stated is unimplementable for an async handler.

**Decision.** The worker delivers at-least-once: a row is marked processed only after its handler(s)
resolve, in a separate write from whatever the handler itself did. A crash between "handler finished" and
"row marked processed" causes a redelivery of the same envelope on the next poll. `registerOutboxHandler`'s
contract (documented on `OutboxHandler` itself) makes this explicit: handlers must be idempotent, and a
retry re-runs every handler registered for an event, including ones that already succeeded on a prior
attempt — idempotency is a per-handler property, not a per-event one.

**Consequences.** Every outbox handler ships with a per-handler double-delivery test
(`test/architecture/media-cleanup-handler.test.ts`, `plan-publish-handler.test.ts`,
`reindex-refs-handler.test.ts`) precisely because idempotency, not transactional exactly-once, is the
safety net. No handler may assume "this event fires for this aggregate exactly once." Claiming a row for
dispatch is also scoped to a single process: exclusivity against a concurrent (not merely sequential)
redelivery is provided solely by the worker's in-process in-flight guard, not by the row-claim itself;
multi-process outbox workers are unsupported, and a lease column (claimed-by/claimed-until) is the named
upgrade path if that topology is ever needed.

## ADR-0020 — The durable event write moved from `emitEvents` into `persistStep`

**Status:** accepted.

**Context.** The transactional outbox needs the record write and its `EventEnvelope` to land or roll back
together, but `persistStep` and `emitEventsStep` are separate `StepDef`s — one step cannot keep another
step's `db.transaction()` open across the boundary between them.

**Decision.** `persistStep` performs the outbox insert itself, inside the same `db.transaction()` as the
record write (`emit-events.ts`'s `emitOutboxForUnit`, called from `persist.ts`). `emitEventsStep` keeps its
original, narrower job: snapshotting `ctx.work.events` for after-steps, strictly after the write commits.

**Consequences.** The invariant "`emitEvents` runs after `persist`" now guards only that in-memory
after-step snapshot, not event durability — the outbox row is already committed by the time `emitEvents`
runs at all.

## ADR-0019 — The typed step channel, for real: StepFn returns Effect<void, KestrelError>

**Status:** accepted.

**Context.** Earlier passes converted step-body *values* — a step threw a `KestrelError` instead of an h3
`createError` — but the *channel* stayed throw-based: `StepFn = (ctx) => void | Promise<void>`, and
`runner.ts`'s `effectOf` adapted every step's throw/promise into an Effect from the outside, generically,
per driver. That closed the "expected errors are values" gap only partway — a step body still wrote
`throw`, and the Effect wrapping was the runner's doing, not the step's own type. This decision is the
completion: `StepFn` becomes `(ctx) => Effect.Effect<void, KestrelError>`, and every step body that can
fail with a tagged error returns `Effect.fail(...)` from inside its own `Effect.gen`, not a throw the
runner has to catch.

**Decision.**
- **`StepFn`'s signature changes**; `syncStep`/`asyncStep` (`pipeline/types.ts`) both take the new
  Effect-returning `fn` — the two constructors' only remaining difference is the `sync: true` critical-
  section brand, not the shape of `fn`.
- **All ~36 step-body files converted** (`pipeline/steps/*.ts`, every layer's `*/server/pipelines/*.ts`,
  plus a handful of after-steps and two example extensions that also implement `StepDef`): a step with no
  possible `KestrelError` failure wraps its unchanged body in `Effect.sync`; a step with one or more
  `throw new SomeTaggedError(...)` sites becomes an `Effect.gen` that `yield* Effect.fail(...)`s at those
  specific sites — a survivor `createError` (transport-level, or a genuine bug) stays a plain `throw`
  inside the same body and still becomes a defect at the runner's outer boundary, unchanged behavior. An
  `await` becomes `yield* Effect.promise(...)` (bare) or `yield* Effect.tryPromise({try, catch})` when the
  original code inspected the rejection. Shared helper functions (`requireRecordId`, `assertConditions`,
  and others) are now themselves `Effect`-returning, not throwing. Two bridging helpers,
  `fromThrowing`/`fromThrowingAsync`, reclassify a `KestrelError` thrown/rejected by a genuinely external
  call (a nested `runWrite`/`runPipelineSync`) back into a proper `Effect.fail`, used at the two call sites
  that need it, not sprinkled generally.
- **`runner.ts` simplifies**: `stepEffect` calls `step.fn(ctx)` directly (a real Effect now) instead of
  wrapping it through `effectOf`. The old `isThenable`-based sync guard (a step lying about `sync: true` by
  returning a promise) is now `Effect.runSync`'s own native behavior — hitting a genuine async primitive
  inside a `sync`-declared run throws `AsyncFiberException` (ADR-0011's own regression gate pins this),
  which `runSyncEffect` catches into the same guard message as before. `effectOf` survives, narrowed to
  gate evaluators, which still return plain `GateOutcome | Promise<GateOutcome>` — unconverted, out of this
  item's scope.
- **Gate denials join the same channel** — the last tagged-vs-h3 duality in the error path:
  `access-guard.ts` (the Nitro middleware jurisdiction for a URL no pipeline claims) now throws
  `toHttpError(new Unauthorized(...))`/`toHttpError(new Forbidden(...))` instead of building its own
  `createError` — reusing the one edge-map translation instead of hand-duplicating it, since this
  middleware runs outside the pipeline runner and can't go through the real edge route. Status/message
  byte-identical (verified: `access-guard.test.ts`, new).
- **`preview.test.ts`'s duplicated local `KESTREL_ERROR_STATUS` copy is deleted** in favor of importing
  `toHttpError` directly — one real translation, not a second hand-maintained one that had already drifted
  once (missing `Unauthorized` until this pass).

**A real finding, not a design choice: JS `try`/`catch`/`finally` does not observe an Effect failure
crossing a `yield*`.** Verified empirically (a minimal repro against effect@3.22.1) after a converted test
silently swallowed a rewrap: only Effect's own combinators (`Effect.catchAll`, `Effect.catchAllCause`,
`Effect.ensuring`) see a `yield*`ed effect's failure — a surrounding plain `try`/`catch`/`finally` lets it
skip straight past to the step's own boundary. Every step body that needed to intercept or clean up after
a `yield*`ed failure (media-upload's sharp-derive-failure rewrap, the redirects-artifact write's survivor
rewrap, the galleries-secure orphan-reconcile's log-and-continue, auth's hash-slot release) was rewritten
with `Effect.catchAll`/`Effect.ensuring` instead of `try`/`catch`/`finally` once this was found — a plain
`try`/`catch` in a converted body now wraps only a plain synchronous call or a bare, unwrapped `await`
(nothing the step handles specially).

**Consequences.** `grep -rn "throw new" layers/*/server/pipeline/steps layers/*/server/pipelines` inside a
step body's own `Effect.gen` now only finds tagged-error constructions inside `Effect.fail(...)`, never a
bare `throw new SomeTaggedError(...)` — the channel, not just the values, is now real. The one carve-out:
`media-upload.ts`'s two `throw new Conflict(...)` sites live inside `withLock`'s own callback,
a genuinely plain-async function (not an `Effect.gen`) that `fromThrowingAsync` bridges back into the typed
channel from outside — documented in-code at that call site, not a gap in the grep's premise. The
`Effect.runSync` regression gate, `assertCriticalSection`, and the branded `syncStep`/`asyncStep` mechanics
all stayed green throughout
— none of them needed to change, because the critical-section guarantee was always about `Effect.runSync`
hitting a genuine async primitive, which is exactly as true for a step's own `Effect.gen` body as it was
for the runner's external wrapping.

**Future.** The richtext-column-writer brand (ADR-0018) and full static per-field enforcement remain out
of scope, unchanged by this item — this was purely the channel, not a new brand surface.

**Addendum.** `test/architecture/perf-budget.test.ts` now exercises `createOne`/`updateOne` against a
dedicated fixture collection carrying a `richtext` field (the real `pages` fixture has none), so the
sanitize-at-persist seam actually runs inside the measured critical section. Full-suite contention runs
exceeded the original budgets even though isolated runs stayed comfortably inside them — see ADR-0016's
addendum for the re-pricing.

## ADR-0018 — Gate denials join the tagged channel; richtext gets a write-time brand seam

**Status:** accepted.

**Context.** The gate-denial path (`runner.ts`'s `denied`/`refused`) was the last tagged-vs-h3 duality in
the error channel: every step-body failure was a `KestrelError` value by then, but an access/CSRF/
IP-allowlist refusal still built its own h3 `createError` and passed through `toHttpError` untouched
rather than through it. Separately, ADR-0017 deferred the richtext-column-writer brand because `persist.ts`
writes every collection's row through one generic, runtime-typed `db.insert/update(...).values/set(row)`
call — there is no per-field-typed function for a `SanitizedRichtext` brand to attach to without
restructuring that call into per-field typed writers, which is out of proportion to a brand addition on
its own.

**Decision.**
- `runner.ts`'s `denied(detail)` now returns `new Forbidden({ reason: detail })`; `refused(outcome,
  fallback)` returns `Unauthorized` when the gate outcome's `status` is 401, `Forbidden` otherwise —
  collapsing what was previously a `createError({statusCode, statusMessage})` construction with the same
  branching. Both flow through the same `kestrel-error-map.ts` translation every step-thrown
  `KestrelError` already does; no second translation path exists. Status codes are unchanged (401 stays
  401, 403 stays 403) — verified by extending `edge-error-map.test.ts` with two cases that exercise the
  real gate path (missing auth, cross-origin write) through `callPipelineRoute`, not just the step-throw
  path the file already covered.
- **Messages pass `reason` through unprefixed.** `messageFor` does not prefix a `Forbidden`/`Unauthorized`
  message with its tag name — unlike `ValidationFailed`'s and `Conflict`'s style, where the tag prefix adds
  information the bare message lacks. `reason` is already a complete, user-facing sentence at every
  construction site (a gate's own evaluator message, or `auth.ts`'s login-failure text), so a tag prefix
  would only produce noise — e.g. "Authentication required" would become "Unauthorized: Authentication
  required", and the ip-allowlist gate's own message (literally `'Forbidden'`) would become the nonsensical
  "Forbidden: Forbidden". These render directly in the admin UI (`useListRows`/`useEditForm`).
  `edge-error-map.test.ts` pins the three gate-path strings with `toBe`, not `stringContaining`, so a
  regression back to prefixing fails loudly instead of passing a substring check.
- **`GateOutcome.status` is `401 | 403`, not a bare `number`.** `refused()` only ever produces
  `Unauthorized` (401) or `Forbidden` (403) regardless of what a gate evaluator's outcome claims, so the
  type says what the runtime does. A gate wanting a genuinely transport-level status (429 throttle, 503
  unavailable) must throw its own error rather than return a `GateOutcome` — the outcome channel was never
  a general arbitrary-status carrier.
- **Richtext: a write-time re-sanitization seam, not full static enforcement.** `persist.ts` gains
  `brandRichtextColumns(c, values)`, called at every actual `db.insert/update(...)` site (5 of them —
  createOne/createMany's shared `insert` helper, updateOne's singleton and regular branches, updateMany's
  shared patch, and `persistRollbackStep`'s upsert). For every field the collection declares `type:
  'richtext'`, the column's value is run
  through `sanitizeRichtext` again immediately before the write — idempotent for input that already
  passed the field validator's own `.transform(sanitizeRichtext)` (verified: `sanitizeRichtext(x) ===
  sanitizeRichtext(sanitizeRichtext(x))`... more precisely `sanitizeRichtext(once) === once` per
  `core/server/core/sanitize.test.ts`), so no behavior change for correctly-validated input, but no
  unsanitized HTML can reach a richtext column even if some future write path bypassed `decodeInput`.
  Three boundaries are worth naming explicitly. This is not true compile-level enforcement — collections
  are built at *runtime* from a field-def record, not TypeScript generics, so there is no static type that
  names "this key is the richtext one" for a compiler to check against; this is defense-in-depth, not a
  resolution of that honest gap. Only *top-level* richtext fields (their own DB column) go through this
  seam — richtext nested inside a `repeater`/block lives in a JSON column that the field-tree walker
  already sanitizes during validation, and re-sanitizing inside a JSON tree at persist would mean walking
  the block/repeater schema at write time too, a materially bigger change. And writes outside `persist.ts`
  are outside this seam entirely: media's own bypass-CRUD write path (`persist-upload.ts`,
  `storage-relocate.ts`) calls `db.insert`/`db.update` directly, so `brandRichtextColumns` never runs for
  it — not a live hole today (media has no `type: 'richtext'` field), but a real boundary that a future
  richtext field on any bypass-CRUD collection would need its own seam for.
- The typed `StepFn` channel (`Effect.Effect<void, KestrelError>` replacing throw-based step bodies,
  `runner.ts`'s `effectOf` throw-adapter removed) is NOT part of this decision — see Future.

**Consequences.** Every `KestrelError` a request can fail with — from a step body or a gate — now reaches
the client through exactly one translation (`kestrel-error-map.ts`). `runner.ts` no longer imports `h3`'s
`createError` at all. The richtext write seam adds one extra `sanitizeRichtext` call per richtext column
per write (already-sanitized input, so the cost is a re-run of an idempotent, non-DB operation, not a
new query).

**Future.** The typed `StepFn` channel is split out as its own item (see ADR-0019): converting ~36 step
bodies from throw-based `void | Promise<void>` to `Effect.Effect<void, KestrelError>`-returning, and
removing `runner.ts`'s `effectOf` throw-catching adapter, is an architectural change of its own size and
risk class — sized for its own pass with its own review, not folded into this one. True static enforcement
of the richtext (and any other per-field) brand remains contingent on collections becoming statically
typed per field, a materially larger change than either this ADR or the original persist-brand item
anticipated; not scheduled.

## ADR-0017 — Error-channel completion: the last legacy shell shape deleted, two additive members

**Status:** accepted.

**Context.** An earlier pass converted every step-body `createError` it could into a tagged `KestrelError`
value, leaving one temporary exception: `resolve-slug.ts` translated a slug/route conflict back into a
legacy h3 error shape because `crud.ts`'s `create`/`update` were assumed to have a direct caller relying on
it. Auditing the real call graph found none — `crud.ts`'s `create`/`update` are reached in production only
through the pipeline runner (`[...path].ts`'s `toHttpError`), and its own `getOne`/`getSingleton`/`list`
callers never touch the write path. Two other survivors also turned out to be newly convertible once
`Conflict` could carry structured detail: `checkConcurrency`'s and `media-assets`' optimistic-concurrency
409s, and `media-upload`'s duplicate-filename 409, all of which needed a `field`/`value` pair `Conflict`
didn't have room for before.

**Decision.**
- `resolve-slug.ts`'s shell translation is deleted; a route/slug conflict now throws the same `Conflict`/
  `ValidationFailed` values every other step throws, unwrapped via the existing `runCore` helper. No status
  code changes (409/400 unchanged); the message text changes for a direct (non-HTTP) caller, which no
  in-repo consumer parses.
- `Conflict` gains an optional `details` field (`kind: 'duplicate' | 'stale'`), additive only — every
  existing `Conflict` construction keeps compiling unchanged. `checkConcurrency`, `media-assets`'s own
  stale-write check, and `media-upload`'s two duplicate-filename 409s now construct it with `details`
  instead of `createError`. `useMediaUpload.ts` needed no change: the edge already nested a Conflict's
  `data` the same way `ValidationFailed`'s `issues` were, so `err.data?.data?.suggestion`/`existingId`
  resolve identically. Two deliberate wire-message changes come with this, neither consumed anywhere:
  - `media-upload`'s 409 `statusMessage` changes from the bespoke "A file with this name already exists"
    to the edge's generic `Conflict: duplicate storageKey "<key>"` — no admin code reads the message text
    for this path, only `data.suggestion`/`data.existingId`.
  - `media-assets`'s stale-write 409 loses its own "This media item changed since you opened it..."
    wording in favor of the shared stale-`Conflict` message ("This record changed since you opened it...",
    the same text `checkConcurrency` already used) — again unread by any in-repo consumer.
  - The 409 `data` payload for the duplicate-filename UNIQUE-violation race
    (`media-upload.ts`'s `persistUpload` catch) carries just `{ kind: 'duplicate' }`, no `storageKey`,
    `suggestion`, or `existingId` available at that point either — grepped
    `layers/media/app` for any read of `data.storageKey`: none.
- A new `Unauthorized` tag (401) replaces `auth.ts`'s login-failure `createError` — distinct from
  `Forbidden` (403, known identity lacking permission). The admin login page keys off `status === 401`
  already, and its displayed text is a fixed i18n string, not the server's message — no consumer change.
- `requireRecordId` and `read-tooling.ts`'s "translations not enabled" 400 convert to `ValidationFailed`
  (status unchanged); `populate-relations.ts`'s `skipMissing` drops its pre-migration `statusCode === 404`
  branch — nothing on the live populate path produces that shape any more.

**Consequences.** The step/pipeline `createError` survivor list shrinks to 9 files / 14 sites, all
genuinely transport-level (405 method-shape, 413/415/422 payload/content-type, 503 infra availability,
404-by-name lookups `NotFound` can't express, and the one DB-level UNIQUE-violation fallback that cannot
name a single field across two possible source columns without a new brittle message-parsing dependency)
— each carries its own reason, not "the old shape was like that."

**Addendum.** The one deferred UNIQUE-violation fallback (`shared.ts`'s `runCatchingUnique`) is converted
too: the message-parsing dependency this entry flagged is judged acceptable rather than a grave technical
reason to keep the h3 shape. It now reads the failing
column list out of SQLite's own `UNIQUE constraint failed: <table>.<col>, ...` text and resolves it to a
`field`/`value` pair — `path` if the list names it, the sole column if there is only one (a field-level
`.unique()`), else `locale` (every remaining composite index is locale-scoped: translation-group or
singleton-key). Status stays 409; the wire message changes from the fixed, ambiguous "duplicate locale in
translation group, or duplicate path" to the per-field `Conflict: duplicate <field> "<value>"` the edge map
already produced for every other `Conflict` — no in-repo consumer parsed the old text (`crud.collections.test.ts`,
`crud.singleton.test.ts`, `pipeline-writes.test.ts` updated to the tagged shape).

**Future.** The typed `StepFn` channel and the richtext-column-writer brand (needing a per-field-typed
write path the current dynamic `persist` does not have) are out of this item's scope — see ADR-0018 and ADR-0019.

## ADR-0016 — Perf budgets are re-priced by measurement, and re-pricing requires an ADR entry

**Status:** accepted.

**Context.** `test/architecture/perf-budget.test.ts` and `perf-budget.json` pin a p95-millisecond ceiling
per pipeline operation. A ceiling calibrated before a sealed step existed (e.g. `readOne`/`readMany`
gaining `validateOut`, a `select`-schema `safeParse` per row) or before a fixture exercised a real cost
path (e.g. `createOne`/`updateOne` against a collection with no `richtext` field, never running
`persist.ts`'s sanitize-at-persist seam) goes stale silently — isolated runs stay inside budget while
full-suite contention runs fail it.

**Decision.** A budget is re-priced by the file's own documented method: p95 × 1.5 over the max of
repeated full-suite runs, rounded up to a whole even ms. `perf-budget.json` requires its `_adr_*` keys to
reference an entry here rather than restate the justification inline, so a budget's rationale has exactly
one home. Loosening a budget without a corresponding ADR entry is not accepted.

**Consequences.** Every re-priced operation carries the fixed cost of whatever new step or fixture made the
old ceiling wrong; a future step added to a measured path should expect the same recalibration.

**Addendum — the re-priced budgets.** `createOne` moved to 20ms (the sanitize-at-persist seam,
`brandRichtextColumns`, runs on every insert now, not only richtext-bearing ones), `updateOne` to 12ms (the
same seam on the update path), and `readOne`/`readMany` to 4ms/12ms (`validateOut`'s per-row `select`-schema
`safeParse`). `perf-budget.json`'s `_adr_readOut` key is stale — the budget entries are `readOne`/`readMany`,
not `readOut` — and should be split into `_adr_readOne`/`_adr_readMany` the next time that file is touched.

## ADR-0015 — Documentation is a verified contract, not prose

**Status:** accepted.

**Context.** Everything a consumer needs to know is currently prose under `docs/`, written by hand and
checked by nobody. There is no generated API reference and no machine-readable description of the HTTP
surface, so the only way to learn what `definePipeline` accepts, which errors a write can return, or what
`GET /api/pages/readMany` answers with is to read the source. Prose drifts silently: nothing fails when an
export gains a parameter, an error union gains a member, or a route changes its shape. A convention that
does not break the build does not exist — applied to documentation, that means the documentation itself
has to be enforced, generated, and tested, not merely written.

**Decision.**
- **TSDoc is mandatory on every export of the public API** — `kestrel-contracts`, the Promise facade of
  `@michaelthielemann/kestrel`, and every extension-point interface. Each export documents its purpose, its error union,
  its invariants, and carries an `@example`. Enforcing that needs *two* lint plugins, because neither
  covers both halves: eslint-plugin-jsdoc's `require-jsdoc` with `publicOnly` checks that a doc comment
  exists on exports, and eslint-plugin-tsdoc's `tsdoc/syntax` checks that what is there is valid TSDoc.
  Missing or malformed documentation fails the build like any other lint error.
- **TypeDoc generates the API reference.** Validation warnings are errors — deliberately the narrow class,
  not the broad `--treatWarningsAsErrors`, which also trips on warnings that say nothing about the contract
  and trains people to ignore the gate. See [Releasing and dependencies](./releasing.md) for the mechanism.
- **api-extractor produces the machine-readable report.** The checked-in `.api.md` is what makes
  ADR-0014's additive-only rule mechanical: a diff that removes or narrows anything is a failing check
  rather than a review finding. publint and `@arethetypeswrong/cli` sit alongside it as cheap checks on
  package exports and type resolution — a different error class, not a substitute for the report.
- **OpenAPI is derived, never written** — the same principle the knowledge graph follows. It is derived
  *without* the unstable HttpApi stack: `OpenApi.fromApi` requires an HttpApi instance and is unusable
  standalone, so the generator walks the pipeline registry instead and calls
  `JSONSchema.make(schema, { target: 'openApi3.1' })` from the stable core for each input and output
  schema. Paths, verbs, gates (as security requirements) and error unions (as response codes) all come
  from `buildPipelineIndex()` — the same composed data `_pipelines` and the request trace read, so a spec
  cannot describe a surface the engine does not serve. Transformed and branded schemas need care:
  `JSONSchema.make` describes the *decode* side, so the wire shape may need `Schema.encodedSchema` or an
  explicit annotation.
- **The spec is tested against reality**: `test/nuxt/openapi-contract.test.ts` boots a dev server, fetches
  the live document from `GET /api/_openapi`, and asserts every response against it with vitest-openapi's
  `toSatisfyApiSpec()` — JS-native, so no second language enters the toolchain. See
  [Releasing and dependencies](./releasing.md) for which suite that test runs under.

**Consequences.** Adding a public export costs a documented contract or a red build, and adding a pipeline
costs nothing extra because the spec is derived from what the pipeline already declares. The generated
reference and the generated spec are build artifacts, so they cannot lag the code; the hand-written guides
under `docs/` shrink back to what they are good at — the narrative, the why, the migration tables. The one
thing no machine can check is whether a TSDoc block is *true*; that stays a human job and belongs to the
contract review, which is the review that matters anyway.

**Future.** The lint gate starts on the small public surface that exists today (`defineCollection`,
`definePipeline`, the serializer types) and widens with the package cut. A Swagger/Scalar UI beside
`_pipelines` is not built; the only OpenAPI surface today is the `_openapi` read pipeline serving the
document itself.

## ADR-0014 — Every extension point is a port against the contracts package

**Status:** accepted.

**Context.** Kestrel is extensible in several places already — field types, collections and blocks,
pipelines, storage and media drivers, populators — and every one of them arrived with its own shape.
Nothing stated which shape is the rule, so the default answer to "how do consumers extend X" has been "we
add a callback for it". A callback is the worst of the options: it has no runtime contract, it is
invisible to the graph, and whatever it returns lands in the system unchecked. As the surface grows into
packages, the difference between "a documented port" and "a hook someone added" stops being cosmetic —
it decides whether an extension is inspectable and whether the public API can be versioned at all.

**Decision.**
- **Every extension point is either data-driven or an adapter against an interface from
  `kestrel-contracts`.** Never "pass your function here". The catalog — one extension point per row, its
  form, and its boundary guard — lives in one place, [Extension points](./extension-points.md), rather than
  restated here; that page is what stays current as extension points are added or their guards change.
- **The whole extension API is additive-only**, the same rule event schemas already follow, widened to the
  module API. Removing or narrowing anything is a new major, and the api-extractor report diff (ADR-0015)
  is what makes that mechanical.
- **Extensions are graph nodes.** An extension that touches a port it did not declare is a CI violation,
  not something a reviewer might notice.

**Consequences.** Registering an extension costs a schema on the registration, and adding an *extension
point* costs an interface in the contracts package and a row in the catalog above — deliberately more
expensive than adding a callback, because the guard is the point. In exchange, "what can be extended, and what does each
extension touch" is answerable from data instead of from a source read, consumer adapters cannot smuggle
unvalidated values into content, and the public API becomes versionable rather than merely published.

**Future.** Nothing here changes the zero-config case — a project that registers nothing gets the same
behaviour it has today.

## ADR-0013 — Publishing owns immutable snapshots; delivery is a derived adapter

**Status:** accepted.

**Context.** Publishing and serving are the same thing today: `nuxt generate` reads the live tables
through the same populate path the admin uses, so "what is published" is not a stored fact but whatever
the last build happened to read. Three consequences follow from that one conflation. There is no artifact
to roll back *to* — reverting means editing content backwards and building again. There is no way to add
a live-rendering mode without it disagreeing with the static one, which is the documented `/api/route`
populate drift in miniature. And a delivery-side failure (a broken build, an S3 outage) is indistinguishable
from a publishing-side one, because there is no boundary between them.

**Decision.**
- **Publishing is a business module and the source of truth for "what is published."** A publish produces
  an **immutable content snapshot**: fully populated, media references fixed at publish time. Fixing media
  inside the publish command needs one transaction, so it belongs to one module, which also owns the
  queue, the dependency index and the redirects.
- **Rollback is a pointer to an older snapshot**, never a rewrite of a current one. A snapshot is never
  mutated after it is written.
- **Delivery is derived state behind a port.** `delivery-static` consumes snapshots and bakes HTML,
  sitemap, robots and `redirects.json` — today's generate path, which stays the default and the
  zero-config case. `delivery-live` serves snapshots at runtime (SSR rendering, read API).
- **A delivery adapter reads snapshots only, never drafts.** That is what makes live and static render the
  same state by construction rather than by discipline, and it retires the populate-drift class of bug
  instead of fixing one instance of it.
- **Both adapters are killable and rebuildable**, demonstrated in CI. A delivery outage degrades what
  visitors see and never damages publishing; the recovery is a rebuild from snapshots, not a restore.
- **A consumer picks its delivery by config**, and further adapters — headless-only, an edge export —
  are the same port rather than new special cases.

**Consequences.** Snapshots cost storage, and a publish becomes a write of a real artifact rather than a
flag flip — the price of having something to roll back to. Two properties become testable that were not
before: static and live must render identical HTML from one snapshot, and a withdrawn article must be
findable in *no* delivery adapter. ADR-0008's save/publish split is unchanged; this decision only gives
"published" a stored artifact instead of a state recomputed at build time.

**Future.** Snapshot retention and pruning (how many old snapshots a project keeps, and what a rollback
pointer to a pruned snapshot means) is not settled here.

**Amendment — reconcile converges to the current render via fingerprint; delivery-exclusivity is enforced
at the delivery layer, not by freezing the producer.** `delivery-static`'s write path
(`@kestrel/delivery-static`'s `render-route.ts`) reads exclusively through
`currentSnapshot`/`currentRoutes` — never a live render's bytes directly — which is where this ADR's
"delivery is derived state" holds. The producer (`publisher.ts`'s reconcile pass, i.e. `publishFull`/
`publish:run`/the boot+reconciler queue) still live-renders every published route on every run, exactly as
it always has — that render's fingerprint is compared against the route's currently recorded snapshot: a
mismatch records a new snapshot (an ordinary supersede, history intact) and delivers it; a match records
nothing and, when the output driver already has the matching file, skips the write too, a real perf win
over the pre-split publisher, which always wrote. Trusting an already-recorded snapshot unconditionally,
never re-deriving it from a fresh render, breaks self-healing: a missed/lost incremental invalidation (a
crash between a queue enqueue and its flush — the in-memory queue is not durable) or a template/component
deploy would never reach already-published routes again. Fingerprint-based promotion restores it — a
reconcile pass is once again a genuine convergence to the current render, while the snapshot store stays
the only thing `delivery-static` ever reads.

**Amendment — what `delivery-live` actually shipped.** Not SSR rendering: `delivery-live`'s `port.ts` is a
no-op `DeliveryPort` (`publishSnapshot`/`removeRoutes`/`rebuildAll` all do nothing), and the request-time
read is a separate snapshot-read pipeline in `delivery-live`'s `pipeline.ts`, plus a live redirect lookup
in `redirects.ts` — see [Publishing](./publishing.md) for the split. The "derived adapter" framing above
still holds; only the mechanism differs from what this entry originally described.

## ADR-0012 — One database file, per-module ownership enforced by an adapter

**Status:** accepted.

**Context.** Every module should own its data. Kestrel hands every module the same better-sqlite3 handle,
so ownership is a convention — and it is already breached in three places: `record_refs` reads every
collection's rows, `core` reaches directly into the media-folders table, and the dependency index belongs
to neither of the modules that use it. A convention that does not break the build does not exist, so the
question is not whether to state the rule but what enforces it.

The obvious enforcement — a file or a database per module — is the wrong instrument at this scale. The
most-cited modular-monolith reference architecture uses **one** database with a schema per module, forbids
cross-module foreign keys and joins, and integrates modules exclusively through an outbox; a database per
module is its escalation step for the day a module deploys independently, not its default. Kestrel is a
single deployable with a zero-config promise of "one SQLite file, no setup", which makes the cheap answer
also the correct one.

**Decision.**
- **One better-sqlite3 file, one table namespace per module** (`content_*`, `media_*`, `publishing_*`, …).
  The ownership list is a manifest in each module's contract, not a naming habit.
- **No module ever receives the raw handle.** Each module gets a `<Module>Db` service through its Layer
  which (a) exposes only that module's table objects, so a foreign table is not reachable through the API
  at all, and (b) in dev and test checks every statement it issues against the ownership manifest via
  statement introspection and throws on a foreign access. The raw handle exists only inside the adapter.
- **No cross-module foreign key, no cross-module join.** Consistency between modules runs through the
  outbox; a reference to another module is a business id plus a derived, rebuildable index. Where a
  genuinely shared transaction is required, the work belongs in one module instead. *Inside* a module,
  foreign keys, joins, and the single transaction that writes a record and its outbox event together all
  remain — that is the main advantage over a file per module, along with one backup file and no
  cross-file atomicity problem (ATTACH atomicity does not hold under WAL anyway).
- **Three nets, because one is a convention again.** (1) The adapter: a foreign access is not expressible
  in the type and throws at runtime in dev. (2) A graph query — "which module references foreign tables" —
  asserted empty as a CI test, which also covers the auto-import layer no static import tool sees.
  (3) A negative test per module that attempts the foreign access and asserts the throw.
- **Zero-config is untouched.** Still one file, still no setup; the enforcing adapter is invisible to a
  consumer.

**Consequences.** The three known breaches move: `record_refs` becomes a derived index inside content, the
media-folders table moves wholly to media, the dependency index to publishing. A namespace migration
against an existing installation is itself a dangerous operation with its own blast radius. The dev-mode
statement check costs time per statement and therefore runs only in dev and test — in production the shape
of the adapter API plus the CI graph query carry the rule. The rule that bites hardest in practice is the
join ban: a listing spanning two modules is a derived index that one module owns and rebuilds, never a
cross-module join.

**Future.** Whether any module ever escalates to its own file is left open — the adapter is what makes
that a later, local change rather than a rewrite, which is the actual reason for putting it in front of
the handle now.

**Amendment — the branded `Db` type.** `ModuleDbService['db']`'s methods each carry a phantom nominal tag
that survives `Pick`-narrowing, closing a gap the original decision left open: five narrowed persistence
types — `record-ref-index.ts`'s `DB`/`WriteDB`/`RebuildDB`, `deps-persistence.ts`'s `DepsPersistenceDb`,
`publish/publish-status.ts`'s `PublishStatusDb` (not the unrelated `database/publish-status.ts`),
`snapshots.ts`'s `SnapshotsDb`, and `orchestrator.ts`'s `OrchestratorDb` — accept structural
`Pick<...Db, 'select' | 'insert' | ...>` types a raw better-sqlite3 handle previously also satisfied,
giving up compile-time ownership at exactly those seams. All five now re-intersect the brand
(`& { readonly [ModuleDbBrand]: true }`) and reject a raw handle at compile time, pinned by an
`@ts-expect-error` test. The brand symbol is declared once, in `packages/kestrel-core/src/server/db/module-db.ts`,
and re-exported from `@kestrel/core`; every `kestrel-publishing` site re-intersects that same symbol.

**Amendment — table names stay unprefixed.** The originally proposed `content_*`/`media_*` table-namespace
renaming is skipped permanently. Ownership is already enforced structurally by the per-module `Db` adapter described
above — a foreign table is unreachable through the API and throws `OwnershipViolation` on a foreign
access — so a name prefix would add no enforcement beyond what the adapter already guarantees. A rename is
a data migration against every existing installation's SQLite file, carrying real risk, for zero
behavioral gain.

## ADR-0011 — Effect inside, Promises at the boundary

**Status:** accepted (amended — see "Amendments" below).

**Context.** The engine already has the shape a functional core wants — decide, then apply — but nothing
in the type system says so. Failures are thrown, so "what can this operation fail with" is answerable only
by reading every branch; the dependencies a step needs (clock, id generator, randomness, the database) are
reached for rather than declared, so a test substitutes them by mocking modules; and the boundary between
deciding and effecting is upheld by review only. `Effect<Decision, Errors, Ports>` states a signature that
is its own bill of materials, a core that returns decisions for a shell to apply, and context/environment
as genuinely different things, all in one type — the only runtime in the TypeScript ecosystem that does.

Adopting it raises four questions that "we use Effect" does not answer: which version, which of Effect's
two service idioms, how far the Effect types travel outward, and whether the engine's synchronous critical
section survives being an Effect chain.

**Decision.**
- **`effect` is pinned to 3.22.x, and no Effect-4-only API is used.** Effect 4 is in RC with announced
  Schema renames; changing runtime major versions in the middle of a structural rebuild would mix two
  sources of breakage. The migration is a later, guided step with the version boundary crossed on its own.
- **Services are `Context.Tag` plus explicit Layers** (Live / Test / InMemory). Effect offers two current,
  equally supported idioms — the `Effect.Service` sugar class and the separate tag/layer form. For modules
  with explicit data ownership the separate form is chosen as a house rule: the tag is the contract, the
  layer is the wiring, and neither is implied. Explicit contracts, no magic.
- **The public API never speaks Effect.** `@michaelthielemann/kestrel` exports Promises and plain objects only; tagged
  errors cross the boundary as a serialized value union, never as an Effect type. A consumer adapter is
  authored plain — a Promise interface — and is wrapped into a Layer where it is plugged in, with its
  return value schema-decoded at that seam: nonsense from an adapter lands in quarantine, not in content.
- **The shell is Nitro, and the bridge is one call.** `HttpApp.toWebHandler` and the HttpApi router are
  deliberately not used: they would replace the pipeline registry's dispatch — the thing every URL, trace
  and introspection entry is derived from (ADR-0010) — with Effect's own router, and
  `@effect/platform`'s HttpApi/HttpServer are marked unstable. The runtime bridge is a bare module-level
  singleton in `packages/kestrel-core/src/server/pipeline/runner.ts` (`const runtime =
  ManagedRuntime.make(Layer.empty)`), and the request path runs `runtime.runPromise(effect)` inside the
  existing catch-all handler — no dedicated Nitro plugin. `Layer.empty` has no external dependency to
  resolve, so its construction time relative to boot order is irrelevant: the runtime is a process-long
  singleton.
- **A step becomes an `Effect<StepOut, StepError, StepPorts>`.** Everything ADR-0010 decided stays as it
  is conceptually — gates as declarations, sealed steps, critical and non-critical after-steps,
  introspection off the composed list. What changes is that a step's ports and failure modes are now in
  its type. Outbox consumer retries come from
  `Schedule.exponential(...).pipe(Schedule.compose(Schedule.recurs(n)))` rather than a hand-rolled loop.
- **The `assertUnique → persist` critical section may be an Effect chain run under `Effect.runSync`.**
  This was the one adoption question that could have blocked the whole decision, and it was settled by
  measurement rather than by argument. On effect 3.22.1: `runSync` completes chains of ten million
  operations without throwing; timers and microtasks armed before the run (`setImmediate`, `setTimeout`, a
  resolved promise) never run mid-chain, because a synchronous call frame is not interruptible — the
  scheduler's op-count yields drain inside the same frame, and so do five thousand explicit
  `Effect.yieldNow()` calls; a staged TOCTOU (read → one million operations → write on better-sqlite3
  against an armed competing writer) stays closed; and a genuine async boundary (`Effect.promise`) throws
  `AsyncFiberException` rather than silently suspending, which is fail-loud.
  Three conditions ride with the decision: the engine's sync driver uses `runSync`; `assertCriticalSection`
  keeps rejecting a non-sync step inside the contiguous section at compose time, so a smuggled async step
  fails twice over; and the experiment stays in the repo as a regression gate that runs on every `effect`
  upgrade — the next major above all.

**Consequences.** Every port a piece of core logic needs has to be named before it can be used, which is
the cost and also the reward: the third type parameter is the bill of materials the graph reads, and the
layer composition is its assignment. Expected failures become `Schema.TaggedError` values and
`Effect.catchTags` makes handling them exhaustive at compile time instead of hopeful at runtime. Tests
drive time with `TestClock` and swap adapters with in-memory Layers rather than mocking modules. The cost
is a second mental model that stops precisely at the package boundary, and one that is unfamiliar
enough to make review slower on the first modules — which is why the engine conversion goes step kind by
step kind against the existing suites rather than in one pass.

**Future.** Effect 4 with its Schema renames is the known migration, taken via the official guides once
stable and never mid-rebuild; the `runSync` gate test above is what tells us whether the critical-section
decision survives it. The docs references we track are the unversioned `effect.website/docs/...` paths,
which follow stable — the `/docs/v3/` tree is frozen.

**Amendments — three parts of the original decision did not ship as decided.**
- **Services: one Layer per module, not a Live/Test/InMemory trio.** `module-db.ts` builds exactly one
  `Layer.succeed(tag, service)` per module, and production collapses it immediately into a cached plain
  service (`useContentDbFor`/`useContentDb` and the same shape in `publishing-db.ts`/`media-db.ts`); a test
  provides that same real layer rather than a stub or in-memory substitute. No second or third layer variant
  exists.
- **The consumer adapter seam is compile-time only.** `AdapterContract<T>` pairs an adapter interface with
  a `Schema` per method, but nothing wraps an implementation into a Layer and nothing decodes a return
  value at runtime — see [Extension points](./extension-points.md), "Storage, media, and identity: a port
  with no implementation yet". "Nonsense from an adapter lands in quarantine" does not happen today; the
  pairing only makes an interface change without a matching schema entry a compile error.
- **A step's type is `Effect<void, KestrelError>`, not `Effect<StepOut, StepError, StepPorts>`.**
  ADR-0019 is the completion of the step-channel typing this ADR started, and settled on a two-parameter
  signature with no `R` — a step reads the engine-owned `ctx.ports` bag rather than declaring a service
  requirement in its type. "The third type parameter is the bill of materials the graph reads" (Consequences,
  above) describes a shape that was never built; the ports bag is untyped at the call site.

## ADR-0010 — Config- and schema-driven pipelines

**Status:** accepted.

**Context.** The CRUD engine had grown four unmet needs at once. A consumer wanting to hook a step into a
save (sanitize a field, enqueue a side effect) had to fork `crud.ts` — there was no declarative extension
point. A run left no trace: debugging "why did this save do X" meant reading source, not evidence. The
eight operations (create/update/delete × one/many, read one/many) had quietly diverged over time — a
concurrency check here, a missing one there — because nothing forced them to share a single step list.
And a named admin action (Publish, Duplicate, a consumer's own bulk operation) had no general shape: each
was its own route, its own client wiring, its own bespoke authorization check, with no way to introspect
"what actions exist" short of reading every route file.

Underneath all four was the same structural gap: authorization lived in the route guard, business logic
lived in `crud.ts`, and nothing tied a URL, a permission check, and a list of side effects into one
inspectable unit.

**Decision.**
- **A pipeline is the unit.** A named, composed list of steps plus a set of gate declarations
  (`access`/`csrf`/`ipAllowlist`). The eight standard CRUD ops are pipelines with no `definePipeline` call
  anywhere (zero-config parity: an empty project behaves exactly as before); `login`/`logout`, publish,
  preview, media upload and every extension route are pipelines too — there is exactly one route file
  (`layers/core/server/api/[...path].ts`) behind the entire `/api/` surface. A route is a trigger is an
  admin-action name, all three read off the same declaration.
- **Gates are declarations, not steps.** `access`/`csrf`/`ipAllowlist` are evaluated by the engine before
  step 1, are not list members, and are not patchable (not even via `unsafeReplace`) — one source of truth
  (the declaration), one enforcement point (engine entry), full introspection for free. A slim rest-guard
  stays as the *only* jurisdiction for a URL no pipeline claims (an unconverted legacy route, a stray
  consumer mount) — different territory from the gates, not a second copy of them.
- **Steps are the extension seam**, patchable by anchor (`before`/`after`/`replace` a named step) rather
  than as a fluent chain — the composed list itself is the data a trace and `GET /api/_pipelines` read, so
  there is no separate description to keep in sync. A handful of steps are **sealed**
  (`validate`/`checkConcurrency`/`assertUnique`/`persist`/`emitEvents`, and the read-scope check inside
  `fetch`/`populate`) — replaceable only via an explicit `unsafeReplace: true`, so a consumer can silently
  drop record-integrity or authz enforcement only on purpose, never by accident.
- **The `assertUnique → persist` window is a checked property, not a convention.** Steps declare
  `sync: true`; the composer rejects a non-sync step sitting inside the contiguous sync run at *compose
  time*. This is what makes better-sqlite3's synchronous-write race-freedom an enforced invariant instead
  of something a future PR could quietly break — a TOCTOU on slug uniqueness or optimistic concurrency
  would otherwise be a silent regression.
- **After-steps replace both event buses with one mechanism.** `critical: false` is the logged,
  non-blocking after-step `registerWriteListener` provided (save stays green); `critical: true` is the
  failure-becomes-response, already-committed after-step ADR-0009's `write-effects.ts` provided.
  `registerAfterStep` is the one registration function for both, and — unlike a bus subscription — every
  after-step is named and shows up in the trace and in `_pipelines`.
- **Verb-in-path URLs, a deliberate breaking change.** `/api/<collection>/<pipeline>[/<id>]` — GET for a read
  pipeline, POST for a write — replaces the old REST-shaped routes (`PATCH /api/pages/1`, a `bulk` action
  envelope). This was a user-chosen trade, not a technical necessity: the alternative (keep REST verbs,
  layer pipelines underneath) would have needed a second name per operation — a URL verb *and* a pipeline
  name — for no benefit, since the pipeline name already *is* the operation identity everywhere else
  (trace, introspection, admin action, `registerAfterStep`'s `ops`). One name, one grammar.
- **Reads are pipelines too, not a special case.** `readOne`/`readMany` compose from steps
  (`parseQuery`/`fetch`/`populate`/`attachMeta`) exactly like a write, so a custom read (a consumer's own
  filtered listing) gets the same patching, tracing and access-declaration machinery instead of a parallel,
  weaker mechanism.
- **Login and session are pipelines, not a bespoke auth route.** `login` is the one pipeline whose `access`
  is `{ public: true }` on a *write* — nobody can hold a session before they have one — and it still goes
  through the same CSRF gate as any other write. Modeling authentication as "just another pipeline" rather
  than infrastructure-adjacent to the engine is what let the auth layer register it from an ordinary
  `server/pipelines/` file, the same shape a consumer's own extension uses.

**Consequences.** A consumer extends the engine by dropping a `definePipeline` file under
`server/pipelines/**` (auto-discovered, the same mechanism as `server/collections/**`) instead of forking
`crud.ts`. Every run is traceable — `?debug=pipeline` for an admin caller, a dev-only one-line log, static
introspection at `GET /api/_pipelines` — without a parallel description to maintain, because the trace and
the introspection index both read the same composed step list a request runs. The eight standard ops
demonstrably share one step list per operation (not eight ad hoc implementations), and a consumer's custom
write pipeline can surface as a schema-driven admin action (`ui: {...}`) with zero admin-side code. The
cost is the URL grammar break above (every existing consumer integration must move to the new grammar — see
[./pipeline-engine.md](./pipeline-engine.md) and [../guide/extending.md](../guide/extending.md) for the old→new table) and a stricter authoring discipline: a boot-time
check (reserved names, one full-`steps` registration per operation, the sync critical section) fails a
misconfigured pipeline loudly at startup rather than letting it 404 or race at runtime.

**Future.** A persistent run history and an admin pipeline-inspector panel were both scoped out as
deferred ideas — the trace today is per-request and ephemeral (dev log / `?debug=pipeline` only). See
ADR-0008 (after-steps absorb its write-listener/write-effect split) and ADR-0009 (the redirects critical
after-step, and its now-resolved shadowing note) for the two decisions this one folds together.

## ADR-0009 — CMS-managed redirects publish an artifact on save, through a fail-able write effect

**Status:** accepted.

**Context.** Editors need to manage SEO redirects, and a redirect has to go live without a deployment —
the whole point of a redirect is that someone is already hitting the old URL. Kestrel has no live public
SSR, so it cannot serve the 30x itself; the edge (NGINX/njs, CloudFront) has to, from a small artifact
Kestrel publishes. That artifact is only useful if it is never behind the database: an editor who saw a
green save and a stale edge is exactly the failure mode this feature cannot have.

Nothing in the write path could express that. `registerWriteListener` is fire-and-forget by design —
`emitWrite` wraps every listener in a `try/catch` so a publishing failure can never break a content write —
and it is synchronous, so an async rejection escapes as an unhandled rejection instead. The obvious
alternative, a dedicated `PUT /api/redirects` route shadowing the generic `/api/[collection]` one, was
tried and rejected on evidence: registering a static `/api/redirects` node in the router steals the whole
`/api/redirects/**` subtree — h3's per-method fallback finds the generic handler for a `GET`, but
`event.context.params` comes from the originally matched static node, so `collection` is `undefined` and
the singleton's load 404s. Media only gets away with a partial static directory because its admin UI is
bespoke and never calls the generic sub-routes.

**Decision.**
- **A second, narrow seam in core: post-write EFFECTS** (`write-effects.ts`), awaited by the singleton
  PUT route, whose rejection becomes the save's error response. Effects sit beside the listener bus
  rather than changing it: the invariant that a publish failure must not break a content write is worth
  keeping, and the redirects artifact is the case where the opposite is true. (The pipeline engine, ADR-0010,
  later folded both buses into one mechanism — a critical vs. non-critical **after-step** — but the
  asymmetry this decision establishes is unchanged: `writeRedirects` is still the one critical after-step,
  `when`-scoped to the `redirects` singleton's `updateOne`, and every other write's after-steps stay
  non-critical.)
- **Deliberately only the singleton save runs a critical after-step** — widening it to create/update/delete
  would make every content write fail-able, the invariant the non-critical after-step exists to protect.
- **A save is not atomic with the artifact, and the message says so.** The row is committed before an
  effect runs (better-sqlite3 writes are synchronous and CRUD holds no transaction), so a failed write
  means "saved, but the edge still serves the previous rules — press Save again". Writing the artifact
  first would only invert the divergence; there is no transaction spanning SQLite and S3. The retry has
  to actually work, so the failing PUT hands the committed row's new `updatedAt` back in the error and
  the editor takes it as its baseline — otherwise the optimistic-concurrency precondition refuses the
  very save the message asks for, deterministically rather than as a race.
- **The wildcard→regex translation happens in Kestrel, not at the edge.** `redirects.json` carries
  compiled, anchored regex source strings, so the njs handler only matches and substitutes; editors never
  write a regex (`*` is one path segment, `**` is one or more). A rule that cannot compile is a pre-write
  400, not a post-write error — needing a whole-record validation seam (`CollectionDef.validate`), since a
  Zod field validator sees one field at a time and cannot tell that `to: '/x/$2'` needs a second wildcard
  in `from`; without it an unpublishable row could be stored, then fail every later publish.
- **The artifact is also produced at build time**, exactly like `sitemap.xml`/`robots.txt`/`llms.txt`: a
  route, a prerender seed, a re-render on every full publish, and an exclusion from the build-asset
  mirror — not redundancy, since a build-time S3 deploy reconciles the bucket against `.output/public` and
  would otherwise prune a save-time key as stale. An empty rule list publishes `[]`: zero redirects is a
  supported state, not an absent file, and the edge must be able to tell it apart from a failed fetch.
- **A capture is untrusted input, so the pattern is the guard.** `normalizeTarget` can only vouch for what
  the editor typed; `$n` is spliced in from the request. The emitted character classes exclude a backslash
  and the control characters that split a header, and forbid a `**` capture from starting with `/` — so
  `/\evil.com/shop/x` and `/blog//evil.com` do not match at all rather than producing an off-site
  `Location`. A placeholder inside an absolute target's host is rejected at authoring time.

**Consequences.** Consumers need a `db:migrate` for the new (additive) `redirects` table. The artifact
lands at the output **driver's** root — `output.dir` locally (`.data/published/` by default), the
configured prefix on S3 — as a sibling of `index.html`, not "alongside `published/`"; the local driver
refuses a key that escapes that root. Save-time publishing only reaches the live site where that target
is what the site is served from (`output.auto: true`, or `auto: false` + `driver: 's3'`); in the classic
`auto: false` + local build model the deployed tree is `.output/public` and a redirect goes live with the
next `nuxt generate`. Redirects are global, not per-locale. `redirects.json` is inert until an edge reads
it; the NGINX/njs side is deployment infrastructure and lives with the deployment.

The shadowing problem this ADR's Context describes is gone under the verb-in-path grammar (ADR-0010):
`/api/redirects/readMany` is an ordinary collection read and `/api/redirects` alone resolves to nothing
routable, so there is no static node left to steal a subtree. `writeRedirects` stayed a critical after-step
regardless — the shadowing was one motivation among several (see Decision), not the only one.

**Amendment — the synchronous critical after-step is an enlarged blast radius, on purpose.** Running
`writeRedirects` inside the save makes the save's success depend on its weakest link, and no transaction
spans the database and the output driver — a documented purpose decision, on the record here. The default
that is correct everywhere else — write the source of truth synchronously, run the derived work
asynchronously — is what every other after-step does, and is rejected for this one case because the
failure it would leave behind is the exact failure the feature exists to prevent: a redirect live in the
database and stale at the edge, seen by an editor with a green save and no reason to look again. The
enlargement stays bounded to one after-step, `when`-scoped to the `redirects` singleton's `updateOne`.
Widening it to any other write is a new decision, not an application of this one.

**Future.** The editor has no per-field help text (`BaseFieldDef` has no `help`), so the priority rule
and the wildcard syntax ride along in the field labels. A real `help` affordance is its own slice. Also
open: per-row error addressing inside a repeater (a server issue at `['rules', 2, 'to']` currently
collapses onto the repeater's legend, which is why every message names its row in prose), and metrics
for redirect hits beyond the edge's access log.

## ADR-0008 — Saving and publishing are two actions, and previewing is neither

**Status:** accepted.

**Context.** Until now a save WAS a publish. `registerWriteListener` classified every content write and
enqueued an incremental republish, so editing a published page put the edit on the live site seconds later,
with no step in between. The only way to work on a live page without the work being live was to unpublish
it first — which takes the current page offline, the opposite of what an editor wants. The editor's
open-in-new-tab button made the gap visible: it opens the record's saved URL, so the tab shows the last
saved state and looks like nothing happened (it never saved anything — verified), while the in-editor
iframe shows unsaved content over postMessage. Two previews, two different answers.

**Decision.**
- **A save writes the DB; publishing writes the static output.** The write listener plans through
  `planWrite` → `planSaveInvalidation`, which passes through only what a save must still REMOVE — an
  unpublished or deleted record's page. Everything renderable waits for `POST /api/publish`, which plans the same invalidation
  (`planInvalidation`) and enqueues it on the same queue.
- **Removal stays immediate, and that asymmetry is the point.** A page that was unpublished or deleted must
  not stay live while its record says otherwise; a page whose *content* changed is still a page the site can
  legitimately serve, in its last published version. Losing content is recoverable, serving withdrawn
  content is not.
- **Every publish holds back routes with unpublished changes — full and incremental alike.** Re-rendering
  from the DB pushes whatever the DB currently holds, so any render of a route whose record has moved on
  publishes work nobody released. That reaches further than the boot publish: an incremental publish renders
  every route matching the invalidation's tags, and since each page reads the `site` singleton, publishing
  site settings would otherwise flush every withheld edit on the site at once. So a route whose record
  `updatedAt` is newer than its `publish_status` row keeps the file its last publish wrote, wherever the
  render was triggered from. The route a publish was explicitly FOR is exempt — pressing Publish is what
  clears the withholding.
- **Withholding is keyed to the record, not the route string.** A rename moves the string, so the new route
  has no `publish_status` row of its own; keyed by route it would slip through the never-published carve-out
  below, publishing the unpublished rename *and* pruning the old URL that is still the live one. A record's
  previously-published routes are consulted instead, and protected from the prune while it is held.
  A record with no prior published route keeps the carve-out: on a first deploy there is no older version to
  protect, and holding it would produce an empty site.
- **A held route is frozen whole, links included.** It keeps the baked links and hreflang of its last
  publish, so a link to a page that has since been unpublished stays stale until the referrer is itself
  published. That is the accepted cost: a route serving one publish generation throughout is more coherent
  than a file mixing an old body with fresh links.
- **The record's `status` is unchanged** — it still means "may be public" and still gates the resolver, the
  sitemap and link resolution. What changed is only WHEN the file is written. The Publish button promotes a
  draft on the way, because pressing it is the publish intent.
- **Previewing unsaved changes uses a ticket, not a save.** `POST /api/createPreview` puts the editor's
  current form body in a short-lived, admin-only, session-bound in-memory store and returns a token; the
  tab opens `<url>?kestrel-preview-token=…` and the page lays those values over the stored record. Nothing
  is written, and the ticket is populated server-side on read so images and internal links resolve exactly
  as they do on a real page. `GET /api/preview?token=…` is the read side that resolves a minted token. A
  record with no public URL previews on the existing `/__kestrel/preview` page.
- **One switch back, not a mode matrix.** `output.publishOnSave: true` restores the pre-2.0 behaviour in
  one place — the `planPublish` planner (`planWrite`; ADR-0024 later moved planPublish to an outbox
  handler, the planner seam itself is unchanged) — and everything downstream reads that
  same flag: a full publish stops holding routes back, `/api/publishStatus` stops reporting unpublished changes (with
  the split off, "saved since the last publish" means a republish is in flight, not something to act on),
  and the editor hides the Publish button. The ticket preview is unaffected: previewing without saving is
  useful in both models.

**Consequences.** The editor gains a second lamp state — "Outdated": saved, published, but the live file is
an older version. That is now the normal state of a page being worked on, so it is amber, not red. A
consumer who relied on "save = live" must press Publish (or run the `publish:run` task) — the one
behavioural break. `nuxt generate` is unaffected and still renders whatever the DB currently holds — a
build of the whole site, not the incremental publisher, so a generate-based deploy publishes unpublished
edits along with everything else. `status` itself is now table-governed: `workflow.ts`'s `transitions` is
the one place that names every legal `draft`/`published` move and the guard it needs, and every write path
that can change the `status` of an existing record is gated through it — an illegal move fails with
`ValidationFailed` naming the transition. `createOne` sets a record's first `status` outside the table:
with no prior row there is no `from`, so the field is validated, not transitioned.

**Future.** Real versioning (a published snapshot per record), which would make "publish" restorable and
let a full publish rebuild the exact published state rather than holding routes back, is superseded by
ADR-0013 — publishing now owns an immutable content snapshot per publish. The ticket store is per-process
by design; a multi-instance deployment would need a shared one, or a sticky session.

## ADR-0007 — A `site` singleton for the site-wide half of the page head

**Status:** accepted.

**Context.** Kestrel already owns the public `<head>` — the catch-all emits canonical, hreflang, `og:*`,
`twitter:card` and `robots` through `buildPageHead`. What was missing is the tier above the page. The
per-page `seo` group is a closed set (`title`, `description`, `noindex`, `image`), and `siteName`/`siteUrl`
are config-only, so a site-wide description, a base title and a fallback social image had nowhere to live.
That asymmetry was the defect: `description` is site-wide in exactly the sense `siteName` is.

Config could not be the answer for editorial values. Non-auth `KESTREL_*` is read once at Nuxt module setup
and frozen into `runtimeConfig`, so changing a base title would mean a rebuild triggered by hand. A write to
a collection re-publishes the affected routes on its own, through `captureRead` → publish deps →
`routesForTags`.

**Decision.**
- A **translatable single collection `site`**, `builtin: true` so a consumer can switch it off, holding only
  the counterparts of the per-page group plus the title composition. It ships in `@kestrel/publishing`, the
  module whose render consumes it. `siteUrl`/`siteName` stay in config, because the build needs them for canonical
  URLs, the sitemap and `robots.txt` and therefore cannot read them from the DB.
- **Not** named `settings`. Collection files dedupe by basename with the consumer winning, and shadowing
  replaces a whole definition rather than merging fields — a consumer defining its own `settings.ts` would
  silently lose everything the built-in contributed.
- **The precedence chain sits before `buildPageHead`, not inside it.** That function already receives
  `title`/`description`/`image` resolved, so widening its signature would have churned a pure function with
  full test coverage for nothing. Two small pure functions (`composeTitle`, `siteHeadFallbacks`) do the
  merge, and each is unit-testable on its own.
- **Only `<title>` is composed.** `og:title` keeps the bare page title, because `og:site_name` already
  carries the site — emitting the composed string in both would duplicate the site name in every share
  preview.
- **A page title that already ends in the base title is left alone.** Migrated content routinely carries the
  site name in the page title, and appending it again reads as a bug to everyone who looks at the tab.
- **The separator is stored as a bare token and padded at render.** A `text` field trims on write, so a
  stored `" | "` comes back as `"|"` and glues the two titles together. Found by the e2e, not by reasoning:
  the first run rendered `Pricing·Acme Docs`.
- The row reaches the render **on the fetch the page already awaits** — `/api/route` returns it alongside
  the resolved page. That path is public-safe, already runs per route, and demonstrably survives
  `nuxt generate`; a second endpoint would have been a second thing to keep working under prerender. It is
  looked up through the registry rather than imported, so a consumer who disables the collection gets `null`
  instead of a query against a table the schema never created.

**Consequences.** With an empty row every fallback is absent and the emitted head is what it was before, so
existing projects upgrade silently — `site.test.ts` pins that every field stays nullable. A site edit
re-publishes the routes that embedded it, for free, because `getSingleton` captures the read. One visible
side effect: the row now rides in every page's hydration payload, so a site-wide description is present in
the HTML even on pages that override it — public content either way, but it means an assertion about the
document is not an assertion about the meta tag.

**Future.** Per-collection defaults or per-locale social images extend the same chain rather than adding a
second mechanism. The chain is the contract; the fields are not.

## ADR-0006 — A page picks its layout, and the page owns the `<NuxtLayout>`

**Status:** accepted.

**Context.** A consumer needed its legal pages rendered without the consent SDK its layout injects
unconditionally — the kind of per-page template choice every CMS offers and Kestrel had no answer for. There
was no per-record layout concept: `CollectionDef` carries `fieldLayout` (admin editor rows) and `editor`
(which admin body component), both admin-only. The public catch-all set no `definePageMeta({ layout })` and
`layers/public/app/app.vue` renders `<NuxtLayout>` with no `name`, so the layout always came from route meta
that nothing ever set.

The obvious alternatives are each closed. A second layout selected at runtime needs `setPageLayout()` or
`<NuxtLayout :name>` in `app.vue` — and that prop *wins over route meta*, so it would strip every admin page
of its `layout: 'admin'`. `definePageMeta` is a compile-time macro and cannot read a DB value.
`routeRules.appLayout` exists but freezes into the build, while `output.auto` means the runtime publisher
outlives it, so an editor's change would need a redeploy. The `seo` column cannot carry it either:
`seoSchema` is a closed `z.object`, so an extra key is stripped on save — a silent data loss.

**Decision.**
- A nullable `layout` **system column**, gated on `pageLike` like `path` — not a field on `pages.ts`.
  Collection files dedupe by basename with the consumer winning, so a consumer shadowing `pages.ts` would
  *drop* a field-based column and turn it into a destructive `rebuild_table` that both gates withhold. A
  system column follows any shadowing def that keeps `pageLike: true`, and covers a consumer's own pageLike
  collections too.
- The column is **deliberately not an enum** of the discovered layouts. The edit form re-sends every key on
  every save, so an enum would 400 every future save of a page whose layout file was later deleted — locking
  the record out of the admin. An unknown name degrades at render instead.
- The catch-all declares **`definePageMeta({ layout: false })`** and renders its own
  `<NuxtLayout :name fallback="default">`. Without `layout: false` both layouts nest.
- The resolver **coalesces every empty form to `default`**, and this is the subtle part: `layout: false`
  makes `route.meta.layout` the literal `false`, and NuxtLayout resolves `props.name ?? route.meta.layout`,
  where `??` keeps `false`. Passing an unset column through as `undefined`/`''` therefore renders the page
  with *no layout wrapper at all*, and `fallback` does not rescue it — it only applies to a truthy name
  missing from the layout map. Verified against prerendered output, not reasoned about.
- **Discovery reuses Nuxt's own resolution.** Nuxt already collects `app/layouts/*.vue` across the layers
  with the same name-first, consumer-wins dedup and fills `app.layouts` just before `app:resolve`, which
  runs inside `generateApp` ahead of template writing. So the module reads that map rather than scanning,
  filters out the `admin` shell, and emits a build-time constant. No `collectLayoutSfcs` sibling.
- The select **hides itself below two layouts**: a project with only `default` has nothing to choose. Its
  fallback entry stores `NULL`, never `''` — an unset value must stay distinguishable from a failed save,
  and `default` is not offered as its own value because an unset column already means it.

**Consequences.** A page's layout is editorial data, so changing it re-renders that route through the
existing invalidation path with no new plumbing. Existing projects are unaffected: the column is nullable
and additive, and a single-layout project sees no new control. One deliberate limit — the layout hangs per
**row**, not per translation group, so each locale is set independently.

A side effect worth more than the feature in some projects: the layout is now a **child** of the page rather
than its parent, so `usePublicPageState()` finally holds during SSR. As the parent it rendered before the
page had written the state, which made the composable's contract quietly untrue in static output.

**Future.** If a project wants the choice constrained (only these two layouts for these collections), that
belongs in a validation hook over the same column, not in the column's type — the render-time fallback is
what keeps a deleted layout from blanking a live page.

## ADR-0005 — Two scaffolder entry points over one template, and a build-time app-shell guard

**Status:** accepted.

**Context.** `pnpm add @michaelthielemann/kestrel` produces a project that does nothing. Nuxt does not
auto-load an installed package as a layer, so without a `nuxt.config.ts` that extends it, every route —
`/admin` included — serves the default Nuxt welcome page. Starting instead from `nuxi init` fails more
quietly: its `app/app.vue` renders `<NuxtWelcome />` and no `<NuxtPage />`, and because Nuxt resolves the
app root as `app.mainComponent ||= findPath(layerDirs…)` with the consumer's layer first, that file
shadows `layers/public/app/app.vue`. The router still runs (the URL rewrites to
`/admin/login?redirect=/admin`) but nothing renders, which reads as a missing admin route. A third step
then blocks anyone who gets past those two: sign-in answers 503 until `KESTREL_ADMIN_PASSWORD_HASH` is
set. Three independent, silent gaps between installing the package and reaching the admin — all
documented, none enforced or automated.

**Decision.**
- Ship a scaffolder as a `bin` on the **engine package** (`kestrel` → `scripts/kestrel.mjs`) with the
  template in `templates/starter/`. `bin` resolves by path from the package root, so it coexists with
  `main: './nuxt.config.ts'` and needs no `exports` map (which packaging forbids for unrelated reasons).
- Add a second, unscoped `create-kestrel` package for `pnpm create kestrel my-site`, because that is the
  command people already know from Nuxt and Vite. It carries **no dependencies**: its `templates/` and
  `lib/` are copied in from the engine by `prepack` and removed again by `postpack`, so there is exactly
  one source and drift is structurally impossible rather than merely tested for. From a checkout the bin
  falls back to the engine's paths, so it runs unpacked. Depending on the engine instead would pull the
  ~800-package tree the instant download exists to avoid.
- The two entry points do **not** behave the same, and that is the point: `create-kestrel` refuses a
  non-empty directory and names `kestrel init` as the tool for that case, while `kestrel init` merges.
  A `create-*` command that silently rewrote an existing project would be a footgun.
- The version is **not** rewritten at pack time. npm reads a manifest before running `prepack`, so a
  rewrite reaches the tarball contents but not the registry metadata — verified: the tarball is named
  from the pre-`prepack` version. Instead the two manifests are committed in lockstep, a test asserts it,
  and `prepack` refuses to pack a mismatch. This also keeps release.yml's tag guard meaningful, since it
  only ever reads the root manifest.
- `init` is **idempotent and additive**, because the most common caller is a project that already ran
  `pnpm add`: existing files are kept, `package.json` is merged key-wise with the project's own values
  winning, and `.env` is filled only where a key is absent or empty — re-running never rotates a live
  session secret. It asks once for a new admin password and writes the scrypt hash itself, so the
  documented three-command dance disappears.
- Keeping a file cannot mean declaring success. `init` ends with the `doctor` pass and exits non-zero
  while anything still breaks `/admin` — the `nuxi init` `app.vue` is precisely the case that survives a
  non-destructive scaffold.
- The engine reports the app-shell failure itself, at build time, from the `app:resolve` hook: an error
  when the resolved `app.vue` has no `<NuxtPage />`, a warning when it has no `<NuxtLayout>`. It only ever
  reports — assigning `mainComponent` here would defeat a legitimate consumer override, and the `||=`
  means a module-set value beats even the consumer's own file.
- The template emits `app/app.vue` rather than omitting it. Omitting it is what the layer already handles;
  emitting a *correct* one puts the trap in front of the operator with a comment explaining why both
  wrappers are load-bearing.
- Prerendering is exempt from the `KESTREL_SECURE_COOKIES=false is not allowed in production` assertion.
  `nuxt generate` runs at `NODE_ENV=production` and renders every page through `/api/route`, which passes
  the access guard and so calls `sessionSettings()`; a dev `.env` therefore made each page throw, dropped
  it from the static output, and still exited 0. A prerender request never issues a cookie, so the flag
  has nothing to protect there — the secret requirement still applies.
- Build-time approval of the native dependencies ships as `pnpm-workspace.yaml` with `allowBuilds:`, not
  as `pnpm.onlyBuiltDependencies` in the manifest. Verified: pnpm 11 ignores the manifest form outright
  (`ERR_PNPM_IGNORED_BUILDS`), so `better-sqlite3` and `sharp` never build and the scaffolded app cannot
  start; the workspace-file form is honoured by both pnpm 10 and 11.

**Consequences.** A consumer reaches a working admin in one command, and a broken project gets a named
cause instead of a blank page. The costs are real and permanent. A second publishable package means
another trusted-publisher registration on npmjs.com, a manual first publish (a trusted publisher cannot
be configured for a package that does not exist), one more step in the release job (see
[Releasing and dependencies](./releasing.md) for the count), and a release that can now fail between
packages. Releases must bump two manifests. And the `app.vue` rule has a second home: the
CLI is plain `.mjs` with no build step, so it cannot import the TypeScript guard, and the check exists in
both `scripts/lib/scaffold.mjs` and `layers/core/modules/kestrel/app-shell.ts` — a test drives both over
the same fixtures so they cannot drift. Two packaging traps are now load-bearing and pinned by tests: the
`files` whitelist's `!**/*.test.ts` negations are global, so nothing under `templates/` may be named that
way, and npm strips a literal `.gitignore` from a tarball *and then applies it*, taking its listed
siblings with it — template dotfiles are therefore `_`-prefixed and renamed on the way out.

**Future.** A `kestrel db migrate` CLI subcommand fits this bin. Further template variants (`--template
blog`, an extension-composing one) fit the same `templates/<name>/` layout with no change to the copy
mechanism.

## ADR-0004 — A real typecheck gate (`pnpm typecheck`)

**Status:** accepted.

**Context.** vitest and `nuxt build` both compile with esbuild — no type analysis — so type-class bugs
could reach `main` undetected (e.g. a helper's return object used as a string index: a runtime no-op only
caught by review). A real `tsc` pass surfaced two genuine defects — `FieldDef`'s open consumer arm made
`type` a non-discriminant, so no `f.type === 'x'` narrowing worked anywhere, and runtime-built tables were
typed `Record<string, never>`, breaking every Drizzle call — plus a wave of noise from Nuxt's
`noUncheckedIndexedAccess` default, which the project had never opted into.

**Decision.**
- Fix the two real defects: a generic `FieldTypeDescriptor<T>` gives each built-in descriptor its specific
  arm (`FieldOf<T>`); a `fieldIs(field, 'x')` type-guard restores narrowing at the call sites the open arm
  broke; runtime-built columns are typed `Record<string, AnySQLiteColumn>` (the honest shape). Both are
  type-only changes.
- Turn `noUncheckedIndexedAccess` off (in both `typescript.tsConfig` and `nitro.typescript.tsConfig` — Nitro
  generates the server tsconfig separately and must be set too). It was an unopted-into Nuxt default, not a
  project choice.
- The gate covers the full app, `.vue`, server, and standalone packages, tests excluded: `pnpm typecheck`
  (`scripts/typecheck.mjs`) prepares the playground (engine layers + both extensions + a consumer app) and
  runs three passes — `vue-tsc` over the app/`.vue`/config aggregator, `tsc` over the Nitro server project,
  and `pnpm --filter '@kestrel/*' -r typecheck` over the standalone workspace packages.

**Consequences.** Type regressions across app, `.vue`, and server now fail one gate. `typescript.tsConfig`
is not inherited from an extended layer, so a consumer composing `extends: ['@michaelthielemann/kestrel', …]`
repeats the `noUncheckedIndexedAccess: false` override in their own config. A few intentional `as`-casts
remain at the Drizzle dynamic-table seam (`crud.ts`, `buildCollection.ts`) — the honest price of a
runtime-built schema.

## ADR-0003 — Reference integrity: precise invalidation, warned-stale references, unique slugs

**Status:** accepted; revised once after the initial version left a gap (see Revision below).
Full treatment: [../guide/references.md](../guide/references.md) for the reference model, [./publishing.md](./publishing.md) for the invalidation walk.

**Context.** The runtime publisher re-renders static pages on content writes. A write to record *A* can
affect *A*'s own page, listing pages that query *A*'s collection, and explicit referrers that link/embed
*A*. The naive options are both wrong: re-render everything on every write (a cascade — slow, and
partially-built output mid-flight), or re-render only *A* (stale listings + dangling links). There was
also a data hazard: nothing stopped two records from claiming the same URL.

**Decision.**
- **Precise, per-event invalidation.** Capture, per published route, the data tags it read — `<coll>` for
  a listing, `<coll>:<id>` for an explicit referrer — in a durable `publish_deps` index (survives
  restarts). A write maps its changed tags back to exactly the affected routes: freshening (content/path
  change) re-renders listings and referrers; availability changes (publish/unpublish/delete) re-render
  listings **and referrers**, so a referrer is never left pointing at a stale live URL.
- **Links to a missing or draft target render `#`**; only a resolved, published target gets its real path.
- **Stale references are warned, not silently allowed.** A durable `record_refs` index over all reference
  types feeds dead-reference warnings, derived on read (so they auto-clear) — a list badge, page-builder
  markers, a `/admin/references` report, and a pre-delete "N records link here" check.
- **Output ≡ DB, pruning always-on** (no toggle): a record's own artifact is rendered when published and
  pruned when unpublished/deleted, on every target; a media delete prunes the original + all derivatives.
- **Slugs: required + auto-generated + globally unique per resolved route.** A blank slug is slugified
  from the title; uniqueness is on `localePath(path, locale, …)` across all pageLike collections (one
  route = one file). Enforced app-layer; the per-table `(path, locale)` index stays a within-collection
  backstop.

**Consequences.** A write re-publishes the minimum; the site is never half-rebuilt. Availability changes
re-render more pages than a naive per-record model — bounded by the durable `publish_deps` index, still
far short of a full cascade. A blank path never means "no URL": slug enforcement auto-generates one.

**Revision.** The first version took the cheaper option on two points: a link always rendered its target's
real path (so publishing later needed no re-render), and availability changes only re-rendered listings,
not referrers. That traded a *correct* referrer for a *cheap* one — an unpublished/deleted target left its
referrers pointing at a dead URL indefinitely, and a draft target's real path was a public 404 until it
went live. The decision above (dead/draft → `#`, availability re-renders referrers too) closes that gap;
the cost is a wider — but still bounded — re-render on availability changes.

**Future.** A reverse-index-backed "what links here" graph view; optional incremental re-render of
referrers behind a flag for sites that prefer freshness over build cost.

## ADR-0002 — Collection-derived DB schema with a runtime sync engine

**Status:** accepted — supersedes a static, consumer-facing drizzle-kit workflow.

**Context.** Kestrel ships as an installable Nuxt layer — the *consumer* defines collections
(`defineCollection`), so the table set is dynamic and unknown at Kestrel's build time. The static
drizzle-kit model (committed `schema.ts` + committed SQL migrations) can't cover collections it never
sees.

**Decision.**
- Schema is derived from collections (`buildTable(def)` → Drizzle table). Read the desired shape via
  `getTableConfig()`, introspect the live DB via `PRAGMA`, then diff → DDL. A thin sync engine over
  drizzle-ORM metadata handles consumer-defined collections without drizzle-kit.
- **Dev auto-syncs at boot; prod applies schema explicitly via the `db:migrate` Nitro task** (boot never
  auto-DDLs destructively in production) — mirrors Prisma's push/deploy split.
- **drizzle-kit is retained** for Kestrel's own built-in collections' committed migrations;
  `drizzle.config.ts` reads the same `kestrel.config.ts` as the app, so migrations and the runtime target
  one DB.
- **SQLite-first behind a `Dialect` interface** — Postgres is a defined but unimplemented slot.

**Consequences.** Define a collection, a table appears — no consumer-side migration authoring. The risk
surface is schema diffing: additive changes auto-apply; destructive/rename changes are gated (a rename
looks like drop+add — data loss risk); SQLite's ALTER limits force a table-rebuild for drop/rename/type
changes. Block content stays JSON (one column), keeping the diff surface small.

## ADR-0001 — Password hashing: native `scrypt`, not an Argon2/bcrypt addon

**Status:** accepted.

**Context.** Single-user admin auth; the repo stays slim (minimal compiled/native deps). Node ships a
memory-hard KDF (`crypto.scrypt`) built in — it does **not** ship Argon2. Both bcrypt and Argon2 require a
compiled native addon.

**Decision.** Hash with the built-in `node:crypto` scrypt (`N=2¹⁷, r=8, p=1, keylen=64`), stored
self-describing as `scrypt$N$r$p$salt$hash` (base64url). No third-party hashing dependency.
`scripts/hash-password.mjs` is only the operator one-liner that emits this exact format — it is **not**
used at runtime (the runtime path is `packages/kestrel-auth/src/server/utils/password.ts`).

**Consequences.** Zero dependency / zero supply-chain surface for auth. `scrypt@2¹⁷` is far more than
enough for one admin login. Trade-off: Argon2id (the PHC winner, more tunable) is not used today.

**Future (multi-user / multi-role).** Argon2id is a clean drop-in when we get there — *because the stored
hash is self-describing*:

- `verifyPassword` already branches on the leading `scrypt$` tag. Add an `argon2id$…` branch (e.g.
  `@node-rs/argon2`, a prebuilt native addon — no node-gyp build step).
- New/changed passwords write `argon2id`; existing `scrypt` hashes keep verifying. On a successful login
  against an old scrypt hash, transparently re-hash to argon2id (**rehash-on-login**). No forced reset.
- I.e. algorithm-agility is already latent in the hash format; the swap is **additive**, not a migration.

## See also

- [Architecture overview](./architecture.md)
- [Effect usage](./effect-usage.md)
- [Extension points](./extension-points.md)
- [Extending Kestrel](../guide/extending.md)
