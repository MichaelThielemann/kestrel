# Extension points and ports

The catalog of seams a consumer or another module plugs into, and the rule that governs all of
them: no consumer-supplied function may return an unvalidated value into content. Most rows are
data or an adapter against an interface in `@kestrel/contracts`; a few — populators, outbox
handlers, event upcasts — are a bare function with a fixed signature instead, each constrained a
different way: a populator mutates an already-cloned bag and runs only at `depth > 0`; a handler's
input is a decoded, upcast envelope and its failure path is the retry/dead-letter ladder; an
upcast step is a pure payload transform with no ambient state.

## The catalog

| Extension point | Form | Boundary guard |
|---|---|---|
| Field types (`registerFieldType`) | Data: column + validator + optional transform | Thrown error on a malformed descriptor at registration; a name collision warns |
| Collections and blocks (`defineCollection`, SFC blocks) | Data — the def **is** the spec | Boot-time schema validation |
| Pipelines (`definePipeline`, patches, after-steps) | A step is an Effect run against engine-resolved ports | Sealed steps; `validateOut` quarantines a bad row on the read paths |
| Storage, media store, identity (`@kestrel/contracts` ports) | Adapter interface + per-method schema, paired at compile time | No implementation exists yet; the driver actually in use (`StorageDriver`) is a separate, unrelated interface |
| Populators (`registerPopulator`, `registerFieldPopulator`) | Registered functions that mutate a cloned bag in place | Runs only at `depth > 0` |
| Delivery (`DeliveryPort`) | Adapter that publishes an already-populated snapshot | Never reads a draft — the caller hands it the rendered snapshot |
| Policies and workflow | Rows in a table, not a code path | Property tests of the table's invariants |
| Extra grants (`registerAccessGrant`) | Data: a `(role, grant)` row added on top of the table | Throws on an anonymous wildcard grant and on a non-admin read grant without `scope: 'published'` |
| Event consumers (`registerOutboxHandler`) | Handler: decode envelope → command → pipeline | At-least-once delivery; a handler must be idempotent |
| Event upcasts (`registerUpcast`) | A pure `(name, fromVersion) → payload` step | Duplicate-pair rejection at registration; a gap in the chain dead-letters at dispatch |
| Discovery (`kestrelDiscovery`) | Data: collections/tables a package owns | First-party only — no runtime validation, `tsc` is the guard |

Every row except Discovery is decided by [ADR-0014](./decisions.md): an extension point is either
data a consumer supplies (a def, a descriptor, a manifest) or an adapter implementing an interface
exported from `@kestrel/contracts` — never a bare callback with no runtime contract. A callback is
invisible to the graph and whatever it returns lands in the system unchecked; a port pairs its
interface with a `Schema` per method in an `AdapterContract<T>` record, so adding a method without
a matching schema entry is a compile error rather than something a reviewer has to notice by eye.
The extension API is additive-only — removing or narrowing a member is a new major version, not a
patch. The ADR records the decision; this table records the shipped shape, and where the two
differ — the Pipelines, Storage, and Populators rows above all diverge from the ADR's own catalog —
this page is current.

## Field types

`registerFieldType(name, descriptor)`, from
`packages/kestrel-core/src/server/registries/field-types.ts`, adds a `column`/`validator`/optional
`transform` triple to the live field-type registry. A malformed descriptor throws at registration
rather than surfacing as a cryptic failure when a table is later built; re-registering an existing
name (built-in or not) warns instead of failing silently, since last-registered-wins is
deliberate.

```ts
export function registerFieldType(name: string, descriptor: FieldTypeDescriptor): void
```

The consumer-facing recipe (`defineFieldType`, auto-discovery from `server/field-types/`, the
matching client widget) is [Custom field types](../guide/custom-field-types.md).

## Pipelines

A pipeline step is an Effect run against `ctx.ports` — the engine resolves `db` and `event` before
the first step runs, and every step reaches I/O through that context rather than importing a
driver ad hoc — composed under `definePipeline` and registered with `registerPipeline`. Every
route under `/api/` is one of these, including the eight built-in CRUD operations, so patching a
default op and adding a wholly new action go through the same seam: `registerAfterStep` for
hooking a step onto an existing pipeline, a `{ replace: ..., unsafeReplace: true }` patch entry for
swapping a sealed step out. A sealed step is replaceable only through a patch entry that carries
`unsafeReplace: true`, so a consumer cannot silently drop a guarantee the engine relies on — the
read pipelines end in a sealed `validateOut` step that quarantines any row failing its
collection's select schema before the response leaves. That is the one real output check; there is
no per-step decode between the other steps, and `PipelineDef.input`/`output` feed OpenAPI
generation only, never a runtime check. The sealed-step and critical-section rules in full are
[Pipeline engine](./pipeline-engine.md); the consumer recipe for adding a pipeline or patching a
default op is [Custom pipelines and actions](../guide/extending.md).

