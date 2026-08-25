# Layers and packages

Kestrel's physical cut: the Nuxt layer diagram, the ten `@kestrel/*` packages, the dependency rule between them, and how a package is discovered at runtime.

## Layer model

Kestrel is physically two things at once: a stack of Nuxt **layers** (`layers/<name>`, the Nuxt-native wiring — `nuxt.config.ts`, components, composables, server plugins/routes) and a set of independently versioned `@kestrel/*` **packages** (`packages/kestrel-*`, plain TypeScript with no Nuxt dependency, holding the server-only domain logic). A layer's server code mostly re-exports or thinly wraps its matching package; the package is what a non-Nuxt consumer can `npm install` and call directly.

Every layer lives in `layers/<name>` with a Nitro side (`server/`) and/or a Vue side (`app/`). Auto-imports work across layers — server utils/routes and app composables/components are used without an `import` from other layers.

```
core ───────────────► the model + data engine + config + schema engine + populate registry
  ▲  fields ────────► built-in field-type descriptors + the defineFieldType authoring API + block-definition helper
  │  ui ────────────► the admin design system (Field*/Ui* components, tokens, i18n)
  │
  ├─ auth ──────────► authN: stateless session cookie, scrypt password, login
  ├─ access ────────► authZ: default-deny /api guard, policy/grants, CSRF
  ├─ collections ───► the toggleable `pages` built-in + the register plugin
  ├─ media ─────────► uploads, driver selection, derivation, folders, the media library + viewer
  ├─ admin ─────────► the editor SPA (collection list, record editor, block editor)
  └─ public ────────► the SSG render path (catch-all page, BlockRenderer, sitemap/robots/redirects, deploy)
```

`core` is the strict foundation: every other layer imports it, it imports none of them. The registry mechanisms (field-type lookup, block lookup) and the pure helpers `core` calls directly (`resolveColumnName`, `sanitizeRichtext`, `regenerateBlockIds`, `extractRecordRefs`, the `buildTable`/`buildFieldSchema`/`buildCollection` compiler) live in `core`; `fields` seeds those registries with its built-in field-type descriptors at module load and keeps the descriptor-authoring API (`defineFieldType`, `constrain`/`opt`/`optArr`) plus the block-definition helper. The `fields` layer itself is now thin — `layers/fields` holds only `nuxt.config.ts` and two registration plugins (`01.register-blocks-pipeline.ts`, `01.register-field-populate.ts`); the descriptors and authoring API live in the `@kestrel/fields` package. The domain layers (auth/collections/media/admin/public) compose those two.

The `media`-owned `folders` table is not named by `core`: the schema engine takes every non-collection table generically via `extraTables` (`#kestrel/schema-tables`), and `folders` reaches that virtual through `@kestrel/media`'s `kestrelDiscovery.schemaTables` export (`packages/kestrel-media/src/index.ts`, sourcing the table from `server/database/folders.ts`) — the package route (see "Discovery: `kestrelDiscovery`" below), not the layer-directory scan — see [ADR-0012](./decisions.md).

### Where to start reading

The newcomer's reading path through the source — the type model, the schema/table compiler, a real collection def, the pipeline defaults, and the one catch-all API route — lives in [Working on Kestrel § Where to start](./README.md). What this page adds on top of it is the physical layout those files sit in: `layers/collections/server/plugins/01.register.ts` is where the `pages` def reaches the registry, and [The pipeline engine](./pipeline-engine.md) is how a URL becomes a running pipeline.

## The package cut

The server-side domain logic lives in ten independently versioned `@kestrel/*` packages under `packages/`, each with its own `package.json`, its own `src/index.ts` public entry, and its own test suite. What each one owns:

