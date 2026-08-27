# Per-layer guide

For each of the nine layers: what it owns, which file to open first, and the traps.

## `core` — model + data engine

**Owns:** the collection/field type model, the registry, the pipeline engine (context, gates, steps,
registry, introspection) + the one catch-all `/api` route, def→JSON serialization (the admin contract),
the runtime schema-migration engine, config resolution, the lazy DB handle, locale resolution, the
populate pipeline, richtext sanitisation (`server/core/sanitize.ts` — the `RICHTEXT_ALLOWLIST` and
`sanitizeRichtext`), the record-ref index, dead-ref derivation, the slug engine, and the `kestrel` +
auto-discovery Nuxt modules.

**Start:** `packages/kestrel-core/src/server/utils/defineCollection.ts` → `collection-types.ts`
(`BuiltCollection`) → `utils/registry.ts` → `server/pipeline/types.ts` (the context/step/gate contracts) →
`pipeline/defaults.ts` (the eight standard ops) → `pipeline/registry.ts` (compose/patch/after-step
semantics) → `layers/core/server/api/[...path].ts` → `packages/kestrel-core/src/server/utils/crud.ts` (a
thin delegate over `runWrite`/`runRead`) → `utils/serialize-collection.ts`. Schema engine:
`server/schema/{model,desired,introspect,diff,dialect,render-sqlite,sync}.ts`. Config:
`server/utils/kestrel-config.ts` + `layers/core/modules/kestrel/index.ts` (this module also
registers Kestrel's authoring API — `defineCollection`, `definePipeline`, `defineFieldType`, etc. — as
Nuxt/Nitro auto-imports, see `layers/core/modules/kestrel/auto-imports.ts`).

**Gotchas:** singletons (`mode:'single'`) reject `create`/`update`/`remove` with 405 — use `updateOne`;
populate runs only at `depth>0`; the `02.schema-sync` plugin only auto-DDLs in dev — production instead
runs a read-only drift check at boot and `console.warn`s any missing additive change (the app may error
until `db:migrate` runs); destructive schema ops are gated (rebuild needs `force`, drop needs explicit
`dropTables`); the seam runs the other way from what the package layout suggests —
`fields`/`media`/`collections`/`publishing` all depend on `@michaelthielemann/kestrel-core`, and `core` exports a mutable
`fieldTypes` registry (`server/registries/field-types.ts`) that `kestrel-fields` seeds at module load — the only
place `core` still reaches toward the other packages is the *layer's* codegen: a generated import string
in `layers/core/modules/auto-discovery/index.ts` and the package name lists in
`layers/core/modules/auto-discovery/package-registry.ts`; **no plugin may resolve a pipeline (or read the
collection registry) at init** — the default pipelines install lazily on first request, so a plugin
calling `resolvePipeline`/`allCollections()` at plugin-init time may happen to work under the current
declared plugin order (`layers/core/modules/plugin-order`) but is latent breakage waiting for that order
to change, or for a consumer's own ungoverned plugin to land differently.

**Docs:** [Pipeline engine](./pipeline-engine.md), [Configuration](../guide/configuration.md),
[Data model](./data-model.md) (record-ref index, dead-ref derivation, the slug engine),
[Decisions](./decisions.md) (ADR-0002 schema engine, ADR-0010 pipeline engine).

## `fields` — def → tables + schemas

**Owns:** the built-in field-type descriptors (per-field column-type + validator decisions,
`field-registry/index.ts`) it seeds into core's registry, the `defineFieldType` authoring API, and the
field/block populate walkers. The table/schema compiler, the jsKey↔dbName naming, and the block schema
builder all live in `core` — `fields` only supplies the descriptors they read. Richtext sanitisation itself
(`RICHTEXT_ALLOWLIST`, `sanitizeRichtext`) also lives in `core` — see the `core` entry above; `fields` only
applies it, via the richtext field's Zod `.transform`.