## Storage, media, and identity: a port with no implementation yet

`StorageAdapter`, `MediaStorageAdapter`, and `IdentityProviderAdapter`
(`packages/kestrel-contracts/src/extension-points.ts`) are ports in the ADR-0014 sense — each
paired one-to-one with an `AdapterContract<T>` record, one `Schema` per method keyed to that
method's resolved value, so adding a method to the interface without a matching schema entry is a
compile error. That pairing is a static, compile-time property of the contracts package; nothing
implements these interfaces yet outside `packages/kestrel-contracts` itself and its own type-level
test, and no runtime decode of an adapter's return value happens anywhere in the codebase today:

```ts
export interface StorageAdapter {
  put(key: string, bytes: Uint8Array, contentType: string, opts?: PutOptions): Promise<void>
  delete(key: string, opts?: DeleteOptions): Promise<void>
  exists(key: string): Promise<boolean>
  list(): Promise<readonly string[]>
  publicUrl(key: string): string
}
```

`MediaStorageAdapter` extends `StorageAdapter` with the read/copy/stat/directory operations
upload, relocate, backfill, and on-demand derivation need; `IdentityProviderAdapter` stays a
single `verifyCredentials` method. Its TSDoc names the admin login step as the seam the port was
*sized from*, not one it currently serves: the login pipeline
(`packages/kestrel-auth/src/server/pipelines/auth.ts`) has its own `verifyCredentials` step that
calls `verifyPassword` directly and never touches this interface.

The blob storage actually built and used today is a different interface in a different package:
`StorageDriver` (`packages/kestrel-core/src/server/utils/storage.ts`), built by `createLocalDriver`
or `createS3Driver` and resolved via `useStorageDriver`
(`packages/kestrel-media/src/server/utils/storage.ts`). It is not shaped like `StorageAdapter` —
it adds `copy`, makes `get`/`exists`/`stat`/`ensureDir`/`removeDir`/`list`/`listPrefix` optional,
and takes `Buffer | Uint8Array` in `put` — and it carries no paired schema. Implementing a new
storage backend today means matching `StorageDriver`, not `StorageAdapter`.

## Populators

`packages/kestrel-core/src/server/utils/populate.ts` registers a `FieldPopulator` per field-type name:

```ts
export type FieldPopulator = (
  bag: Record<string, unknown>,
  key: string,
  field: FieldDef,
  ctx: PopulateCtx,
  keyMode: KeyMode,
) => void
```

The owning layer registers its own type's populator (`media`, `link`/`richtext`, `relation`) so no
layer bakes another's read logic into a lower layer's field-type descriptor. A `FieldDef` may also
carry an inline `populate` override that wins over the type-keyed populator for that one field; see
[Custom field types](../guide/custom-field-types.md) for writing one. The registries and the field-tree
walker that drives them are in
[Read-time population](./populate.md).

## Delivery

`DeliveryPort` (`packages/kestrel-contracts/src/extension-points.ts`) turns published snapshots
into what a visitor sees:

```ts
export interface DeliveryPort {
  publishSnapshot(s: PublishedSnapshot): Promise<void>
  removeRoutes(routes: string[]): Promise<void>
  rebuildAll(iter: AsyncIterable<PublishedSnapshot>): Promise<void>
}
```

Neither shipped implementation reads a draft or a live-rendered populate: the port's caller hands
it an already-populated `PublishedSnapshot`, so the port itself never reads the DB either way.
`createStaticDeliveryPort` (`packages/kestrel-delivery-static/src/server/port.ts`) writes the
snapshot's `html` through a `StorageDriver` and never re-renders or touches the DB.
`createLiveDeliveryPort` (`packages/kestrel-delivery-live/src/server/port.ts`) is three no-ops —
published content is served straight from `published_snapshots`
(`packages/kestrel-publishing/src/server/db/snapshots.ts`) at request time, independent of this
port, by two separate readers: the catch-all in `layers/public/server/delivery-live/serve.ts`
serves published HTML, and `packages/kestrel-delivery-live/src/server/pipeline.ts` serves the JSON
reads. `deliveryPortFor(delivery, driver)` picks between the two `DeliveryPort` implementations by
the `kestrel.delivery: 'static' | 'live'` config key, `'static'` by default. Persisting a snapshot
is `recordSnapshot` in `packages/kestrel-publishing/src/server/db/snapshots.ts`; producing the HTML
to persist is `layers/public/server/utils/publish/render-live.ts`, reached only from the
`render-seam.ts` set/get/clear indirection that keeps a Nitro-only primitive (`localFetch`) out of
the package. `deliveryPortFor` constructs both adapters, but nothing on the request or publish
path calls `deliveryPortFor` itself yet — the runtime publisher still writes through
`StorageDriver` directly (`publisher.ts`), under both delivery modes, so this section describes a
port that exists and is tested but is not yet in the path a visitor's request takes. The split and
its reconcile pass are [ADR-0013](./decisions.md).

