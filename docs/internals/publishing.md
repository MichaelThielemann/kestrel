# Publishing and delivery internals

How Kestrel turns a content write into correct output: an immutable snapshot store as the source of
truth, delivery ports as a not-yet-wired adapter seam over it, precise invalidation with a durable
dependency index, debounce/coalesce/single-flight queuing, crash-safe publish runs, prune/reconcile, the
redirects write-effect, and the media prerender-scan reconcile.

## The snapshot / delivery split

Publishing and serving are split at a snapshot store (ADR-0013). Three parts:

- **Producer** — `publisher.ts`'s exported `publishRoutes` wraps the run in one `withResolveScope`, so a
  media/link/relation shared across pages resolves once per publish rather than once per embedding page;
  memo hits still replay their read-tags, so each page's dep capture stays complete. It delegates to the
  module-private `publishRoutesInScope`, which renders each route through the live server in-process,
  under a renderer principal that is always published-only (a draft never reaches static output even
  though the principal can read everything).
- **Store** — `packages/kestrel-publishing/src/server/db/snapshots.ts`'s `publishedSnapshots` table
  (`published_snapshots`), append-only. A route's rows form a chain: `current`
  (`supersededBy IS NULL`) → `superseded` (once a newer row is inserted for the route) → optionally
  `retracted` (`retractedAt` set on an unpublish; the supersede chain is untouched, so a retracted row
  can be superseded again later). A partial unique index on `route` where `superseded_by IS NULL`
  enforces at most one current row per route at the DB level; triggers make `supersededBy`/`retractedAt`
  set-once. The `'publish'` mode and a reconcile mismatch both call `recordSnapshot` before `driver.put`;
  a reconcile match reuses the row already there instead of writing a new one. Either way a snapshot
  always exists before delivery reads a route — a match just means it was recorded on an earlier pass.
- **Delivery ports** — a seam, not yet wired into the running publish path. `render-route.ts` reads
  through `currentSnapshot` and returns `{ body, status }` (404 when the route has no current snapshot);
  it is not wrapped by `createStaticDeliveryPort` — the two are independent halves of the static adapter
  over the same store: `render-route.ts` reads a route out of it, `port.ts`'s `createStaticDeliveryPort`
  writes/prunes the snapshots it is handed (`driver.put` / `driver.delete(..., { pruneEmptyDirs: true })`).
  `delivery-live`'s `port.ts` is a no-op adapter — every method (`publishSnapshot`, `removeRoutes`,
  `rebuildAll`) does nothing, because live delivery's actual request-time read is the catch-all in
  `layers/public/server/delivery-live/serve.ts` (exempt-path checks, trailing-slash normalisation,
  ETag/304 handling, `liveRedirectFor`, then `currentSnapshot`) — `delivery-live`'s `pipeline.ts` is the
  separate JSON read API (`deliverySnapshot`, routed at `/api/deliverySnapshot`). The static adapter's own
  TSDoc (`deliveryPortFor`, `render-route.ts`) says `publisher.ts` still writes files by rendering live and
  calling `driver.put` directly, so nothing in production calls `deliveryPortFor` yet; the live port's
  TSDoc says something narrower — that its write side is a no-op because `recordSnapshot`/`retractSnapshot`
  are already the persistence, independent of the delivery mode. What the split gives you today is the
  snapshot store as the single read surface — static and live still share that, even though neither goes
  through a `DeliveryPort` to reach it. See [Publishing](../guide/publishing.md) § Delivery: static vs.
  live and [Configuration](../guide/configuration.md) for the `delivery`/`deliveryExempt` config surface
  these ports will eventually sit behind.

**Reconcile** re-renders every published route on each full-publish pass and compares the fresh render's
fingerprint against the route's current snapshot: a match writes nothing (idempotent, and skips the file
write too when the output driver already has it); a mismatch supersedes with a new snapshot and
redelivers. This is what makes a reconcile pass self-healing against a missed invalidation (a crash
between a queue enqueue and its flush — the in-memory queue is not durable) or a template/component
deploy, without ever trusting a recorded snapshot unconditionally.