- **`@kestrel/contracts`** — the single source of Kestrel's system specification: tagged error unions, branded ids, event payloads, the port/manifest interfaces (`DeliveryPort`, `OwnershipManifest`), and the response envelope, shared between the engine and its consumers.
- **`@kestrel/core`** — the content model types, the field-type and block registries, the schema/table-building pure functions, the storage drivers (`StorageDriver`, the local and S3 implementations), the pipeline engine, and the request-scoped read-capture/resolve-scope primitives.
- **`@kestrel/fields`** — the built-in field-type descriptors, the block-definition helper, and the field/block content-population walkers.
- **`@kestrel/auth`** — the stateless single-admin session/auth domain: password hashing, the signed session cookie and its revocation epoch, login-throttling, and the `login`/`logout`/`session` pipelines.
- **`@kestrel/access`** — the authorization (authz) domain: the request principal, policy decisions, CSRF, the IP allowlist, and the pipeline `access`/`csrf`/`ipAllowlist` gates.
- **`@kestrel/collections`** — the built-in `pages` collection and the relation field populator.
- **`@kestrel/media`** — uploads, driver selection from the resolved media config, derived variants, folders, and the media/media-settings collections.
- **`@kestrel/publishing`** — the `publish_deps`/`publish_status`/`publish_runs`/`published_snapshots` tables, the publishing db adapter, the runtime static publisher, the publish orchestrator (`packages/kestrel-publishing/src/server/utils/publish/orchestrator.ts`), the publish/publishRuns pipelines, and the built-in `site` and `redirects` collections.
- **`@kestrel/delivery-live`** — the live delivery adapter: serves published content from `published_snapshots` at request time (redirects, the read pipeline, the `DeliveryPort`).
- **`@kestrel/delivery-static`** — the static delivery adapter: writes/prunes published snapshots through a `StorageDriver` (the build-time deploy target), plus the S3 static-output shipper.

`create-kestrel`, the project scaffolder, is not one of the ten — it is a CLI, not a runtime dependency of a Kestrel site.

The split is not one package per layer: several packages (`@kestrel/contracts`, `@kestrel/delivery-live`, `@kestrel/delivery-static`) have no matching layer at all, and `@kestrel/core` holds both the model/registries and the pure schema-building cores. The cut line is "server-only domain logic with no Nuxt dependency," not "one-to-one with the layer diagram."

## Dependency direction

Packages never import layers, and layers import packages only by their bare `@kestrel/*` name — never by reaching past a package's public entry (`src/index.ts`) into its internals. `test/architecture/layer-edges.test.ts` enforces both directions with two separate scans: one walks `packages/*/src/**` and flags any file importing from `layers/**`; the other walks `layers/**` and `extensions/**` and flags any file reaching past a package's entry into its `src/` internals (plus a dedicated rail forbidding a static `@kestrel/media` import inside `packages/kestrel-publishing/src/**`). A graph-derived check separately allowlists every cross-*layer* edge individually (`test/architecture/edge-allowlist.json`) so a new one can't appear silently.

A package may depend on another package — `@kestrel/media` depends on `@kestrel/fields` and `@kestrel/core`, for instance. Each package declares its `@kestrel/*` dependencies in its own manifest; pnpm resolves and builds them in topological order, and `test/architecture/publish-order.test.ts` checks that the hand-written release/consumer-CI package lists stay consistent with that derived dependency graph. There is no rail asserting the package graph itself is acyclic, unlike the cross-layer edge allowlist above.

Each package's eager module-load graph is itself a boot-order hazard distinct from the import-direction rule above: importing a package's barrel can trigger side effects (field-type registration, table definition) before a consumer's own plugins have run. See [Architecture overview § Server plugins](./architecture.md) for how this is closed at the package boundary (the ADR-0029 eager-barrel-load hazard) and [ADR-0029](./decisions.md) for the record.

## What deliberately stayed a layer

`admin`, `ui`, and the `app/` (component/composable) halves of `media` and `public` are **not** bridged into packages — there is no `addComponentsDir`/`addImportsDir` module doing so. This is a ruling, not an oversight: the per-component override mechanism `layers/core/modules/component-namespace` implements (`Kestrel/components/<Name>.vue` in a consumer's own `srcDir`, resolved at a higher `addComponentsDir` priority than Kestrel's own) depends on Kestrel's own components being real, Nuxt-scannable `.vue` files in a real layer — a package's compiled `dist` output cannot participate in Nuxt's component-resolution priority system the same way. `admin` has the most riding on this, since it registers by far the most components under `kestrelComponents()`; bridging it would cost that override story for no boot-order benefit the app-side files need. See [Decisions](./decisions.md) for the fuller record.

