# Working on Kestrel

This tree documents Kestrel from the inside: how the layers, packages, and engines actually work, for
anyone changing the code rather than consuming it. It complements [../guide/README.md](../guide/README.md),
which documents the public API surface for consumers of the CMS.

## Guide vs. internals

`docs/guide/` describes exported API only — `defineCollection`, `definePipeline`, `defineFieldType`,
config keys, env vars, HTTP routes, CLI commands — and states behaviour without citing why a decision
was made. This `docs/internals/` tree may go further: it can cite file paths, ADR numbers, and the
rationale behind a standing decision.

## Where to start

A productive reading path for a newcomer:

1. `packages/kestrel-core/src/server/utils/defineCollection.ts` — the `FieldDef`/`CollectionDef` type
   model. The whole CMS keys off this; the type **is** the spec.
2. `packages/kestrel-core/src/server/schema/buildCollection.ts` — how a def becomes a `BuiltCollection`
   (Drizzle table + Zod schemas).
3. `packages/kestrel-collections/src/server/collections/pages.ts` — the richest real def (multi,
   translatable, pageLike, seo, blocks, status).
4. `packages/kestrel-core/src/server/pipeline/defaults.ts` — the eight standard operations
   (createOne/readMany/…) as composed pipelines; `packages/kestrel-core/src/server/utils/crud.ts` is a
   thin delegate over `runWrite`/`runRead`.
5. `layers/core/server/api/[...path].ts` — the one route file behind every `/api/` endpoint; see
   [pipeline-engine.md](./pipeline-engine.md) for how a URL becomes a running pipeline.
6. The flagship subsystem you're touching → its topic page below + the cited files.

## Pages

- [Architecture overview](./architecture.md) — the boot sequence, the registration mechanisms that govern what runs when, and the seams that bite when a change crosses a layer boundary.
- [Layers and packages](./layers-and-packages.md) — the Nuxt layer diagram, the ten `@kestrel/*` packages, the dependency rule between them, and how a package is discovered at runtime.
- [The pipeline engine](./pipeline-engine.md) — every `/api/` endpoint as a named, declarative step list fronted by structurally enforced gates.
- [Extension points and ports](./extension-points.md) — the catalog of seams a consumer or another module plugs into, and the rule that every extension is data or an adapter against a `@kestrel/contracts` interface.
- [Publishing and delivery internals](./publishing.md) — the immutable snapshot store, the delivery-port seam, and invalidation.
- [The data model and schema engine](./data-model.md) — how a `defineCollection` call becomes real tables and back, and the one SQLite file with per-module ownership.
- [Read-time population](./populate.md) — how a record read at `depth > 0` resolves media, links, and relations per-field-type and recursively.
- [Admin editor internals](./admin-ui.md) — the block-tree state model, error resolution, the live-preview protocol, and locale/list plumbing.
- [Effect in this codebase](./effect-usage.md) — the runtime singleton, where Promises take over, the service pattern, and three runtime gotchas no type signature carries.
- [Per-layer guide](./layer-guide.md) — for each of the nine layers: what it owns, which file to open first, and the traps.
- [Testing and conventions](./testing.md) — TDD, the branch/merge convention, which runner picks up which test file, and what the architecture test suite proves.
- [Releasing and dependencies](./releasing.md) — how the packages ship to npm, the release gates, the generated-docs pipeline, and the `package.json` policy.
- [Architecture Decisions](./decisions.md) — the ADR log, one file, newest first.

## See also

- [../guide/README.md](../guide/README.md)
- [./architecture.md](./architecture.md)
- [./layer-guide.md](./layer-guide.md)
- [./testing.md](./testing.md)
