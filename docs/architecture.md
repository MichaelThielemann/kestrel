# Architecture

Orientation map for the codebase: what each Nuxt layer owns, where to start reading, the seams that
cross layers, and the non-obvious gotchas. Pairs with the per-topic docs (linked per layer below) and
the unusually thorough inline source comments — this file is the index into both.

Kestrel is a slim **static-site-generator CMS**: a generic, collection-driven CRUD core + a
schema-driven admin editor; published content is rendered to static HTML by `nuxt generate` (there is
**no live public SSR**). Built on **Nuxt 4 layers + Drizzle/SQLite + Zod**.

## Layer model

Every layer lives in `layers/<name>` with a Nitro side (`server/`) and/or a Vue side (`app/`).
**Auto-imports work across layers** — server utils/routes and app composables/components are used
without an `import` from other layers; explicit relative imports are reserved for node tests and a few
deliberate exceptions (noted below).

```
core ───────────────► the model + data engine + config + schema engine + populate registry
  ▲  fields ────────► builds Drizzle tables + Zod schemas from a def (BuiltCollection)
  │  ui ────────────► the admin design system (Field*/Ui* components, tokens, i18n)
  │
  ├─ auth ──────────► authN: stateless session cookie, scrypt password, login, CSRF
  ├─ access ────────► authZ: default-deny /api guard, policy/grants (sets event.context.principal/readScope)
  ├─ collections ───► the toggleable `pages` built-in + the register plugin (demo content lives in repo root)
  ├─ media ─────────► uploads, storage drivers, derivation, the media library + viewer
  ├─ admin ─────────► the editor SPA (collection list, record editor, 3-pane block editor)
  └─ public ────────► the SSG render path (catch-all page, BlockRenderer, sitemap/robots, deploy)
```

`core` is the foundation, but **not strictly the lowest layer**: it reaches *up* by relative path into
`fields` (`resolveColumnName`) and `media` (the `folders` table) in its schema engine. `fields` builds
the tables `core` only defines the contract for. The domain layers (auth/collections/media/admin/public)
compose those.

### Server plugins (and why their cross-layer order does *not* matter)

> **The numeric prefixes sort plugins WITHIN a layer only.** Nitro orders server plugins by **layer
> first, then filename**, so the absolute cross-layer order is build-context-dependent: in-repo it's the
> reverse-alphabetical auto-scan (`public, media, core, collections`), while a consumer's
> `extends: ['@michaelthielemann/kestrel']` is core-first (`core, media, collections, public`). In particular
> `collections/01.register` actually runs **last** in-repo, *after* `00.migrate`/`02.schema-sync`/
> `03.record-refs`. The list below describes **what each plugin does**, NOT a guaranteed sequence.
>
> **Invariant that makes the order irrelevant: no plugin reads the registry at init.** `00.migrate`/
> `02.schema-sync` read the `#kestrel/collections` virtual directly (never `allCollections()`); the
> ref/cleanup/publish plugins only register *deferred* listeners; and the boot publish's registry read
> sits after an `await` in `publishFull`, so it resumes only after the synchronous plugin loop (incl.
> `01.register`) has finished. A future plugin that calls `allCollections()`/`getCollection()` at init
> would work in-repo but break (empty registry) for a real consumer — there is no compile-time signal.