None of the `admin`/`ui` composables (`useEditForm`, `useBlockTree`, `useToast`, …) need an equivalent story: every one is editor-internal state/logic, none carries a `useKestrel*` prefix, and none is imported outside Kestrel's own layers — a consumer builds their own UI against collections/pipelines/field types instead, see [Custom pipelines and actions](../guide/extending.md).

## Discovery: layer-side virtuals

The layer side of discovery predates the package cut and still does the disk scanning: `layers/core/modules/auto-discovery` scans every layer's `server/collections/*.ts`, `server/schema-tables/*.ts`, `server/field-types/*.ts`, `server/db/manifest.ts`, and `app/blocks/*.vue`, and exposes the result as five Nitro virtual modules — `#kestrel/collections`, `#kestrel/blocks`, `#kestrel/schema-tables`, `#kestrel/module-manifests`, and `#kestrel/field-types`. The last one is not scan-only: it renders the `@kestrel/fields` seed plus whatever a layer or consumer contributes under `server/field-types/*.ts` — the hook a consumer uses to register their own field types. Every virtual imports the field-type seed first, because building a `BuiltCollection` or extracting a block's schema needs the field-type registry already populated — each virtual imports the real `@kestrel/fields` package directly, on top of (not instead of) `#kestrel/field-types`: the package import guarantees the built-in seed loads even if the virtual chain misbehaves, and the `#kestrel/field-types` import brings in whatever a layer or consumer contributes under `server/field-types/*.ts`.

`layers/collections/server/plugins/01.register.ts` reads `#kestrel/collections` and `#kestrel/blocks` at boot to fill the runtime registry — drop a def or block file in any layer and it is discovered without further wiring. The other two virtuals feed different consumers: `#kestrel/schema-tables` is read by `layers/core/server/plugins/02.schema-sync.ts` and the `db:migrate`/`db:migrate-module` tasks, and `#kestrel/module-manifests` by the `db:migrate-module` task, both at schema-sync/migration time rather than at collection-registry boot.

Because the scan runs at build time, not runtime, adding a new collection or block file requires a dev-server restart (or a fresh build) to show up in the virtuals — the same as any other Nuxt auto-import addition.

The scan dedupes `collections`/`field-types`/`schema-tables` files and block SFCs by basename (block name for blocks), first (highest-priority layer) wins — so a higher-priority layer's same-named `server/collections/x.ts` (or `field-types/x.ts`, or a block SFC) shadows a lower one; `#kestrel/module-manifests` is concatenated, never deduped. Layer priority is `nuxt.options._layers` order, which differs by context: the root `nuxt.config.ts`'s explicit `extends` list (core → fields → ui → media → auth → access → collections → admin → public) drives order for a consumer, while this repo's own Nuxt auto-scan of `layers/` takes precedence in reverse-alphabetical order instead. Cross-layer basenames must stay unique to avoid depending on that difference.

## Discovery: `kestrelDiscovery`

See [Extension points § Discovery: `kestrelDiscovery`](./extension-points.md) for the `KestrelPackageDiscovery` contract itself (the interface shape, where it's defined, the `@alpha` rationale, and why there's no runtime validation). What's specific to this page is the layer side's producer bookkeeping: `layers/core/modules/auto-discovery`'s `package-registry.ts` keeps the producer list per category (`PACKAGE_COLLECTIONS`, `PACKAGE_SCHEMA_TABLES`, `PACKAGE_MANIFESTS`), not one flat list — a virtual only imports a package that actually contributes to its own category, so building the schema-tables virtual never eagerly touches `@kestrel/collections`, which has none. Of the ten packages, `@kestrel/media`, `@kestrel/collections`, and `@kestrel/publishing` are the only producers today.

Auto-discovery merges each package's `kestrelDiscovery` items with the consumer's own layer-scanned items (`server/collections/*.ts` etc.) into one list, keyed by name, package items first: a same-named layer item overrides a package's, matching the runtime registry's own last-registered-wins semantics — so the schema engine can never see two same-named collections and silently build a duplicate table.

