# Architecture overview

Orientation to the boot sequence, the registration mechanisms that govern what runs when, and the seams that bite when a change crosses a layer boundary.

## Server plugins — execution order is data, not filename sort

`layers/core/modules/plugin-order/plugin-order.ts` owns the execution order of every plugin the six layers
that ship Nitro server plugins ship: an explicit, declared `PLUGIN_ORDER` array, pushed into Nitro's plugin
config ahead of Nitro's own directory scan. The declared order is **core → fields → media → auth →
collections → public**, filename order within each layer, pinned as data. A plugin file
present on disk but missing from `PLUGIN_ORDER` (or a declared entry with no file behind it) fails the
build loudly (`validatePluginOrder`), rather than Nitro silently auto-appending it in an undeclared
position. Each entry also states whether it is order-sensitive and why — either the real dependency its
`after` list encodes, or the evidence it's safe to reorder — and `validatePluginOrder` checks that claim
against the array's actual positions, not merely asserts it.

**Invariant that makes order irrelevant for the registry specifically: no plugin reads it at init.**
`02.schema-sync` reads the `#kestrel/collections` virtual directly (never `allCollections()`); `00.migrate`
reads nothing from it — it only runs committed migrations, unrelated to the collection registry. The
ref/cleanup/publish plugins only register *deferred* pipeline after-steps or outbox handlers; and the
boot publish's own registry read sits after an `await` inside `publishFull`, so it resumes only once the
synchronous plugin loop — including `collections/01.register.ts` — has already finished. A future plugin
that calls `allCollections()`/`getCollection()` at init would work in-repo but break (empty registry) for a
real consumer — there is no compile-time signal for this, only the convention.