1. `core/server/plugins/00.migrate.ts` — runs committed drizzle-kit migrations **only if**
   `server/database/migrations/` exists (i.e. Kestrel's own repo; absent when consumed as a package).
2. `collections/server/plugins/01.register.ts` — registers every discovered collection + block into the
   runtime registry (reads the `#kestrel/collections` / `#kestrel/blocks` virtuals).
3. `core/server/plugins/02.schema-sync.ts` — **dev-only** additive auto-migration; early-returns under
   `NODE_ENV=production` / `import.meta.prerender`. Prod applies schema via the `db:migrate` task.
4. `media/server/plugins/02.register-media.ts` and `public/server/plugins/02.register-links.ts` — push
   the `$media` and internal-link **populators** into core's registry (order-independent, see below).
5. `core/server/plugins/03.record-refs.ts` and `media/server/plugins/03.media-cleanup.ts` — register
   **deferred** write-event listeners (the `record_refs` index + dead-ref derivation, and the on-delete
   media cleanup that prunes an asset's derivatives). They fire on a write, never at plugin init.
6. `public/server/plugins/zz.publish.ts` (`zz` = last *within the public layer*) — registers a deferred
   listener wiring the runtime incremental publisher to content-write events; it reads the registry +
   every populator/ref hook at republish time (after a write), not at init, so the page renders fully
   populated regardless of plugin init order. Dev/prerender-aware (see [static-output.md](./static-output.md)).

## Where to start

A productive reading path for a newcomer:

1. `layers/core/server/utils/defineCollection.ts` — the `FieldDef`/`CollectionDef` type model. The
   whole CMS keys off this; the type **is** the spec.
2. `layers/fields/server/utils/buildCollection.ts` — how a def becomes a `BuiltCollection` (Drizzle
   table + Zod schemas).
3. `layers/collections/server/collections/pages.ts` — the richest real def (multi, translatable,
   pageLike, seo, blocks, status), with `01.register.ts` showing how it reaches the registry.
4. `layers/core/server/utils/crud.ts` — the generic CRUD engine behind `/api/[collection]`.
5. The flagship subsystem you're touching → its **topic doc** (linked per layer) + the cited files.

## Cross-cutting seams

The things that live *between* layers and bite if you don't know them:

- **Registry.** `core` owns a module-level `Map` (`registry.ts`), but it's **filled by `collections`**
  (`01.register`) from the auto-discovery virtuals — which scan *every* layer's `server/collections`, and
  **extract** every layer's `app/blocks/*.vue` SFCs into the block registry. Drop a def/block file in any
  layer and it's discovered.
- **`BuiltCollection`.** The contract (`def + Drizzle table + drizzle-zod insert/update/select`) is
  declared in `core`, but **constructed in `fields`** (`buildCollection`). Searching `core` for
  table-building turns up nothing.
- **Populate pipeline.** `registerPopulator` composes order-independent populators that run **only at
  `depth > 0`**. `media` attaches a `$media` sidecar; `public` resolves internal-link `href`s. List/get
  default to `depth 0` (raw FK ids). `$`-prefixed keys (`$media`, `$translations`) never collide with
  user fields.
- **Auth context.** The `access-guard` middleware sets `event.context.principal` + `readScope`
  (`published` | `all`); `core`'s collection GET handlers read `readScope` to scope reads. Anonymous
  visitors get published read on **every** page-like collection — the registry-driven
  `publicReadableResources()` set, which the guard and the sitemap (`isPubliclyReadable`) both consult as
  the single source of public reachability. (Contract: `layers/access/server/types.d.ts`.)
- **jsKey ↔ dbName.** `core`'s `isSingleRefColumn` predicate decides whether a `relation`/`media` field
  is stored as a single FK column; `fields`' `resolveColumnName` uses it to map that field's key to
  `<key>Id` / `<key>_id` (everything else uses the snake_cased key). The serializer emits the result as a
  `single` flag on `SerializedField`, so `admin`'s `columnKey` + `useEditForm` **read the flag** instead
  of re-deriving the rule — one source of truth, so client and server can't silently drift on which
  columns get the `Id` suffix.
- **`asFieldDef` bridge.** `admin/app/utils/edit-form.ts` casts a wire `SerializedField` back to a
  `FieldDef` (a single cast, not per-arm reconstruction) so widgets can consume the serialized schema.
- **Block components.** `BlockRenderer` resolves `Blocks<PascalType>` by **name string** via
  `resolveDynamicComponent`; the actual components are the block SFCs in `app/blocks/`, registered as
  global `Blocks<Name>` components by the auto-discovery module's `addComponentsDir({ prefix: 'Blocks',
  global: true, pathPrefix: false })` — the same SFC the build extracts the schema from.
- **Schema engine** (ADR-0002). Collection-derived, dialect-agnostic: model → desired/introspect → diff
  → render → sync. Dev auto-applies *additive* ops; destructive ops are gated; prod uses the
  `db:migrate` task. Only SQLite is wired (a `postgres` slot fails loud).

---

## Per-layer guide

### `core` — model + data engine
**Owns:** the collection/field type model, the registry, the generic CRUD engine + REST API, def→JSON
serialization (the admin contract), the runtime schema-migration engine, config resolution, the lazy DB
handle, locale resolution, the populate pipeline, and the `kestrel` + auto-discovery Nuxt modules.
**Start:** `server/utils/defineCollection.ts` → `collection-types.ts` (`BuiltCollection`) →
`registry.ts` → `crud.ts` → `server/api/[collection]/*` → `serialize-collection.ts`. Schema engine:
`server/schema/{model,desired,introspect,diff,dialect,render-sqlite,sync}.ts`. Config:
`server/utils/kestrel-config.ts` + `modules/kestrel/index.ts`.
**Gotchas:** singletons (`mode:'single'`) reject `create/update/remove` with 405 → use PUT; populate
runs only at `depth>0`; `02.schema-sync` is dev-only; destructive schema ops are gated (rebuild needs
`force`, drop needs explicit `dropTables`); `core` imports *up* into `fields`/`media`.
**Docs:** `architecture-decisions.md` (ADR-0002 schema engine, ADR-0003 reference integrity), `configuration.md`, `consuming-kestrel.md`, `reference-integrity.md` (the `record_refs` index, dead-ref derivation + the slug engine live here).

### `fields` — def → tables + schemas
**Owns:** turning a def into Drizzle tables, Zod insert/update/select schemas, per-field column-type +
validator decisions, the jsKey↔dbName naming, the block schema builder, and richtext sanitisation.
**Start:** `server/field-registry/index.ts` (the `fieldTypes` `{column, validator}` registry — the single
source of truth for column types; `registerFieldType`/`getFieldType` open it to consumer types) →
`field-registry/naming.ts` (`resolveColumnName`) → `utils/buildTable.ts` → `utils/buildCollection.ts` →
`utils/defineBlock.ts` (+ `buildBlocksSchema`). See `utils/integration.test.ts` for end-to-end wiring.
**Gotchas:** the built-in registry lives in `server/field-registry/` (explicit-import only) — deliberately
**not** under the consumer extension dir `server/field-types/` (auto-discovered `defineFieldType`
default-export files), so the engine's no-default-export infra is never scanned + Rollup-default-imported;
the `validator` in `field-registry` is the *sole* server authority (the `app/utils` validators are advisory
UX only); single relation/media get the `Id` suffix, multiple don't; `buildBlocksSchema([])` is
`z.never()` so block content fails validation until `registerBlock` has run; richtext is sanitised via a
Zod `.transform` (silently rewritten, not rejected).
**Docs:** `consuming-kestrel.md` (the field DSL, consumer angle), ADR-0002.

### `ui` — admin design system
**Owns:** schema-driven field widgets (`components/field/*` → `Field*`), generic primitives
(`components/ui/*` → `Ui*`), composables (`useT`, `useToast`, `useRepeater`…), design tokens
(`_tokens.scss`), the inline-SVG icon registry, and admin i18n.
**Start:** `app/utils/field-registry.ts` (the `FieldType→Component` seam + `registerFieldComponent`) →
`components/field/Renderer.vue` (`FieldRenderer` dispatcher) → `app/utils/field-component.ts`
(`FieldComponentProps`, the prop contract every `Field*` honours) → `components/field/Text.vue` (a
canonical widget) → `assets/scss/_tokens.scss`. Design language: a refined-indigo, border-led admin
aesthetic — calm active states, lucide icons via `UiIcon` (no emoji/ASCII glyphs), no dashed/bubble
placeholder clichés; the public SSG `:root` tokens stay untouched.
**Gotchas:** `_tokens.scss` `:root` colors **drive the public SSG site** ("do not retune"); admin styling
goes under `:root[data-theme]`. happy-dom doesn't render **teleported** widgets (combobox/datepicker/
richtext/dialog) → those are smoke-tested only, with load-bearing logic in pure utils. **Portaled
overlays must use global (unscoped) styles** — a scoped `<style>` loses its `data-v` attr once Reka
teleports the content to `<body>` (the `Menu` background bug). Adding a field type = a `Field*.vue` +
a registration. Adding an icon = extend the `IconName` union **and** the `icons` map.
**Docs:** none dedicated — code comments + this entry.

### `auth` (authN) + `access` (authZ) — identity and the /api guard
Split 2026-06-28: **`auth`** owns *authentication* — a stateless HMAC-signed session cookie, scrypt
password hashing, same-site CSRF, per-IP brute-force lockout, and the login endpoint. **`access`** owns
*authorization* — the default-deny middleware that gates the **entire** `/api/` surface, the role→grant
policy, and the pluggable grant registry. Both are **server-only — no `app/`** (the login UI lives in
`admin`).
**Start (auth):** `layers/auth/server/utils/session.ts` → `server/api/auth/login.post.ts`.
**Start (access):** `layers/access/server/middleware/access-guard.ts` (the front door, runs on every
request) → `utils/guard.ts` (pure decision engine) → `utils/policy.ts` (the RBAC: roles/grants,
`resourceForPath`, `isPubliclyReadable`) → `utils/csrf.ts` → `utils/grant-registry.ts` →
`layers/access/server/types.d.ts` (the `event.context` contract).
**Gotchas:** the guard enforces **only** on `/api/` — public HTML / sitemap / `/uploads` are not behind
it; **every page-like collection** is anonymously readable (published-scope), data-driven from the
registry (`publicReadableResources()`), not a literal `pages` allow-list; the `renderer` principal (during
`nuxt generate`) gets read-all incl. drafts; the admin-password hash is folded into the signing key, so
changing it logs everyone out; lockout state is in-memory per-process.
**Docs:** `configuration.md` (auth/session env), `consuming-kestrel.md`, ADR-0001 (scrypt choice).

### `collections` — the `pages` built-in + registration
**Owns:** the toggleable built-in `pages` collection def, and the plugin that registers every discovered
collection + block (gating the `pages`/`media` built-ins on the `kestrel.collections` toggle). **Declares
the one built-in; contains no machinery.**
**Start:** `server/collections/pages.ts` (the built-in, `builtin: true`) → `server/plugins/01.register.ts`.
**Demo content lives in the repo root** (dev/test only — **not** shipped; `files` whitelists only `layers/`):
`server/collections/{posts,settings}.ts`, the block SFCs `app/blocks/{Hero,Prose}.vue` (schema + display
in one file), and the drizzle-kit barrel `server/database/schema.ts`.
**Gotchas:** the def files use **explicit relative imports** (not auto-imports) so drizzle-kit (plain node)
can read them; block components are made global by the auto-discovery module's `addComponentsDir({
global: true })` call (`BlockRenderer` then resolves them by name); a consumer's own collections live via
auto-discovery + the self-migrating schema engine, not in the root barrel; disabling a built-in
(`kestrel: { collections: { pages: false } }`) skips its registration.
**Docs:** `consuming-kestrel.md` (collections), `block-editing.md` (the block recipe).

### `media` — uploads, storage, library, viewer
**Owns:** ingest (magic-byte sniff, SVG sanitize, allow-list, server-controlled keys), pluggable storage
(local/S3 behind one `StorageDriver` contract), responsive-image derivation (WebP ladder +
thumbhash + EXIF-aware dims), the `folders` DB registry, the media-library management UI, the picker,
and the asset viewer.
**Start:** `server/collections/media.ts` (the data model) → `server/api/media/index.post.ts` (the whole
ingest pipeline in one file) → `server/utils/storage.ts` (the driver contract) → `server/utils/resolve.ts`
(`resolveMedia`/`ResolvedMedia`) → `server/utils/populate.ts` + `plugins/02.register-media.ts` (the
`$media` seam) → `server/utils/library.ts` (`listLibrary`: paginate/sort/exists/recursive sizes) →
`app/composables/useMediaLibrary.ts` + `app/components/MediaLibrary.vue`.
**Gotchas:** root files are stored with `folder = NULL` (queries match both `NULL` and `''`); **folders
are a DB table, not the object store**; `storageKey` is server-controlled + UNIQUE and the extension
follows the *sniffed* mime, never the client filename; `media` is `translatable:false` but carries its
own per-locale `translations` JSON (alt/title/description) — `listLibrary`/`resolveMedia` resolve in
`primaryLocale()` (not a literal `'en'`) so alt edits round-trip; single media id is stored as
`<name>Id` on a record but the plain field name inside a block.
**Docs:** `media-uploads.md` (ingest/storage/derivation), `configuration.md` (media config). *Gap: the
library half — folders registry, the `/api/media/*` surface, relocate/usages — is undocumented beyond
this entry + code comments.*

### `admin` — the editor SPA
**Owns:** the client-only back office: collection list (sort/filter/paginate), the record editor (flat
form vs the 3-pane block editor: tree · live preview · contextual fields), the multilingual UI, auth
chrome, theming. Mounted under `/admin`, **SSR off**.
**Start:** `app/components/CollectionEditor.vue` → `app/composables/useEditForm.ts` →
`app/composables/useBlockTree.ts` + `app/utils/block-tree.ts` → `app/utils/edit-form.ts` →
`app/pages/admin/[collection]/[id].vue` + `index.vue`.
**Gotchas:** admin routes are `ssr:false` (excluded from `nuxt generate`); `content` is a synthesized
blocks column, not a field def; the block tree is pure + id-addressed with an echo-guard on the model
watcher; **block type is fixed at creation** (the only type choice is the Add-block picker, kept
non-teleported for tests); `columnKey`/jsKey maps widget names ↔ wire keys; many empty-catch blocks are
intentional fail-soft.
**Docs:** `block-editing.md` (the 3-pane editor — the best doc for this layer), `multilingual.md`, `reference-integrity.md` (dead-ref editor surfaces + the slug field/preview).

### `public` — the SSG render path
**Owns:** the *only* render path for the generated site — a catch-all page that renders **any** page-like
collection's blocks (not just `pages`), the SSG artifacts (sitemap/robots), build-time prerender route
discovery, internal-link resolution, and the optional S3 deploy of the output.
**Start:** `app/pages/[...slug].vue` (the catch-all) resolves a path to the first published record across
every pageLike collection via `server/api/route.get.ts` → `server/utils/page-resolve.ts`, then renders it
with `app/components/BlockRenderer.vue` (recursive block→component render + the admin-preview seam);
the editor live-preview runs as an **iframe** onto that same path (`?kestrel-preview=1` + admin →
`app/components/KestrelPreviewBridge.vue` swaps in the editor's tree over origin-checked postMessage;
`app/pages/__kestrel/preview.vue` is the admin-gated fallback for unsaved records; protocol in
`app/utils/preview-protocol.ts`) →
`modules/prerender-routes/*` (build-time route discovery — `discover.ts` finds every pageLike table by its
partial `path` index) → `server/routes/sitemap.xml.get.ts` + `server/utils/sitemap.ts` →
`server/utils/populate-links.ts` + `plugins/02.register-links.ts` → `modules/deploy-output/*`.
**Gotchas:** the internal-link populator mutates **every** collection read (registered globally), not
just public pages; links ARE status-gated — a MISSING **or** draft target renders `#` (only a collection
without a `status` column resolves unconditionally; the editor is warned separately), and every internal
target is captured as a read dep so an availability change re-renders the referrer — while the sitemap +
prerender discovery stay published-only; build-before-migrate hazard — prerender/
sitemap/link-resolve read the DB at points where the table may not exist yet, so they degrade
gracefully; richtext internal links (`kestrel:<col>:<id>` markers) are a separate mechanism from the
`link` field.
**Docs:** `static-output.md` (prerender/sitemap/deploy), `reference-integrity.md` (the invalidation model, durable `publish_deps`, status-gated links), `block-editing.md` (BlockRenderer + preview seam).

---

## Conventions

- **TDD, mandatory** — failing test → confirm it fails → implement → confirm pass → commit.
- One feature = one branch off `main`, fast-forward-merge back, delete the branch. Conventional Commits.
- Tests by suffix → runner: `*.test.ts` → node, `*.dom.test.ts` → happy-dom (`vitest.config.ts`);
  `*.nuxt.test.ts` → `vitest.nuxt.config.ts`; `test/e2e/*.test.ts` → `vitest.e2e.config.ts`.
- happy-dom does **not** render teleported widgets → smoke-test presence, test load-bearing logic in
  pure utils.

See [`configuration.md`](configuration.md) for the single config source (`kestrel.config.ts`) and the
`KESTREL_* env → config → default` precedence; the per-topic docs for the flagship subsystems.