A route with unpublished changes is held back by every publish, full or incremental — when the save/publish
split is on (`output.publishOnSave: false`, the default; a full publish under `publishOnSave` holds
nothing back). Withholding is keyed to the record, not the route string, so a saved-but-unpublished rename
keeps serving its old URL rather than publishing the new one and pruning it. A record that has never been
published under any URL is never held back — a first deploy would otherwise produce an empty site. A held
route is frozen whole, links and hreflang included, at its own snapshot's publish generation; the route a
publish was explicitly *for* is exempt.

## Invalidation: the tag scheme

A write reaches the queue through the `planPublish` outbox handler (registered by
`layers/public/server/plugins/05.plan-publish.ts`) via `planWrite(ev, publishOnSave)`. Under the default
split, `planSaveInvalidation` lets only removals (unpublish, delete) through as a real invalidation — a
plain content save is a `noop`. The full classification below is what `planInvalidation` produces: the
explicit publish action, or any write at all once `publishOnSave` is on.

A content write is classified (`classifyWrite` in
`packages/kestrel-publishing/src/server/utils/publish/invalidation.ts`) against four kinds of dependents,
each captured as a tag while a page renders:

- **Listings** — a page that queries a collection depends on `<collection>`.
- **Explicit referrers** — a page that links to, embeds, or has a relation/media field to a record
  depends on `<collection>:<id>`.
- **Translation siblings** — every member of a translation group bakes the group's hreflang set, so each
  render captures `translationGroupTag(coll, group)` (`<coll>#group:<group>`). It rides every branch,
  create included: a new sibling still changes every existing member's hreflang set, and unlike the
  record tag (dropped on create — no referrer can target a brand-new id) there is no id to wait for.
- **Descendants** — a page whose path sits below a record's and bakes it as a breadcrumb captures
  **two** tags: `#path:<path>` and the `<collection>:<id>` of whatever sits there, invisible records
  included.