**Start:** `packages/kestrel-fields/src/server/field-registry/index.ts` (the `fieldTypes` `{column,
validator}` registry — the single source of truth for column types; `registerFieldType`/`getFieldType`
open it to consumer types; its richtext `validator` imports `sanitizeRichtext` from `@michaelthielemann/kestrel-core`) →
`packages/kestrel-core/src/server/utils/naming.ts` (`resolveColumnName`) →
`kestrel-core/src/server/utils/buildTable.ts` → `kestrel-core/src/server/schema/buildCollection.ts` (
`buildFieldSchema`) → `kestrel-core/src/server/blocks/registry.ts` (`buildBlocksSchema`, `registerBlock`).
`kestrel-fields/src/server/utils/defineBlock.ts` is only the authoring-side `defineBlock` identity helper —
it re-exports the block registry functions from `@michaelthielemann/kestrel-core` rather than implementing them. See
`kestrel-fields/test/server/utils/integration.test.ts` for end-to-end wiring.

**Gotchas:** the built-in registry lives in `field-registry/` (explicit-import only) — deliberately **not**
under the consumer extension dir `server/field-types/` (auto-discovered `defineFieldType` default-export
files), so the engine's no-default-export infra is never scanned + Rollup-default-imported; the `validator`
in `field-registry` is the *sole* server authority (the `app/utils` validators are advisory UX only);
single relation/media get the `Id` suffix, multiple don't; when no block is registered the block *node*
schema is `z.never()`, so any non-empty `content` fails validation (an empty array still passes) until
`registerBlock` has run; richtext is sanitised via a Zod `.transform`
(silently rewritten, not rejected) against `core`'s `RICHTEXT_ALLOWLIST`, held in step with the editor's
schema — a tag the sanitizer accepts but no extension parses is a delayed deletion, not a feature, so
widening `RICHTEXT_ALLOWLIST` (in `packages/kestrel-core/src/server/core/sanitize.ts`) means teaching the
editor the tag in the same change.

**Docs:** [Custom field types](../guide/custom-field-types.md), [Decisions](./decisions.md) (ADR-0002).

## `ui` — admin design system

**Owns:** schema-driven field widgets (`components/field/*` → `Field*`), generic primitives
(`components/ui/*` → `Ui*`), composables (`useT`, `useToast`, `useRepeater`…), design tokens
(`_tokens.scss`), the inline-SVG icon registry, and admin i18n.

**Start:** `layers/ui/app/utils/field-registry.ts` (the `FieldType→Component` seam +
`registerFieldComponent`) — see [Admin UI](./admin-ui.md) § Design system and § Testing surface for the
rest of the chain, the token/theming split, and the teleported-widget testing rule (`UiDialog` and
richtext are excluded because `UiDialog` renders in place rather than teleporting, and TipTap's document is
driveable through the exposed `editor` object instead).

**Docs:** [Admin UI](./admin-ui.md) for the editor internals.

## `auth` (authN) + `access` (authZ) — identity and the pipeline gates

**`auth`** owns *authentication* — a stateless HMAC-signed session cookie, scrypt password hashing,
same-site CSRF, per-IP brute-force lockout, and the `login`/`logout`/`session` pipelines
(`server/pipelines/auth.ts` + `server/pipelines/session.ts`, registered by
`01.register-auth-pipelines.ts` — login/logout/session are ordinary pipelines, not a bespoke route).
**`access`** owns *authorization* — the real gate evaluators the pipeline engine calls
(`access`/`csrf`/`ipAllowlist`), the role→grant policy those evaluators consult, the pluggable grant
registry, and a slim default-deny middleware for whatever no pipeline claims. Both are **server-only — no
`app/`** (the login UI lives in `admin`).

**Start (auth):** `packages/kestrel-auth/src/server/utils/session.ts` → `server/pipelines/auth.ts` →
`server/pipelines/session.ts` (`GET /api/session`).
**Start (access):** `packages/kestrel-access/src/server/utils/pipeline-gates.ts`
(`evaluateAccessGate`/`evaluateCsrfGate`/`evaluateIpAllowlistGate` — what a pipeline's
`access`/`csrf`/`ipAllowlist` declaration turns into) → `utils/pipeline-run.ts`
(`runPipelineForEvent(Async|Auto)` — builds the ctx from the event and injects the real evaluators) →
`utils/policy.ts` (the RBAC shell: roles/grants, `resolveAccess`, `isPubliclyReadable` — builds the policy
table and delegates to `core/decide.ts`, the pure allow/deny predicate) → `utils/csrf.ts` →
`utils/grant-registry.ts` → `layers/access/server/middleware/00.ip-allowlist.ts` (edge enforcement of
`KESTREL_IP_ALLOWLIST`/`_MODE` for non-pipeline traffic) →
`layers/access/server/middleware/access-guard.ts` (resolve the principal, default-deny anything
`claimedByPipelineRoute` says no pipeline owns, refresh the session) →
`layers/access/server/types.d.ts` (the `event.context` contract).

