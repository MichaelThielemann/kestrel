# The pipeline engine

Every `/api/` endpoint runs as a pipeline — a named, declarative step list fronted by structurally enforced gates — and this page is the de facto spec for that surface.

`server/api/` holds exactly one file (`core/server/api/[...path].ts`) — the only bespoke route handlers left in the tree are static, non-pipeline endpoints (`sitemap.xml`, `robots.txt`, `llms.txt`, `llms-full.txt`, `redirects.json`, and the dev-only `__kestrel/dashboard`). Types live in `packages/kestrel-core/src/server/pipeline/types.ts`. Full design rationale: [ADR-0010](./decisions.md).

## Context — facts, ports, exec, and work

A step receives one `PipelineContext<TIn, TOut>`:

```ts
interface PipelineContext<TIn, TOut> {
  input: TIn                        // the caller's payload (parsed body for a write, the query object for a read)
  id?: number                       // the record id from the route, if any
  readonly facts: RequestFacts      // plain value: collection (name), op, principal, readScope, locale, now, correlationId, causation
  readonly ports: PipelinePorts     // shell only: db, event
  readonly exec: ExecPlane          // engine-owned, frozen: collection (BuiltCollection), read, request
  output: TOut                      // becomes the response
  work: Record<string, unknown>     // inter-step scratch — before-row, computed values, batch ids…
  trace: TraceCollector
}
```

`facts` and `ports` are resolved by the engine **before step 1** — principal and `readScope` come out of gate
evaluation, `now`/`correlationId`/`causation` are stamped once so every step and the outbox envelope for the
run agree on them. `facts.collection` is the bare name (`''` for a collection-less pipeline like `login`); a
step needing the full `BuiltCollection` reads `ctx.exec.collection` via `collectionOf(ctx)`, not `facts` — a
resolved collection carries schemas/functions, not a plain value. `ports.event` is the raw `H3Event`, present
only for an HTTP-driven run (`null` for a programmatic/trusted one); a step that owns transport state (the
login throttle, the session cookie) reaches it through `eventOf(ctx)` rather than importing h3 helpers ad
hoc.

`exec` is a fourth, engine-owned plane — `collection`, the resolved read-scope flag, and the transport
request snapshot (ip/method/headers) — resolved once before the first step and frozen at construction; gates
and steps read it, nothing writes it afterward. It is engine-owned and frozen because a security-relevant
gate must not read `collection`/`read`/`request` out of mutable `work`: `evaluateAccessGate` and the CSRF/IP
gates all read `ctx.exec.request`/`ctx.exec.read`, never `ctx.work`.

`PipelinePrincipal` is declared structurally in `core` (`{ userId, role }`) so the engine never imports
`access` — the real `Principal` type in `access` satisfies it by shape.

## Gates — declarative, not list members