**One documented exception with a real cross-layer dependency:** `public/server/plugins/
00.ensure-snapshot-triggers.ts` needs its snapshot table to already exist, which only `core`'s
`00.migrate.ts` (a committed migration, in-repo) or `02.schema-sync.ts` (the schema engine, for a
consumer) can have created — satisfied by `PLUGIN_ORDER` placing every `core` plugin before it. It
tolerates the miss rather than depending on the guarantee forever: a boot before either provisioning path
has run logs a warning and returns instead of crashing (see `ensureSnapshotTriggers`'s own TSDoc).

**The ADR-0029 eager-barrel-load hazard is closed at the package boundary, not the plugin-order boundary**
— see [Layers and packages](./layers-and-packages.md) § Dependency direction for the full account. A
future `00.*` plugin cannot reintroduce the hazard through ordering, because nothing depends on ordering
for it any more.

The real, current sequence, derived from `PLUGIN_ORDER` (`find layers -path '*/server/plugins/*' -not -name
'*.test.ts'` matches it exactly — 23 files, none missing, none phantom; a plain `ls` also picks up three
`*.test.ts` siblings that `isPluginFile` in `plugin-order.ts` excludes):

1. `core/server/plugins/00.config.ts` — resolves the config once (`runtimeConfig` preferred, Kestrel's own
   config file + env as fallback) and pushes it into `@kestrel/core`'s config provider
   (`setResolvedKestrelConfig`); ordered before `00.migrate.ts`, whose `useDb()` needs the provider
   populated already. Package code never calls `useRuntimeConfig()` itself — it can't, since it doesn't
   live inside the Nuxt app — so `locale.ts`, `db.ts`, `revision-retention.ts`, `delivery.ts` and
   `kestrel-publishing`'s `site-url.ts` all read the resolved value back through
   `getResolvedKestrelConfig()`, the same provider this plugin fills.
2. `core/server/plugins/00.migrate.ts` — runs committed drizzle-kit migrations only if
   `server/database/migrations/` exists (Kestrel's own repo; absent when consumed as a package).
3. `core/server/plugins/01.register-introspection-pipeline.ts`, `01.register-openapi-pipeline.ts`,
   `01.register-tooling-pipelines.ts` — each pushes a pipeline into the registry `Map`; read lazily on
   first request, never at another plugin's init, so their relative order doesn't matter.
4. `core/server/plugins/02.schema-sync.ts` — dev auto-applies additive ops; `import.meta.prerender` returns
   immediately. Production never DDLs but runs a read-only drift check at boot: a loud `console.warn` for
   missing additive changes (run `db:migrate`) and an informational `console.info` for destructive ones
   `db:migrate` withholds.
5. `core/server/plugins/04.outbox-worker.ts` — starts the unref'd `setInterval` poll loop against the
   outbox table and registers the `_outbox/*` admin pipelines (`buildOutboxPipelines`); order-free for the
   same reason as item 3 — read lazily on first request, nothing else depends on when polling starts.
6. `core/server/plugins/05.reindex-refs.ts` — registers the `reindexRefs` handler on the outbox bus
   (dispatched later, never at another plugin's init).
7. `fields/server/plugins/01.register-blocks-pipeline.ts`, `01.register-field-populate.ts` — register the
   blocks pipeline and the single global row populator; individual field populators (media/link/richtext/
   relation) are looked up at read time, so this plugin's order versus the layers that register them
   doesn't matter.
8. `media/server/plugins/01.register-media-pipelines.ts` — registers the media pipelines.
9. `media/server/plugins/02.register-media.ts` — registers the `$media` field populator.
10. `media/server/plugins/04.variant-capture.ts` — hooks the render request context and stashes
    discovered variants during SSR; reconciled per-render, no dependency on another plugin's init order.
11. `media/server/plugins/05.media-cleanup.ts` — registers the `mediaCleanup` outbox handler.
12. `auth/server/plugins/01.register-auth-pipelines.ts` — registers the `login`/`logout`/`session`
    pipelines.
13. `collections/server/plugins/01.register.ts` — registers every discovered collection + block into the
    runtime registry (reads the `#kestrel/collections`/`#kestrel/blocks` virtuals directly).
14. `collections/server/plugins/02.register-relation-populate.ts` — registers the relation field
    populator.
15. `public/server/plugins/00.ensure-snapshot-triggers.ts` — the one real cross-layer dependency,
    described above.
16. `public/server/plugins/01.register-public-pipelines.ts` — registers the route/preview/createPreview
    pipelines.
17. `public/server/plugins/02.register-links.ts` — registers two field populators, `link` and `richtext`;
    the latter is what resolves internal links embedded inside rich-text bodies, not just standalone link
    fields.
18. `public/server/plugins/03.redirects.ts` — registers the CRITICAL `writeRedirects` after-step
    (`when`-scoped to the `redirects` singleton), which publishes `redirects.json` synchronously with the
    save — its rejection becomes the save's response, since the row is already committed.
19. `public/server/plugins/05.plan-publish.ts` — registers `planPublish` on the outbox bus: under the
    default (`output.publishOnSave: false`) a save only ever removes output (unpublish/delete) and
    rendering waits for an explicit publish; with `publishOnSave` on, a save plans a full invalidation and
    renders. It reads the registry
    and every populator/ref hook when the outbox worker dispatches it, well after plugin init, so a
    published page renders fully populated regardless of boot order.
20. `public/server/plugins/zz.publish.ts` (`zz` sorts last within the `public` layer) — owns the publish
    queue and deps index, publishes through the runtime publisher, and runs the boot publish and the
    optional reconciler through the persisted publish-run sequence. The queue, deps index and both publish
    runs are gated on `output.auto` and skipped in dev — a dev publish would write Vite-dev HTML with no
    hashed `_nuxt`, so item 19's `planPublish` is a no-op in those modes too. The boot publish is detached:
    `runNitroPlugins` runs synchronously and unawaited, so it never blocks server startup.

## Module & task registration — what governs what

Five distinct registration mechanisms, not one — each already correct, named here so "is this wired
through Kestrel" has one place to check instead of re-deriving it per file:

- **Nitro server plugins** (`server/plugins/**`): governed by `layers/core/modules/plugin-order` — see
  above. The outbox worker (`core/server/plugins/04.outbox-worker.ts`) is one of these, not a separate
  mechanism.
- **Nitro server middleware** (`server/middleware/**`): disk-scanned by Nitro, still filename-sorted
  (hence `00.ip-allowlist.ts` running before `access-guard.ts`), not governed by `plugin-order`. Four files
  exist: `layers/access/server/middleware/00.ip-allowlist.ts`, `layers/access/server/middleware/
  access-guard.ts` (see Cross-cutting seams below), `layers/media/server/middleware/ondemand-variants.ts`,
  and `layers/public/server/middleware/delivery-live-catchall.ts`.
- **The `#kestrel/*` virtuals** (collections/schema-tables/module-manifests/field-types/blocks): governed
  by `layers/core/modules/auto-discovery`.
- **Nuxt build-time modules that are themselves plugins to Nuxt, not to Nitro** (`prerender-routes`,
  `prune-media`, `deploy-output`): registered in `layers/public/nuxt.config.ts`'s own `modules:` array, in
  the declared order that file states inline (`prune-media` before `deploy-output` so the bake is pruned
  before it ships). This is the correct mechanism for a Nuxt *build*-time module — `plugin-order` governs
  Nitro *server* plugins specifically and has no jurisdiction here. `deploy-output`'s Nuxt module wrapper
  stays where it is — a build-time module can only be registered from a layer's `nuxt.config.ts`, never
  from a package — but its S3 upload/reconcile logic lives in `@kestrel/delivery-static`, the same
  layer/package split every other server-side extraction uses. `contentTypeFor`/`cacheControlFor` (the
  content-type and cache-control rules for static output) are not part of that split: they're defined in
  `@kestrel/core` and imported by `@kestrel/delivery-static`, the same way any other package consumes them.
- **Nitro's own disk-scanned directories** (`server/tasks/**` — db-migration, media-backfill
  (`media/server/tasks/media/backfill.ts`) and publish tasks (`public/server/tasks/publish/run.ts`, the
  operator-triggered manual publish run `public/server/plugins/zz.publish.ts` names as a documented
  exception to the queue); `server/api/**` — the one catch-all route; `server/routes/**` — the SSG artifact
  routes (`sitemap.xml`, `robots.txt`, `llms.txt`, `llms-full.txt`, `redirects.json`) plus the dev dashboard
  at `core/server/routes/__kestrel/dashboard.get.ts`): Nitro scans these itself, by its own convention,
  independent of any Kestrel module. There is no ordering question for a task (invoked by name, on demand,
  never as part of a boot sequence) or for these routes (each answers one fixed path, nothing to order
  against).

## Cross-cutting seams

The things that live *between* layers and bite if you don't know them:

- **Registry.** `core` owns a module-level `Map`
  (`packages/kestrel-core/src/server/utils/registry.ts`), but it's **filled by `collections`**
  (`01.register.ts`) from the auto-discovery virtuals — which scan *every* layer's `server/collections`,
  and **extract** every layer's `app/blocks/*.vue` SFCs into the block registry
  (`packages/kestrel-core/src/server/blocks/registry.ts`). Drop a def/block file in any layer and it's
  discovered.
- **`BuiltCollection`.** The contract (`def + Drizzle table + drizzle-zod insert/update/select`) is both
  declared and constructed in `core` — `buildCollection` lives at
  `packages/kestrel-core/src/server/schema/buildCollection.ts`, re-exported from the package's own index.
  `layers/fields/server/` holds only plugin registration; no compiler code lives there.
- **Populate pipeline.** Two distinct mechanisms, not one: `registerPopulator` (`fields`) composes
  order-independent row populators that walk every field regardless of type; `registerFieldPopulator`
  registers a populator keyed by field *type*, looked up at read time — `media` for `media` fields,
  `link`/`richtext` for internal-link resolution (`public`), `relation` for FK expansion (`collections`).
  Both run **only at `depth > 0`**; list/get default to `depth 0` (raw FK ids). `$`-prefixed keys (`$media`,
  `$translations`) never collide with user fields.
- **Auth context.** The `access-guard` middleware returns immediately for any path outside `/api/`
  (default-deny is API-only); otherwise it resolves `event.context.principal` and, for a path no pipeline
  claims, applies today's role/grant policy default-deny — except an `admin` principal, which falls through
  an unclaimed path deliberately so the router can still answer 404/405 without that answer itself
  confirming to an anonymous prober which pipelines exist. Every pipeline-claimed path is authorized by its
  own `access`/`csrf`/`ipAllowlist` gates, evaluated by the pipeline engine before step 1; the middleware
  also calls `refreshAuthSession(event)` for sliding-expiry on every authenticated request.
  Anonymous visitors get published read on **every** page-like collection — the `publicReadableResources()`
  set, derived from those read pipelines' `access` declarations, which the guard, the sitemap and the
  relation populator all consult. It bounds `?depth` on the generic `readMany`/`readOne` pipelines: an
  anonymous read there expands relations only into that set. Two limits it does not cover: the populator
  consults the public set alone, not the full gate decision (it omits `registeredGrants()`), so a resource
  opened via a one-off access grant is served on its own route but still withheld from a populated sidecar
  (fail-closed drift, so nothing leaks); and `/api/route`, the public render entry, is granted to every
  principal and populates in full for all of them, so a relation into a non-public collection is expanded
  there — gating it by role is not a local fix, since the renderer needs full population or the live
  anonymous render would diverge from the baked page. How the populator applies the set in detail is in
  [populate.md § Relations](./populate.md#relations). (Contract: `layers/access/server/types.d.ts`.)
- **jsKey ↔ dbName.** Not the cross-layer seam it looks like: both halves of the rule live in `core` —
  `isSingleRefColumn` (`defineCollection.ts`) decides whether a `relation`/`media` field is stored as a
  single FK column, and `resolveColumnName` (`naming.ts`) uses it to map that field's key to `<key>Id` /
  `<key>_id` (everything else uses the snake_cased key). The serializer carries the outcome across the wire
  as a `single` flag on `SerializedField`, so `admin`'s `field-keys.ts` (`jsKey()`, plus `list-columns.ts`)
  and core's `app/utils/filter-ops.ts` read the flag instead of re-deriving the rule — one source of truth,
  so client and server can't silently drift on which columns get the `Id` suffix. The mapping itself is
  [data-model.md § jsKey ↔ dbName](./data-model.md); the client side that reads the flag is
  [admin-ui.md § Field wire keys](./admin-ui.md).
- **`asFieldDef` bridge.** `admin/app/utils/edit-form.ts` casts a wire `SerializedField` back to a
  `FieldDef` (a single cast, not per-arm reconstruction) so widgets can consume the serialized schema.
- **Component namespace.** Every component the engine ships is registered with a `Kestrel` prefix and an
  explicit dir priority above the consumer's app directory (`core`'s `component-namespace` module +
  `kestrelComponents()` in each shipping layer's `nuxt.config`). Nuxt drops a prefix the filename already
  carries, so `KestrelImg.vue` stays `KestrelImg` while `ui/Button.vue` becomes `KestrelUiButton`. Without
  it a consumer's `app/components/ui/Icon.vue` claims the same global name as ours and wins, silently
  replacing the admin's. `app/Kestrel/components/` is the one seam that outranks the layers.
- **Block components.** `BlockRenderer` resolves `Blocks<PascalType>` by **name string** via
  `resolveDynamicComponent`; the actual components are the block SFCs in `app/blocks/`, registered as
  global `Blocks<Name>` components by the auto-discovery module's `addComponentsDir({ prefix: 'Blocks',
  global: true, pathPrefix: false })` — the same SFC the build extracts the schema from.
- **Schema engine.** Collection-derived, dialect-agnostic: model → desired/introspect → diff → render →
  sync. Dev auto-applies *additive* ops; destructive ops are gated; production uses the `db:migrate` task.
  Only SQLite is wired (a `postgres` slot fails loud).

## Where to start

[Working on Kestrel § Where to start](./README.md) holds the newcomer's reading order through the source —
the type model, the schema/table compiler, a real collection def, the pipeline defaults, and the one
catch-all API route — with the current file paths for each stop. [Per-layer guide](./layer-guide.md) is the
same question asked per layer: for each of the nine layers, what it owns, which file to open first in it,
and its traps.

## See also

- [Layers and packages](./layers-and-packages.md) — the package cut and dependency direction this page
  assumes.
- [Pipeline engine](./pipeline-engine.md) — gates, steps and the URL grammar the registered pipelines run.
- [Layer guide](./layer-guide.md) — the per-layer reading order.
- [Populate](./populate.md) — the depth/public-set rules the populate pipeline seam only summarizes here.
- [Data model](./data-model.md) — the jsKey ↔ dbName / `single`-flag seam in full.
- [Publishing](./publishing.md) — the publish queue, deps index and boot publish behind items 18-20.
- [Admin UI](./admin-ui.md) — the `asFieldDef` bridge and the component namespace, from the admin side.
- [Architecture decisions](./decisions.md)