**Gotchas:** authorization for a pipeline-claimed path lives on the pipeline's own gate declaration, not on
the guard — the guard is only the backstop for unclaimed `/api/` paths (an unknown path, a stray consumer
route mounted under `/api` without its own pipeline) and still default-denies a non-admin there; `session`'s
read is public (`access: { public: true, scope: 'published' }`), not admin-gated, so an unauthenticated
client can poll it to know whether to redirect to login; the pipeline gate's in-process-sub-request
exemption is keyed to the async context that `00.ip-allowlist.ts` sets on the external request the
middleware already admitted — `evaluateIpAllowlistGate` recognises that context rather than re-checking the
IP; **every
page-like collection** is anonymously readable (published-scope), data-driven from the read pipelines'
`access` declarations (`publicReadableResources()`), not a literal `pages` allow-list; the `renderer`
principal (during `nuxt generate`) gets read-all incl. drafts, and is never denied an admin-only READ
pipeline either (`evaluateAccessGate` never consults `AccessSpec.role`); the admin-password hash is folded
into the signing key, so changing it logs everyone out; lockout state is in-memory per-process; gate order
is **ipAllowlist → csrf → access** (a 403 for a bad IP or a cross-origin write never turns into a 401).

**Docs:** [Configuration](../guide/configuration.md) (auth/session env), [Extending](../guide/extending.md),
[Decisions](./decisions.md) (ADR-0001 scrypt choice, ADR-0010 pipeline engine).

## `collections` — the `pages` built-in + registration

**Owns:** the toggleable built-in `pages` collection def, and the plugin that registers every discovered
collection + block (gating the `pages`/`media` built-ins on the `kestrel.collections` toggle). **Declares
the one built-in; contains no machinery.**

**Start:** `packages/kestrel-collections/src/server/collections/pages.ts` (the built-in, `builtin: true`)
→ `layers/collections/server/plugins/01.register.ts`.
**Demo content lives in the repo root** (dev/test only — **not** shipped; root `package.json`'s `files`
ships `layers/` plus `scripts`/`templates`, but no root `server/`/`app/`): `server/collections/{posts,
settings}.ts`, the block SFCs `app/blocks/{Hero,Prose}.vue` (schema + display in one file), and the
drizzle-kit barrel `server/database/schema.ts`.