A pipeline's `access`/`csrf`/`ipAllowlist` are declarations (`GateSpec`), evaluated by the engine **before
step 1**, never patchable (not even via `unsafeReplace` — they aren't in the step list at all), and fully
introspectable. This is the one enforcement point: a route no longer has its own authorization logic to
drift from the pipeline's.

- **`access`** (`AccessSpec: { public?, role?, scope?, resource? }`) — missing ⇒ the engine refuses to run
  the pipeline at all. A write's default is `{ role: 'admin' }`; a read's default is derived per collection
  (`readAccessFor` in `defaults.ts`): `{ public: true, scope: 'published' }` on a `pageLike` collection,
  `{ role: 'admin', scope: 'all' }` otherwise. `role` and `scope` are declarative documentation, not what the
  evaluator reads to decide — the gate authorizes by `resource` (defaulting to the collection name, or the
  pipeline's own name for a collection-less one) against the *principal's* grants, and `readScope` likewise
  comes from the principal's own grants, not from `spec.scope`; the only part of the spec that changes the
  decision is `public: true` together with `scope: 'published'`. `resource` lets a pipeline authorize against
  something other than its own collection name — the editor tooling reads (`options`/`translations`/`deadRefs`/
  `schema`/`referrers`) declare `resource: '<collection>/<tool>'` so a public read grant on the bare collection
  can never reach them. The real evaluator is `evaluateAccessGate`
  (`packages/kestrel-access/src/server/utils/pipeline-gates.ts`) — it delegates to `resolveAccess`, which is
  a thin shell around the pure `decide` core (`packages/kestrel-access/src/server/core/decide.ts`:
  `decide(principal, action, resource, facts, policyTable)`, no I/O, role/action/resource policy rows as
  data). There is exactly ONE decision engine — every consumer (the gate, `isPubliclyReadable`, the sitemap,
  the publisher, `llms.txt`, the relation populator) goes through `resolveAccess`, so a pipeline run and a
  still-guarded route can never resolve the same request two different ways. A public READ declaration
  without `scope: 'published'` throws at evaluation time (would silently expose drafts).
- **`csrf`** — default **required** for every non-read op (`resolved.read` decides, not a hardcoded op-name
  set); opt out only explicitly.
- **`ipAllowlist`** — from the global config; the renderer principal and in-process sub-requests are exempt
  (build-time prerender, the runtime publisher's own render).

Gate order is **ipAllowlist → csrf → access**, so a bad IP or a cross-origin write never turns into a
misleading 401. `login`/`logout` are pipelines too (`packages/kestrel-auth/src/server/pipelines/auth.ts`) —
`login` is the one pipeline with `access: { public: true }` on a *write*, since nobody can hold a session
before they have one; the CSRF gate still applies. A slim rest-guard
(`layers/access/server/middleware/access-guard.ts`) remains only as the jurisdiction for whatever URL no
pipeline claims — an unknown path, a stray consumer route mounted under `/api` without its own pipeline —
evaluated with today's role/grant policy, default-deny. That is a different jurisdiction from the gates, not
a duplicate of them.

## Steps

`type StepFn = (ctx: PipelineContext) => Effect.Effect<void, KestrelError>` — named, mutate `work`/`output`,
and RETURN an expected failure as a value (`Effect.fail(new SomeTaggedError(...))`), never throw one. A step
may still `throw` a value that is not a `KestrelError` — a genuinely transport-level survivor (a router 405,
a throttle 429, a service-unavailable 503 — none of which fit the tagged union), or a real bug — and the
engine's `Cause.squash` at the outer `Effect.runSync`/`runPromise` boundary is the bug net for that; it is
not a channel a step body writes to on purpose. `syncStep`/`asyncStep` (`pipeline/types.ts`) both take this
same Effect-returning `fn` — the distinction between them is `sync: true` for the critical-section brand
(below), not the type of `fn`. The engine runs the composed list in order (`Effect.gen`), times each step,
and aborts on the first failure — `toHttpError`
(`packages/kestrel-core/src/server/utils/kestrel-error-map.ts`) is the one place a `KestrelError` becomes an
HTTP response; a step body never builds one itself.

Two helpers in `pipeline/steps/shared.ts` bridge the few remaining call sites that still produce a failure
outside a step's own `Effect.gen` — a plain helper nothing has converted, or a nested pipeline run
(`runWrite`/`runPipelineSync`) that reduces its own Effect back to throw-or-return at its own boundary:
`fromThrowing`/`fromThrowingAsync` reclassify a `KestrelError` throw/rejection into a proper `Effect.fail`
and leave anything else a defect, unchanged. New step-body logic should reach for `Effect.gen`/`Effect.fail`
directly rather than these — they exist for bridging, not as the normal way to fail.

A JS `try`/`catch`/`finally` around a `yield*` does not observe an Effect failure — see
[Effect in this codebase](./effect-usage.md) for the mechanism and why the runner's own gate/async bridge
relies on the opposite case.

- **Critical section.** Everything between the first and last `sync: true` step of a composed list must
  contain no `await` — better-sqlite3 writes are synchronous, and that's what makes the section race-free
  for slug uniqueness / optimistic concurrency (TOCTOU); `assertUnique → persist` is the reason the flag
  exists, not the extent of the section. `StepDef.sync` marks a step as part of it;
  `assertCriticalSection` (`pipeline/registry.ts`) rejects a non-`sync` step sitting between the first and
  last `sync` step of a composed list **at compose time**, never at request time. A bad patch fails loud at
  boot. In every built-in write pipeline all steps are `sync`, so the critical section spans the whole
  composed list — a step inserted anywhere except before the first step must itself be built with `syncStep`
  or the patch fails at boot.
- **Sealed steps** (`validate`, `checkConcurrency`, `assertUnique`, `assertAllExist`, `persist`,
  `emitEvents`, `loadRollbackTarget`, `validateOut`, and the read-scope
  enforcement inside `fetch`/`populate`) can only be replaced through a patch entry carrying
  `unsafeReplace: true` — the explicit "I know I'm dropping a guarantee" escape hatch. `loadBefore`/
  `loadBeforeMany` are ordinary, freely-patchable steps; `assertAllExist` — the all-or-nothing 404 guard
  a batch op runs right after loading its rows — is the sealed one. Every other step is freely patchable.
- **After steps** (`AfterStepDef: { step, critical }`) run **post-persist**, in-process, outside the
  critical section. `critical: false` — errors are logged into the trace, the save stays green.
  `critical: true` — a failure becomes the response even though the row is already committed. `writeRedirects`
  is the only production after-step — it stays synchronous-with-the-save on purpose (a redirect must
  exist before the response that implies it does), and the surface remains open for a consumer/extension
  after-step with the same need. `reindexRefs`, `mediaCleanup` and `planPublish` — everything that can
  tolerate not being synchronous with the save — are outbox handlers, not after-steps; see Outbox handlers
  below. `registerAfterStep({ step, critical, ops?, on? })`
  (`pipeline/registry.ts`) is the one registration mechanism, and any number of independent plugins can each
  register their own onto the same op (after-only registrations are exempt from the one-registration-per-op
  collision check).
- **Conditional steps** declare `when(ctx) => boolean` (+ a human-readable `whenLabel`) — e.g. `resolveSlug`
  only runs for a `pageLike` collection, or on update only when the route actually changed. A skip shows up
  in the trace as `skipped-condition`, with the step's `whenLabel` (or a default message) as the detail — not
  silently.

## definePipeline — a naming convention, registered explicitly

`server/pipelines/**` in every layer, extension and the consumer project is a plain naming convention, not
an auto-discovered one (unlike `server/collections/**` and `server/field-types/**`): a file there exports a
builder function, and a plugin must call `registerPipeline`/`registerAfterStep` on its output for the
pipeline to exist — every in-tree pipeline is wired this way, from a Nitro plugin such as
`layers/auth/server/plugins/01.register-auth-pipelines.ts`. **Nothing may resolve a pipeline (or read the
collection registry) at plugin-init time** — the default pipelines install lazily on the first request
(`hasDefaultPipelines()` / `registerDefaultPipelines`), and a consumer's own registration must follow the
same rule. This is the same invariant the collection registry has (see
[architecture.md § Server plugins](./architecture.md)), now extended to pipelines — violating it in a
CONSUMER's own plugin (still auto-scanned, not declared data the way Kestrel's own are) may happen to work
by accident of that plugin's scan position and break silently for a different consumer, or after Kestrel
adds a plugin ahead of it.

```ts
export function buildNotePipelines(): PipelineDef[] {
  return [definePipeline({
    name: 'archiveNote',                    // or one of the 8 standard names, to override/patch it
    on: { collection: 'notes' },            // omit ⇒ applies to every collection (or a collection-less global pipeline)
    access: { role: 'admin' },
    steps: [...],                           // a full replacement list, OR:
    patch: [
      { before: 'persist', step: sanitizeHtml },
      { replace: 'transform', step: myTransform, unsafeReplace: true }, // only if `transform` were sealed
    ],
    after: [{ step: writeRedirects, critical: true }],
    ui: { kind: 'bulk', label: { en: 'Archive' }, icon: 'archive', confirm: true }, // surfaces as an admin action
    input: mySchema,                        // documentation only — feeds `_openapi`, never validated by the engine
    output: myResultSchema,
  })]
}
```

The worked consumer example — registering this from a Nitro plugin and the plugin-order proof for where it
runs relative to Kestrel's own — is in
[extending.md](../guide/extending.md).

Boot-time validation (`registry.ts`) fails loud, never 404s at runtime: the eight `STANDARD_OPS` names —
`createOne`, `createMany`, `readOne`, `readMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany` — are
reserved (an override must carry the op's own name via `op`); `duplicate`/`rollback` are built-in default
pipelines but are not among them, so a def named `duplicate` with a full `steps` list resolves as an
unrelated collection-less global pipeline at `/api/duplicate`, not as an override. A second registration
carrying `steps` *or*
`patch` for the same (collection, op) collides — only after-only registrations stack; a collection-less def
with a full `steps` list and a non-standard name is a
**global** pipeline scoped to `/api/<name>` only — `registerCollection` and `registerPipeline` reject a name
collision between a collection and a global pipeline in both directions, so `/api/collections` is safe as a
pipeline name.

## The default pipelines

`pipeline/defaults.ts` composes these from named steps in `pipeline/steps/*`;
`packages/kestrel-core/src/server/utils/crud.ts`'s `create`/`update`/`remove`/`list`/`getOne`/`getSingleton`
are now three-line delegates over `runWrite`/`runRead`.

The atomic outbox insert happens earlier, inside `persist`'s own `better-sqlite3` transaction
(`emitOutboxForUnit`, called from `persist.ts`); `emitEvents`, the last critical-section step, runs strictly
after that statement and only snapshots one write event per touched row onto `ctx.work.events` for after-steps
to read — see Outbox handlers below for what dispatches off it afterward.

| op | steps | after-step (critical) | outbox event |
|---|---|---|---|
| `createOne`/`createMany` | validate → resolveLocale → resolveSlug → transform → assertUnique → persist → emitEvents | – | `<collection>.created` per row |
| `readOne` | fetch → populate → validateOut | – | – |
| `readMany` | parseQuery → fetch → attachMeta → populate → validateOut | – | – |
| `updateOne` | loadBefore → checkConcurrency → validate → resolveLocale → resolveSlug(when routeChanged) → transform → assertUnique → persist → emitEvents | **writeRedirects** (`redirects` singleton only) | `<collection>.updated` |
| `updateMany` | loadBefore → assertAllExist → validate(patch) → persist(atomic) → emitEvents | – | `<collection>.updated` per row |
| `deleteOne` | delegates to `deleteMany`'s step list over `[id]` — one flat trace, no nested run | – | `<collection>.deleted` |
| `deleteMany` | loadBefore → assertAllExist (404 all-or-nothing) → persist(atomic) → emitEvents | – | `<collection>.deleted` per row |
| `duplicate` (built-in default, not a `STANDARD_OPS` name) | one `sync` step that runs `createOne` per id, strictly sequentially (so a second copy's slug de-dupe sees the first) | – | `<collection>.created` per row |
| `rollback` (built-in default, not a `STANDARD_OPS` name) | loadRollbackTarget → persist → emitEvents | – | `<collection>.updated`, or `<collection>.created` if the record was tombstoned |

`readOne`/`readMany` both end in the sealed `validateOut` — the output-quarantine step that shapes the
response through the same schema the write path validated against, before it ever reaches a caller.

Every collection also gets five **tooling reads** (`options`, `translations`, `deadRefs`, `schema`,
`referrers`) — admin-only, `resource: '<collection>/<tool>'` (the `deadRefs` op authorizes against the
literal resource string `'<collection>/dead-refs'`, not `deadRefs`). Singleton `updateOne` (no `:id`) is the
singleton write path; `deleteMany`/`updateMany({patch:{status}})`/`duplicate` cover batch delete,
publish/unpublish, and duplicate. `updateMany` is deliberately never listed as an admin action (see below,
under Admin actions from the schema) — its status-patch use stays the admin's own Publish/Unpublish
presentation.

## Outbox handlers

`reindexRefs`, `mediaCleanup` and `planPublish` are driven off the transactional outbox: `persist` (and, for
media's own synthetic writes that bypass core CRUD, `media-write.ts`'s `emitMediaOutbox`) inserts an
`EventEnvelope` row into `outbox_content` in the SAME `better-sqlite3` transaction as the write it describes
(`db/outbox.ts`, `pipeline/steps/persist.ts`), so the row committing and the event existing are one atomic
fact — never a save that "succeeded" with no trace of it for a consumer to pick up.

A single poller (`db/outbox-worker.ts`, wired by `core/server/plugins/04.outbox-worker.ts`, `setInterval`
unref'd so it never blocks process exit) reads pending rows and dispatches each to every handler registered
for its event name via `registerOutboxHandler` (`Map<eventName, handler[]>`; a collection-scoped
`<collection>.<verb>` and a bounded wildcard `*.<verb>` both dispatch — no regex, no predicates). The
per-collection handlers use the explicit `registerXxx()` pattern (`registerReindexRefs`,
`registerMediaCleanup`, `registerPlanPublish`), each called from its own layer's plugin —
`layers/core/server/plugins/05.reindex-refs.ts`, `layers/media/server/plugins/05.media-cleanup.ts`,
`layers/public/server/plugins/05.plan-publish.ts` — rather than at module import, so a test can
register/clear handlers deterministically. An event with **no** registered handler is marked processed
anyway (every write emits its event regardless of subscribers, so an unsubscribed event must not grow the
table without bound) — that row never reaches `_outbox/dead`; only a handler that actually ran and
exhausted its retries does. Before dispatch, `upcastToLatest` (`packages/kestrel-contracts/src/events.ts`)
walks the envelope's payload through any registered upcast chain from its persisted version to the latest; a
gap in that chain dead-letters the row rather than passing the payload through unchanged. See
[extension-points.md § Event consumers](./extension-points.md) for the handler-author side of this contract.

Contract every handler is written to: **at-least-once, exclusivity scoped to a single process.** The claim
itself is a CAS against the row's `attempts` count, but the CAS alone does not stop a staggered second read
from claiming successfully too — what actually keeps two `pollOnce` calls from overlapping in real operation
is `makeTicker`'s in-process in-flight guard; there is no cross-process exclusivity at all. A handler failure
is never swallowed: `RETRY_ATTEMPTS = 6` (the initial claim plus 5 retries) on an exponential schedule —
200ms, 400ms, 800ms, 1.6s, 3.2s — then dead-letters (visible at `GET /api/outboxDead`, admin-only, authorized
against the `_outbox/dead` resource) —
there is no bus that logs-and-continues here the way `critical: false` after-steps do. A restart finding a
row already at or past that budget dead-letters it immediately, without granting a fresh ladder of attempts.
A retry re-runs **every** handler registered for the event, including ones that already succeeded in the
failed attempt — idempotency is a per-handler property, not a per-event one. A handler must therefore be
idempotent under redelivery: `reindexRefs` re-reads the record's CURRENT row rather than trusting the
envelope as a diff, `mediaCleanup` deletes a storage key that may already be gone (a no-op), and
`planPublish` enqueues into a set (union, not append). `updated` envelopes carry `{ before, after }` (both
full rows); `created`/`deleted` carry the row itself.

## Revisions — the write-path step

`persist` appends a full snapshot to the collection's `<collection>_revisions` table — an append-only
history alongside the collection's own (still-current) table — inside the SAME `better-sqlite3`
transaction as the record write (`db/revisions.ts`, `pipeline/steps/persist.ts`), so a committed row and
its history entry are one atomic fact. A delete appends a tombstone revision instead of removing history,
so a later restore can tell "genuinely deleted" from "merely missing." `rollback`
(`POST /api/<collection>/rollback/<id>`, body `{ revision }`, admin-gated) is its own pipeline —
`loadRollbackTarget` → `persist` → `emitEvents` — which restores a target revision's snapshot as the
record's current state and composes the same write invariants as the other write pipelines:
unique-conflict handling, status-transition gating, richtext sanitisation, and current-schema validation
with an upcast step run before decode.

The table shape itself — tombstones, the `schema_version` def-hash each revision carries, the
`registerRevisionUpcast` registry that bridges an older snapshot forward on read, and the retention pass
(`revisions: { keep, maxAgeDays }`) the outbox worker runs off the request path on its idle tick, with
absolute protections for the newest/only revision and a tombstoned record's last-alive state — is in
[data-model.md § Revisions and tombstones](./data-model.md). The consumer-facing side, reading revision
history and triggering a rollback over the API, is in [guide/revisions.md](../guide/revisions.md).

## URL grammar

**`/api/<collection>/<pipeline>[/<id>]`** for a collection operation, **`/api/<pipeline>`** for a
collection-less one (login, publish, `_pipelines`). Read pipelines are `GET` (no CSRF, cacheable); write
pipelines are `POST`. `core/server/api/[...path].ts` is the *only* route file, a method-agnostic catch-all —
its low radix precedence is what lets an explicit route file (a consumer's own bespoke handler) still
win, and avoids the param-name collision two sibling dynamic routes (`/api/[pipeline]` +
`/api/[collection]/[pipeline]`) would create. `packages/kestrel-core/src/server/utils/pipeline-route.ts` (`parsePipelineRoute`) is
the one decoder: a positive integer is a record id, a pipeline name never is (`/api/pages/42` 404s;
`/api/pages/readOne/0` is a 400). A wrong verb on a real pipeline is a 405 — but only for an authenticated
caller; an anonymous prober gets the guard's 401/403 instead, so a probe can't use the verb error to
enumerate which pipelines exist. Reads take the whole query string as `input` through one builder; writes
take the parsed body verbatim, unless the pipeline declares `rawBody: true` (multipart uploads, ciphertext
bodies, a size-capped stream — the router leaves `input` undefined and the step reads the event itself).
`runPipelineForEventAuto` (`packages/kestrel-access/src/server/utils/pipeline-run.ts`) picks the sync driver
unless the composed pipeline has a non-`sync` step or a critical after-step, keeping the
`assertUnique → persist` window await-free wherever possible.

## Introspection & tracing

`GET /api/_pipelines` (admin-only, itself a pipeline) lists every routable pipeline, composed live from the
registry — never a parallel description — via `buildPipelineIndex()` (`pipeline/introspect.ts`): route,
gates, every step's `name`/`sync`/`sealed`/skip-condition, every after-step's `name`/`critical`. Alongside it,
`_openapi` (admin-only, generates its document from every pipeline's `input`/`output` schemas) and the global
tooling pipelines `collections`/`brokenRefs` are the other built-in collection-less pipelines a consumer can
call the same way.

`?debug=pipeline` embeds the run's trace (`$pipeline`) into the response for an admin caller only — an
object result gets it spread on as a `$`-prefixed sidecar (like `$media`), an array or bare value is wrapped
under `{ data, $pipeline }`. In dev, every run also logs one summary line
(`[kestrel] pipeline <collection>/<op> step=Xms ... total=Yms`), inside a `finally` so a gate denial or a
step error still logs. `GET /__kestrel/dashboard` (dev only) and `pnpm dashboard` (static
`docs/dashboard.html`, gitignored) render the same registry live as one browsable page instead of a JSON
response per request.

## Admin actions from the schema

A pipeline's optional `ui: { kind?, label?, icon?, confirm? }` (`PipelineActionUi`) is how a custom write
pipeline surfaces as a generic admin action without any admin-side code: `buildCollectionActions`
(`packages/kestrel-core/src/server/utils/collection-actions.ts`) lists the built-in `deleteMany`/`duplicate`
(`kind: 'both'` by default, overridable by the pipeline's own `ui.kind`) plus every consumer-registered
custom write pipeline on that collection that isn't an override of a standard op, a tooling read, or
`rollback` — a consumer registration defaults to `kind: 'bulk'` instead. `rollback` needs a revision number a
generic action button has no way to supply, so its own `ui: { kind: 'record', confirm: true }` stays
introspection-only metadata rather than a listed row. `serializeCollection` carries the list out as
`SerializedCollection.actions`. The admin (`useCollectionOps`/`useListBatchActions`) resolves the label, runs
a `confirm()` gate when declared, then POSTs `{ids}` (bulk) or hits `.../<name>/<id>` with no body (record)
and refetches on success.

## Rules modules behind the gates

Compose-time structural enforcement — critical-section and sealed-step checks, the sync brand, name-collision
checks — lives in `packages/kestrel-core/src/server/pipeline/registry.ts`. Request-time gate evaluation and
route jurisdiction are a separate, `access`-owned pair of modules: `packages/kestrel-access/src/server/utils/pipeline-gates.ts`
(the `access`/`csrf`/`ipAllowlist` evaluators) and `pipeline-claim.ts` (which URL the pipeline router, as
opposed to the legacy route guard, is the authority for). Underlying access policy (who may read/write what)
lives in `packages/kestrel-access/src/server/utils/policy.ts` and `guard.ts`. All of these are authored
decision tables, not derived from content — CI proves the *derived* registries and indexes rebuild from
sources of truth, but a rules module like these is never regenerated, only reviewed as code.

## See also

- [decisions.md](./decisions.md) — ADR-0010 (pipeline design), ADR-0021/0022 (outbox contract), ADR-0024 (envelope shape).
- [../guide/extending.md](../guide/extending.md) — the worked `definePipeline`/`registerAfterStep` example and plugin-order proof for a consumer project.
- [../guide/revisions.md](../guide/revisions.md) — the user-facing side of revision history and rollback.
- [architecture.md § Server plugins](./architecture.md) — plugin registration order and the lazy-resolve invariant pipelines share with the collection registry.