## Policies and workflow

Authorization decisions and status transitions are rows in tables, not code paths a request falls
through. `packages/kestrel-access/src/server/utils/policy.ts`'s `POLICY: Record<Role, Grant[]>`
maps each role (`admin`, `renderer`, `anonymous`) to the actions and resources it grants;
`resolveAccess` flattens the table plus any per-request extra grants and asks `decide` for a
verdict. `packages/kestrel-core/src/server/core/workflow.ts`'s `transitions: TransitionRow[]` is
the equivalent table for content status: every legal `(from, to)` pair over
`'draft' | 'published'`, each optionally gated by a named guard the caller has already evaluated.
The workflow transition table is exhaustive and closed — growing it means adding a row and a
property test of the new invariant, not writing a new code path. The policy table has one
registration seam on top: `registerAccessGrant(role, grant)`
(`packages/kestrel-access/src/server/utils/grant-registry.ts`) is a boot-time server-plugin call
that adds an extra grant for a role on top of the hardcoded `POLICY`, feeding `resolveAccess`'s
`extraGrants` parameter. Two registration-time guards keep it narrow: an anonymous grant may never
target the `*` wildcard, and a non-admin read grant must set `scope: 'published'` explicitly.

```ts
export const transitions: ReadonlyArray<TransitionRow> = [
  { from: 'draft', to: 'published', guard: 'conditionsValid' },
  { from: 'published', to: 'published', guard: 'conditionsValid' },
  { from: 'published', to: 'draft' },
  { from: 'draft', to: 'draft' },
]
```

## Event consumers

`registerOutboxHandler(name, on, handler)`
(`packages/kestrel-core/src/server/db/outbox-worker.ts`) subscribes a handler to an event pattern
`<collection>.<verb>`, where `collection` may be the wildcard `*`:

```ts
export type OutboxHandler = (envelope: EventEnvelope) => Promise<void>
```

Delivery is at-least-once, never exactly-once: a crash between a handler finishing and its row
being marked processed redelivers the same envelope on the next poll, so a handler must be
idempotent — running it twice must converge on the same end state, not compound it. A handler
failure fails the whole batch registered for that event, including handlers that already
succeeded, and the batch retries together on a bounded exponential schedule before
dead-lettering. An event with no registered handler is still marked processed, since every write
emits its event regardless of whether anything subscribes. Before dispatch, `upcastToLatest` (`packages/kestrel-contracts/src/events.ts`) walks the envelope's
payload through any chain registered with `registerUpcast(name, fromVersion, fn)` from its
persisted version to the latest; a gap in that chain dead-letters the row rather than passing the
payload through unchanged, and registering the same `(name, fromVersion)` pair twice throws.
Revisions have their own separate `registerRevisionUpcast` registry (see
[Architecture decisions](./decisions.md), ADR-0026) — one registry does not serve both.

## Discovery: `kestrelDiscovery`

A package that owns collections, standalone schema tables, or an [ADR-0012](./decisions.md)
ownership manifest exports a `kestrelDiscovery: KestrelPackageDiscovery` object from its barrel.
Unlike the other rows in the catalog, this interface lives in `@kestrel/core`
(`packages/kestrel-core/src/server/utils/kestrel-discovery.ts`), not `@kestrel/contracts`, and it
is marked `@alpha` rather than `@public` — explicitly not part of the supported external API
surface, free to change shape without a major version bump, and not the seam a third-party
consumer uses; a consumer extends Kestrel through the ordinary layer-directory scan
(`server/collections/*.ts` and friends) covered in
[Custom pipelines and actions](../guide/extending.md). The producer lists
(`PACKAGE_COLLECTIONS`, `PACKAGE_SCHEMA_TABLES`, `PACKAGE_MANIFESTS`), which packages populate them
today, and the merge rule against layer-scanned items are in
[Layers and packages](./layers-and-packages.md).

## See also

- [Architecture decisions](./decisions.md) — ADR-0014's full context and consequences, and every ADR cited above
- [Pipeline engine](./pipeline-engine.md) — sealed steps, critical sections, and how the engine resolves `ctx.ports`
- [Read-time population](./populate.md) — the populator registries and the field-tree walker in full
- [Custom pipelines and actions](../guide/extending.md) — the consumer-facing recipe for pipelines and layer-directory discovery