**Gotchas:** the def files use **explicit relative imports** (not auto-imports) so drizzle-kit (plain node)
can read them; block components are made global by the auto-discovery module's `addComponentsDir({ prefix:
'Blocks', global: true, pathPrefix: false })` call, which is what lets `BlockRenderer` resolve them by the
name `Blocks<PascalType>` — see [Architecture](./architecture.md) § Cross-cutting seams for the full
mechanics; a consumer's own collections live via
auto-discovery + the self-migrating schema engine, not in the root barrel; disabling a built-in
(`kestrel: { collections: { pages: false } }`) skips its registration.

**Docs:** [Extending](../guide/extending.md) (collections), [Blocks](../guide/blocks.md) (the block recipe).

## `media` — uploads, storage, library, viewer

**Owns:** ingest (magic-byte sniff, SVG sanitize, allow-list, server-controlled keys), storage-driver
selection and config (`useStorageDriver`) over core's `StorageDriver` contract and its local/S3
implementations, responsive-image derivation (WebP ladder + thumbhash +
EXIF-aware dims), the `folders` DB registry, the media-library management UI, the picker, and the asset
viewer.

**Start:** `packages/kestrel-media/src/server/collections/media.ts` (the data model) →
`server/pipelines/media-upload.ts` (the whole ingest pipeline in one step) → `server/utils/storage.ts`
(`useStorageDriver`, wrapping the `StorageDriver` contract exported from `@michaelthielemann/kestrel-core`) →
`server/utils/resolve.ts` (`resolveMedia`/`ResolvedMedia`) → `server/utils/populate.ts` +
`layers/media/server/plugins/02.register-media.ts` (the `$media` seam) → `server/utils/library.ts`
(`listLibrary`: paginate/sort/exists/recursive sizes) →
`layers/media/app/composables/useMediaLibrary.ts` + `app/components/MediaLibrary.vue`.

**Gotchas:** root files are stored with `folder = NULL` (queries match both `NULL` and `''`); **folders
are a DB table, not the object store**; `storageKey` is server-controlled + UNIQUE and the extension
follows the *sniffed* mime, never the client filename; `media` is `translatable:false` but carries its own
per-locale `translations` JSON (alt/title/description) — `listLibrary`/`resolveMedia` resolve in
`primaryLocale()` (not a literal `'en'`) so alt edits round-trip; single media id is stored as `<name>Id`
on a record but the plain field name inside a block.

**Docs:** [Media](../guide/media.md) (ingest/storage/derivation, the library surface),
[Configuration](../guide/configuration.md) (media config).

## `admin` — the editor SPA

**Owns:** the client-only back office: collection list (sort/filter/paginate), the record editor (flat
form vs the 3-pane block editor: tree · live preview · contextual fields), the multilingual UI, auth
chrome, theming. Mounted under `/admin`, **SSR off**.

**Start:** `layers/admin/app/components/CollectionEditor.vue` → `app/composables/useEditForm.ts` →
`app/composables/useBlockTree.ts` + `app/utils/block-tree.ts` → `app/utils/edit-form.ts` →
`app/pages/admin/[collection]/[id].vue` + `index.vue`.

**Gotchas:** admin routes are `ssr:false` (excluded from `nuxt generate`); `content` is a synthesized
blocks column, not a field def; the block tree is pure + id-addressed with an echo-guard on the model
watcher; **block type is fixed at creation** (the only type choice is the Add-block picker, kept
non-teleported for tests); `jsKey` (`layers/admin/app/utils/field-keys.ts`) maps widget names ↔ wire keys,
reading the server-computed `single` flag; many empty-catch blocks are intentional fail-soft.

**Docs:** [Blocks](../guide/blocks.md) (the 3-pane editor), [Multilingual](../guide/multilingual.md),
[Data model](./data-model.md) (dead-ref editor surfaces + the slug field/preview).

## `public` — the SSG render path

**Owns:** the *only* render path for the generated site — a catch-all page that renders **any** page-like
collection's blocks (not just `pages`), per-page layout selection, the built-in `site` and `redirects`
singletons, the SSG artifacts (sitemap/robots/llms/redirects.json, one `META_KEYS` list) and the
agent-facing head (JSON-LD), build-time prerender route discovery, internal-link resolution, and the
optional S3 deploy of the output — plus, on the publish/delivery half, the runtime publisher, the
`publish`/`publishRuns` pipelines and tasks, and the live-delivery adapter under `server/delivery-live/`
(backed by `@michaelthielemann/kestrel-publishing`/`@michaelthielemann/kestrel-delivery-live`/`@michaelthielemann/kestrel-delivery-static`; see
[Publishing](./publishing.md) for the mechanics).

**Start:** `layers/public/app/pages/[...slug].vue` (the catch-all) resolves a path to the first published
record across every pageLike collection via `packages/kestrel-publishing/src/server/pipelines/route.ts`
(`GET /api/route`) → `packages/kestrel-publishing/src/server/utils/content/page-resolve.ts`, then renders
it with `layers/public/app/components/BlockRenderer.vue` (recursive block→component render + the
admin-preview seam) inside the layout `app/utils/page-layout.ts` picks from the record's `layout` column;
the editor live-preview runs as an **iframe** onto that same path (`?kestrel-preview=1` + admin →
`app/components/KestrelPreviewBridge.vue` swaps in the editor's tree over origin-checked postMessage;
`app/pages/__kestrel/preview.vue` is the admin-gated fallback for unsaved records; protocol in
`app/utils/preview-protocol.ts`). An external tab has no parent window, so it carries the unsaved state as
a ticket instead: `packages/kestrel-publishing/src/server/pipelines/preview.ts`'s `createPreview` step
(`POST /api/createPreview`) mints it into
`packages/kestrel-publishing/src/server/utils/content/preview-token.ts` and the `preview` step (`GET
/api/preview`) reads it back populated (`?kestrel-preview-token=`) →
`layers/public/modules/prerender-routes/discover.ts` (build-time route discovery — finds every pageLike
table by its partial `path` index) → `layers/public/server/routes/sitemap.xml.get.ts` +
`packages/kestrel-publishing/src/server/utils/content/sitemap.ts` → `app/utils/page-head.ts` +
`app/utils/json-ld.ts` (the two pure head models the catch-all feeds) →
`layers/public/server/routes/llms{,-full}.txt.get.ts` +
`packages/kestrel-publishing/src/server/utils/content/llms{,-full}.ts` +
`packages/kestrel-publishing/src/server/utils/content/richtext-markdown.ts` (the richtext→Markdown
converter `llms-full.txt` needs) → `packages/kestrel-publishing/src/server/utils/content/populate-links.ts`
+ `layers/public/server/plugins/02.register-links.ts` → `layers/public/modules/deploy-output/*`. All of
the `server/utils/content/*` files above live under `packages/kestrel-publishing/src/` —
`layers/public/server/utils/` holds only `publish/`, no `content/` directory of its own. Redirects are
compiled from their own collection and enforced by a CRITICAL after-step; the mechanics — the
wildcard→regex compiler, `registerAfterStep`, the `redirects.json` route — are covered in
[Publishing](./publishing.md).

**Gotchas:** the internal-link populator mutates **every** collection read (registered globally), not just
public pages; links ARE status-gated — a MISSING **or** draft target renders `#` (only a collection without
a `status` column resolves unconditionally; the editor is warned separately), and every internal target is
captured as a read dep so an availability change re-renders the referrer — while the sitemap + prerender
discovery stay published-only; build-before-migrate hazard — prerender discovery, sitemap and link-resolve
read the DB at points where the table may not exist yet, so they degrade gracefully (and log the skip,
which is otherwise an invisible de-index), but `page-resolve` is the exception: an incomplete scan cannot
tell "no page here" from "unreadable", so `/api/route` 503s and the route bakes NO file rather than an
empty document over a live page; richtext internal links (`kestrel:<col>:<id>` markers) are a separate
mechanism from the `link` field; the catch-all declares `layout: false` and mounts `<NuxtLayout>` itself,
so the layout is a CHILD of the page and an unset/blank `layout` must be coalesced to `default`
(`resolvePageLayout`) — `NuxtLayout`'s own `fallback="default"` prop covers the other case, a
truthy-but-unregistered layout name, but cannot help with the literal `false` that `layout: false` leaves
in the route meta; the artifacts published at literal keys are ONE list (`META_KEYS` in `@michaelthielemann/kestrel-core`) because four
call sites must agree on it — the publisher renders them, the asset mirror must skip the build's stale
copies, the prerender module seeds them as routes, and the cache policy keys off the same names (only the
prerender seeding is flag-aware: `llms-full.txt` 404s unless `kestrel.seo.llmsFull` is on, and a prerender
error fails `nuxt generate`); a page's breadcrumb subscribes to each ancestor with TWO tags and needs
both — a `pagePathTag` (the only dependency keyed on a path rather than a record: Kestrel has no
parent/child relation, a descendant is a path-prefix match, and a page CREATED at an ancestor path has no
id to have been captured) plus the record tag of whatever sits there, captured before the visibility
filters, because the publish action classifies its write as `before === after` and so cannot name where a
renamed or newly-hidden ancestor USED to be.

**Docs:** [Publishing](./publishing.md) (delivery split, redirects), [Data model](./data-model.md)
(link resolution, status-gated reads), [Blocks](../guide/blocks.md) (BlockRenderer + preview seam),
[Decisions](./decisions.md) (ADR-0006 per-page layouts, ADR-0009 redirects).

## See also

- [Pipeline engine](./pipeline-engine.md) — the context/gate/step contracts every layer's pipelines build on.
- [Data model](./data-model.md) — reference integrity, populate, and the record-ref index the `core`/`public` gotchas above assume.
- [Admin UI](./admin-ui.md) — the `ui` layer's editing-surface internals in full.
- [Publishing](./publishing.md) — the delivery split and redirects mechanics the `public` layer's Start section only summarizes.
- [Layers and packages](./layers-and-packages.md) — the layer↔package cut, the ten `@michaelthielemann/kestrel-*` packages, and the dependency rule the ownership statements throughout this page assume.
- [Architecture](./architecture.md) — boot/plugin order and the cross-cutting seams several Gotchas here assume.