`test/architecture/kestrel-discovery.test.ts` checks the `PACKAGE_*` lists against every real workspace package's actual `kestrelDiscovery` export, so a package that starts or stops contributing a category and forgets to update the matching list fails a unit test rather than a runtime 404.

## Module classification

Every server-side module falls into exactly one of three classes, independent of whether it lives in a package or a layer. The distinction drives what CI must guarantee: a **source of truth** module is never reconstructed — losing it is data loss; a **rules** module encodes a decision procedure, not a fact, so its output varies with its input but the module itself is authored, not derived; a **derived** module can always be thrown away and rebuilt from the sources of truth plus the rules, and CI runs that rebuild for every one of them (`pnpm vitest run test/architecture/derived-rebuild.test.ts`).

### Module boundaries

`test/architecture/ownership-graph.test.ts` asserts, from the import graph, that no file outside a module's own file set imports that module's table object — the file set is a load-bearing boundary, not just a folder convention:

- **media**'s file set is `packages/kestrel-media/src/**` (the server domain, now a package) plus `layers/media/**` (the remaining app-side layer and its thin Nitro wiring) — together, one module.
- **publishing**'s file set is `packages/kestrel-publishing/src/**` plus the whole `layers/public/server/**` layer (`delivery-live/`, `middleware/`, `pipelines/`, `plugins/`, `routes/`, `tasks/`, `utils/publish/render-live.ts`), wider than `packages/kestrel-publishing/src/server/pipelines/publish.ts` + `database/`/`db/` alone — legitimate importers of `publish_deps`/`publish_status` exist outside that narrower set within `layers/public/server/**`, so narrowing the boundary to match the folder layout would make the ownership test lie about who is allowed to touch these tables.
- **content**, for this check, is scoped to `record_refs` only within `packages/kestrel-core/**` — not touched by media or publishing; content's other tables are per-collection, registered dynamically by a consumer's own `defineCollection` calls, so they have no static table-object export for the import graph to see; the adapter/runtime tests (`ownership.content.test.ts`, `derived-rebuild.test.ts`) are what covers those instead.

A module boundary here is about a **table object**, not a whole domain: it stops a file elsewhere from importing e.g. `media`'s Drizzle table and querying it directly, bypassing whatever invariant `media`'s own functions enforce on writes to that table. Reading through the collection/pipeline API is unrestricted; reaching past it into the raw table is what the test catches.

### Sources of truth

| Item | Owning module |
|---|---|
| Content records + translations | `layers/collections` (e.g. `packages/kestrel-collections/src/server/collections/pages.ts`), rendered per-collection by `packages/kestrel-core/src/server/utils/defineCollection.ts` / `packages/kestrel-core/src/server/schema/buildCollection.ts` |
| Media originals (uploaded files) | `packages/kestrel-media/src/server/utils/persist-upload.ts`, `packages/kestrel-core/src/server/utils/storage.ts` / `storage.local.ts` / `storage.s3.ts` |
| Collection definitions (`defineCollection` calls) | `packages/kestrel-core/src/server/utils/defineCollection.ts`, compiled by `packages/kestrel-core/src/server/schema/buildCollection.ts`, held in `packages/kestrel-core/src/server/utils/registry.ts` |
| Identity (users, sessions, credentials) | `packages/kestrel-auth/src/server/utils/session.ts`, `admin-credential.ts`, `password.ts` |
| Grants (who may do what) | `packages/kestrel-access/src/server/utils/grant-registry.ts` |
| Publishing pointer (`status` column; `publish_status` latest-outcome row per route) | record `status` field (`setStatusMany` in `crud.ts`); `packages/kestrel-publishing/src/server/utils/publish/publish-status.ts` |

### Rules