`#path:` exists because Kestrel has no parent/child relation between pages — nesting is only slashes in
a slug — so a page subscribes to every ancestor path it looked in, including paths with no page yet.
`<collection>:<id>` exists because a write's tags name where a record is *now*: the publish action
classifies its own write as `before === after` (a re-render of the record's current state), so a rename
or unpublish is invisible to the fresh tags alone — the record tag is what repairs the trail, captured
*before* the published/`noindex` filters so a currently-hidden row still carries the edge that fires when
it disappears.

```ts
// packages/kestrel-publishing/src/server/utils/publish/invalidation.ts
export function classifyWrite(
  def: WriteCollection, before: Row, after: Row, primaryLocale: string, prefixPrimary = false,
): WriteClassification
```

Every event re-renders a different mix of these — content edit, slug change, publish, unpublish, delete,
create, `noindex` flip — with the full per-event table in
[Publishing](../guide/publishing.md) § What a save invalidates. Two principles drive it: a content/path change
freshens dependents; an availability change re-renders both listings and referrers because a referrer's
baked output encodes availability (a draft/missing target bakes `#`), and the editor is warned on top.

The publisher records, per published route, the tags it read while rendering — a durable `route → tags`
index (`publish_deps`, via `deps.ts`/`deps-persistence.ts`) that survives restarts, so a route
unpublished or deleted while the server was down is still pruned on the next boot. `routesForTags` maps a
write's changed tags back to exactly the routes they affect; a normal content write never triggers a full
republish.

## Debounce, coalesce, single-flight

`createPublishQueue` (`packages/kestrel-publishing/src/server/utils/publish/queue.ts`) turns a burst of
writes into one run:

```ts
export interface PublishQueueOptions {
  run: (inv: Invalidation) => Promise<void>
  debounceMs?: number   // quiet window before a batch fires (default 3000ms)
  maxWaitMs?: number    // cap on how long writes can defer the flush (default 60000ms)
  onError?: (error: unknown) => void
}
```

Enqueued invalidations wait out the debounce window, capped by `maxWaitMs` so a steady stream of writes
cannot defer the flush forever. `coalesce.ts` merges everything collected in the window: any `full`
invalidation wins outright; otherwise the `tags`/`render`/`prune` sets are unioned; all-`noop` collapses
to `noop`. Only one run is in flight at a time (single-flight); anything enqueued mid-run defers to the
next pass, so a publish always converges on the *current* DB state rather than replaying a stale batch.
A failed run re-queues its batch instead of silently dropping writes.

The explicit publish action, `POST /api/publish` (`packages/kestrel-publishing/src/server/pipelines/
publish.ts`), enqueues through this same queue via `setPublishRuntime({ queue, deps })`, so a manual
publish and a write-driven incremental are serialized by one single-flight run rather than racing each
other. The boot publish also goes through the queue rather than calling `publishFull` directly, for the
same reason: `resumePublishRuns()` runs first and is awaited, then `queue.enqueue({ type: 'full' })`
fires — sharing the guard keeps the boot run from overlapping a write-triggered incremental or the
periodic reconciler, both of which share the module-level media-variant accumulator.

## Resumable publish runs

The queue, deps index, boot publish, reconciler and crash-resume below are all wired by
`layers/public/server/plugins/zz.publish.ts`, and only in production with `output.auto` on — in dev, or
with `output.auto` off, none of it exists and `planPublish` is a no-op because no runtime was set.

Each full run is a persisted, owned sequence in `publish_runs`
(`packages/kestrel-publishing/src/server/utils/publish/orchestrator.ts`), one row per run stepping
through `command` → `snapshot` → `delivery` → `done`. Only full runs — the boot publish, the reconciler, a
queued `{ type: 'full' }` — go through this sequence; a write-driven incremental run goes straight to
`publishInvalidation` and is deliberately untracked (see `zz.publish.ts`'s own TSDoc). The row is updated
in place at every transition — never appended — which is what makes the sequence durable across a crash
rather than an in-memory object the caller happens to hold. A `deliver` throw lands the row at
`status: failed` with the error message recorded, and returns the outcome as data rather than rejecting,
so the orchestrator itself never rejects for its direct callers. The queue's `run` wrapper re-throws a
recorded `failed` outcome (`publish run #<id|untracked> failed: …`), so the queue's own re-queue-on-failure
still applies on top.

`resumePublishRuns` runs at plugin init, before the boot publish is enqueued, and resolves every run a
crash left at `status: running` — there is at most one such row, since the update-in-place discipline
means a killed process can only ever strand the row it was last writing. Resume policy is *supersede, not
redeliver*: each stuck row is marked `failed` directly, with no delivery attempt, because the boot
sequence always enqueues an unconditional full publish right after this call — redelivering the crashed
run here would only duplicate that upcoming render. `pruneOldRuns` keeps the table bounded, dropping
non-`running` rows beyond the newest N; a `running` row is never a deletion candidate, so a crashed run
stays visible however old it gets. If `publish_runs` itself is unmigrated, a publish still runs —
untracked, with a logged warning naming `db:migrate` — rather than busy-looping on a missing table.

## Prune and reconcile

Pruning is always-on: no opt-in toggle exists to turn it off. `publishFull` computes the stale set —
routes the durable deps index (`publish_deps`, via `DepsStore`) says this publisher previously wrote that
are no longer in the freshly enumerated published set — with `staleRoutes(deps.routes(), routes)`, minus
the previously-published routes of a held-back record (`keep`, from `heldRoutes`): the old URL a
saved-but-unpublished rename is still serving, which the prune would otherwise delete. `prunePages` then
does the deletion itself: for each stale route it deletes the static file, clears the route's publish
status, and retracts its snapshot, so `currentSnapshot`/`currentRoutes` stop surfacing it. (A media
delete's original and derivative removal is separate: the `mediaCleanup` outbox handler on `media.deleted`,
not this prune.)

The prune has a fail-safe: it only runs `if (deps && !failed.length)`. A collection that could not be
enumerated makes every one of its live pages look stale by omission, so pruning against an incomplete
enumeration would wipe them from the output; instead the whole prune is skipped for that run, logged as
`publish: prune skipped — routes of <names> could not be enumerated; existing files kept`, and rendering
proceeds anyway (a stale extra file is recoverable, a deleted site is not).

`publishFull` is the full-republish path — it re-renders every published route (the fingerprint-based
reconcile above) and re-records every route's dependencies, so both the durable dependency index and the
snapshot store stay correct even after a template/component deploy that no content write would
invalidate. Nothing calls it as a normal content write; the two automatic triggers instead enqueue
`{ type: 'full' }` on the publish queue, which reaches `publishFull` through `publishInvalidation`: the
boot publish (`resumePublishRuns().finally(() => queue.enqueue(...))`) and, when `output.reconcileMinutes`
is set, a `setInterval` reconciler. The one caller that invokes `publishFull` directly, bypassing the
queue, is the operator-triggered `publish:run` Nitro task (`layers/public/server/tasks/publish/run.ts`) —
a documented exception. `publishFull` itself warns that it is "Deliberately NOT single-flighted": each
caller brings its own driver and `DepsStore`, so serializing overlapping triggers is left entirely to the
queue, and this out-of-band task sits outside that guard.

## The redirects write-effect

`redirects.json` is written outside the publish cycle: saving the Redirects singleton runs a CRITICAL
after-step (`registerAfterStep`, not a write listener) that writes the artifact immediately, so a
redirect goes live without pressing Publish. If that write fails, the save itself fails with a message
saying the artifact is stale and to save again — the row is already committed by then, so the retry is
not refused as a stale overwrite. The same artifact is re-rendered from the live DB at the end of every
publish run — incremental as well as full — and on every `nuxt generate`, alongside `sitemap.xml`,
`robots.txt` and the `llms.txt`/`llms-full.txt` artifacts — necessary because a
build-time S3 deploy reconciles the bucket against the build output, and an artifact the build never
produced would be pruned as stale. The write only lands where the output target *is* what the site is
served from (`output.auto: true` on either driver, or `auto: false` with the S3 driver); under the
classic `nuxt generate` build model a redirect saved to `output.dir` goes live with the next generate,
not on save. `redirect-rules.ts` compiles the authored wildcard rules into a flat, priority-ordered array of
anchored regex sources plus target and status — the edge only substitutes `$n` against a pattern that
already excludes the characters that would make substitution unsafe.

**The live redirect cache is per-process.** Under `delivery: 'live'`, `liveRedirectFor` lazily compiles
and caches the rules in memory; a save invalidates only the process that handled it
(`invalidateLiveRedirects`, called from the redirects singleton's after-step). A multi-process or
multi-replica deployment serves stale redirect rules from the other processes until their own next
invalidation or restart — there is no cross-process invalidation.

## Media prerender-scan reconcile

A full publish (or `nuxt generate`) also reconciles the media variant registry: every `<KestrelImg>`
render during that pass stashes the specs it declared, and at the end of the run those scan entries
replace whatever the registry previously held from a scan, while manually pinned entries are kept. This
is how a newly-added or newly-removed `<KestrelImg>` usage registers or deregisters a derivative size
without a separate step. `publishFull` calls `clearVariants()` before its render pass, so a run's
accumulator holds only what that run itself renders — an earlier incremental (tag) publish also feeds the
same module-level accumulator, and without the reset a variant it recorded whose usage was later removed
would survive into this run's reconcile.

The reconcile into the registry itself is gated: `saveDiscoveredVariants` only runs when
`!failed.length && !hold.size && rendered === renderRoutes.length` — no enumeration failure, no route held
back, every route in scope actually rendered. Any partial run leaves the accumulator incomplete, and the
held-back or un-rendered routes' still-live HTML references variants this run never saw; reconciling
against a partial accumulator would deregister those variants, and a later `media:backfill` run would then
delete them out from under a page that still links to them. A run that discovers nothing rendered at all
leaves the registry untouched rather than wiping it — a scan that finds zero usages is far more likely to
be a broken build than an intentional removal of every image. Backfilling existing media onto a registry
change, and pruning derivatives the registry no longer names, is a separate step (the `media:backfill`
task); see [media.md](../guide/media.md).

## See also

- [Publishing](../guide/publishing.md) — the operator-facing `output.*` config, the editor Publish
  button, and the Ampel status dots.
- [References](../guide/references.md) — dead-reference warnings and how internal links resolve.
- [Decisions](./decisions.md) — ADR-0008 (save vs. publish), ADR-0009 (redirects), ADR-0013 (the
  snapshot/delivery split), ADR-0025 (publish runs).
- [architecture.md](./architecture.md) — where the `public` layer's render path and the package layout
  fit around this.