| Item | Owning module |
|---|---|
| Access policies | `packages/kestrel-access/src/server/utils/policy.ts`, `guard.ts` |
| Pipeline gates (access / csrf / ipAllowlist) | `packages/kestrel-access/src/server/utils/pipeline-gates.ts`, `pipeline-claim.ts` |
| Sealed steps + critical after-steps | `packages/kestrel-core/src/server/pipeline/registry.ts`, `pipeline/steps/persist.ts` |
| Workflow (draft/published transition validity) | `packages/kestrel-core/src/server/utils/crud.ts` (`setStatusMany`) |
| Field registry (field types → column/validator/transform) | `packages/kestrel-fields/src/server/field-registry/index.ts`; storage/lookup in `packages/kestrel-core/src/server/registries/field-types.ts` |

### Derived

Each row names the kill (what CI destroys) and the rebuild (the exact entry point CI reruns):

| Item | Kill-switch | Rebuild command |
|---|---|---|
| `record_refs` index | Drop/empty the `record_refs` table | `rebuildRecordRefs(db)` — replays every live row through `maintainRecordRefs()`, the same function the `reindexRefs` outbox handler calls on every write |
| Publish output (rendered static HTML + synced assets) | Delete the output target | `publishFull()` — same function the boot publish and the `publish:run` task call; run via the `publish:run` Nitro task (or a restart, which triggers the boot publish) — `POST /api/publish` is a targeted per-record publish, not the full rebuild |
| Sitemap / robots.txt / llms.txt / llms-full.txt / redirects.json | Delete the `META_KEYS` output files | Same `publishFull()` call — `publishMeta()` regenerates all five on every full publish |
| `publish_deps` index (route → read-tag map) | Empty the `publish_deps` table | A full publish re-records deps for every route it renders |
| Media derivatives (resized/format-converted variants + thumbhash) | Delete derivative objects, clear the row's `derivatives` column | `runBackfill()` — the `media:backfill` task's own function; public entry point `POST /api/media/backfill` |

`test/architecture/derived-rebuild.test.ts` seeds real state for each item, destroys it with the kill-switch above, and reruns the listed command — what it asserts per item, and how strong each assertion is, is in [Testing § Derived state, proved by CI](./testing.md).

## Tests that enforce this page

Four suites keep the physical cut from drifting, each covering a different edge of it:

| Test | What it enforces |
|---|---|
| `test/architecture/layer-edges.test.ts` | Dependency direction: no `packages/**` file imports `layers/**`; every cross-layer edge is individually allowlisted. |
| `test/architecture/ownership-graph.test.ts` | Module boundaries: no file outside a module's own file set imports that module's table object. |
| `test/architecture/kestrel-discovery.test.ts` | The `PACKAGE_*` producer lists in `package-registry.ts` match every real package's actual `kestrelDiscovery` export. |
| `test/architecture/derived-rebuild.test.ts` | Every item in the Derived table above actually reconstructs from its listed rebuild command. |

## Publishing the packages

A `v*` tag push publishes all ten `@kestrel/*` packages to npm, in topological order of their own `@kestrel/*` dependency lists, alongside the engine, its two extensions, and the `create-kestrel` scaffolder — 14 packages in total. Package versioning, the release workflow, and the dependency-allowlist policy that gates what a package may depend on are covered in [Releasing](./releasing.md).

## Naming

Every *runtime* package directory is `packages/kestrel-<name>` but every published package name is `@kestrel/<name>` (`packages/kestrel-core` ships as `@kestrel/core`, and so on) — the directory keeps a flat, scope-free name for local tooling, while the npm name carries the org scope. The mapping is mechanical: strip the `kestrel-` directory prefix, add the `@kestrel/` scope. The scaffolder, `packages/create-kestrel`, is outside this mapping — it publishes as the unscoped `create-kestrel` that `npm create` expects.

## See also

- [Architecture overview](./architecture.md) — the layer responsibilities and cross-cutting seams this page's diagram summarizes.
- [Per-layer guide](./layer-guide.md) — what each of the nine layers owns, where to start reading in it, and its traps.
- [Decisions](./decisions.md) — ADR-0012 (per-module DB ownership) and the record behind the component-bridge ruling.
- [Extension points](./extension-points.md) — how a third-party consumer extends Kestrel through the layer-directory scan.
- [Releasing](./releasing.md) — how the ten packages are versioned and published to npm.
