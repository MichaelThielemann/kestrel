# How Kestrel works

This page is the mental model every other guide page assumes: what Kestrel is, and the vocabulary — collections, records, pages, draft/published, save/publish/preview — it's built from.

## A CMS engine, not a finished site

Kestrel is a **CMS engine**, not a finished website: it ships the admin UI and the schema/CRUD/render engines, plus a small set of built-in collections — `pages`, the `media` library, and the `site` and `redirects` singletons, of which `pages` and `media` are the two you can switch off (see [collections.md](./collections.md)). You define your content model with `defineCollection` and bring the public Vue components and layout that render it. Nothing about the public side of a Kestrel site is templated for you — Kestrel's job ends at giving you validated data, a render engine, and a place to author it.

It runs as a Nuxt 4 **meta-layer** — a site extends the Kestrel package and adds its own collections. In dev, the schema auto-syncs additive changes at boot; production boot never touches the schema, and changes are applied with the `db:migrate` task instead — see [schema-lifecycle.md](./schema-lifecycle.md). A private editing origin manages content, and publishing renders it to **static HTML** (`nuxt generate` for a full build, or the runtime incremental publisher for a single record) served by any static host — a local directory or S3, behind whatever CDN or reverse proxy you already run. That's the default (`kestrel.delivery: 'static'`); once a page is published under it, Kestrel is off the request path entirely. A `'live'` mode also ships, serving each request straight from the publish history instead of a file on disk — see [publishing.md](./publishing.md).

Other standing limits worth knowing up front, all deliberate rather than accidental gaps:

- **Single admin identity.** No roles, capabilities, or multi-user accounts. Sessions are stateless signed cookies — several can be live at once, and logging out or rotating the password hash revokes all of them.
- **SQLite only.** One database file, one instance. A slot for a second database backend exists internally, but SQLite is the only implementation shipped.
- **No public data API.** Only published page-like records have a read surface, mirroring what ships to the static output; everything else — including drafts — stays behind the admin guard. The read surface has no rate limiting of its own (the login route is throttled per client IP) and no live query API.
- **No runtime redirect engine, under the static default.** Redirects are *authored* in the CMS and published as a `redirects.json` artifact; under `delivery: 'static'`, Kestrel never issues a 30x itself and an edge (a reverse proxy, or a CDN function) has to read the artifact and act on it. Under `delivery: 'live'` the app answers the redirect itself. See [redirects.md](./redirects.md).
- **No per-file access control on uploads.** The admin guard protects the media *library* (listing, editing, deleting) but not the bytes themselves — published media is public by definition, the same way a published page is. See [media.md](./media.md).

These are not omissions to be filled in later; they follow from the same premise as the publish model — a private single-editor origin that produces a public artifact, whether served as static files or through the live delivery port — and a site that needs multi-user roles, a live database-backed API, or a different storage engine is outside that premise entirely.

## Auto-imports

Kestrel auto-imports every public function and constant exported by its server packages (`kestrel-core`, `-fields`, `-contracts`, `-auth`, `-access`, `-media`, `-collections`, `-publishing`, `-delivery-live`, `-delivery-static`) into `server/` code, and every export of `kestrel-core/client` and `kestrel-fields/client` into `app/` code — not a curated shortlist. Explicit imports from the package still work and are required outside a Nuxt/Nitro context (standalone scripts, tests). The package a name belongs to is whichever one its guide page shows.

## Collections, fields, blocks

A **collection** is a content type, defined once with `defineCollection`:

```ts
export default defineCollection({
  name: 'guides',
  mode: 'multi',
  fields: { title: { type: 'text', required: true } },
})
```

Kestrel builds the database table, the Zod validation schema, the admin editor form, and the CRUD API from that one definition — there is no separate schema file, migration file, or form layout to keep in sync by hand. `mode: 'multi'` gives many rows (posts, products, guides); `mode: 'single'` gives one singleton row (site settings, a global nav). Each field has a `type` — see [field-types.md](./field-types.md) for the built-in set and how each one stores and validates its value, and [custom-field-types.md](./custom-field-types.md) for defining your own with `defineFieldType`.

**Blocks** are freeform, ordered body content: an array of typed chunks (rich text, image, a custom block type) that a collection opts into with `blocks: { enabled: true }`, stored in a single `content` column rather than in a field of its own. Where a fixed field like `title` holds one value of one type, block content is an editor-ordered sequence of differently-typed chunks — the shape a long-form article or landing page body needs. Turning it on also switches the record editor to the 3-pane page builder. See [blocks.md](./blocks.md) for defining block types and rendering them.

A collection can also declare **field layout** (how fields arrange into rows, columns, and named groups in the editor), conditional fields (a field that only appears when another field has a given value), and list filtering (how the admin's record list can be searched and filtered) — see [field-layout.md](./field-layout.md) and [querying.md](./querying.md).

A collection can also be **localized**, giving each record one row per locale instead of one row total — see [multilingual.md](./multilingual.md) for how that interacts with routing and the admin editor.

None of these are separate systems bolted onto a plain collection — field layout, conditional fields, blocks, and localization are all declared on the same `defineCollection` call, and the editor form, validation, and database schema all pick them up from that one place.

## Records vs. routable pages

A row in a collection is a **record**. By default a record has no URL — it exists only in the admin and the CRUD API. Adding `pageLike: true` to a collection makes its published records **routable**: each gets a `path`, and `nuxt generate` renders it to a static HTML file, exactly like the built-in `pages` collection. A `pageLike` collection must be `mode: 'multi'` — a routable record needs the slug engine, which a singleton has no room for. This works across every pageLike collection at once, so a site can define as many page types as it needs (guides, products, docs) and all of them ship to the static output.

A pageLike record always has a slug — required, auto-generated from the `title` field, or the first text field when the collection has none, whenever it is left blank — and its resolved route is globally unique per locale: one localized route maps to exactly one record across all pageLike collections (`/de/x` and `/en/x` can coexist as different routes, but a bare `/x` cannot belong to both `pages` and `posts` at once). A non-pageLike collection has no public surface at all; its whole API stays behind the admin guard, and its records exist only for the admin to manage — a settings singleton, or a lookup table another collection references.

Pair `pageLike: true` with `seo: true` for per-record meta tags and `blocks: { enabled: true }` for a block-based body. The flags, the worked example, and the exact slug rules (what a blank slug is generated from, and what happens to a collision) are in [collections.md](./collections.md#page-like-collections-rendered-to-static-html).

## Draft vs. published

Add `status: true` to a collection and every record gets a `draft` / `published` status. Only published records render to static output, appear in the sitemap, or are reachable through the public read API (`GET /api/<name>/readMany`, `readOne/<id>`); a draft is filtered out of `readMany` and 404s on `readOne/<id>`, and never appears in generated HTML. Only a `pageLike` collection has a public read API to gate this way — a non-pageLike collection's whole API stays behind the admin guard regardless of `status`, so there `status` is an admin-side workflow flag only.

Status changes go through a table of legal transitions, so an illegal move is rejected with a validation error naming the transition, rather than silently applied. Taking a record live or offline is a status change, made through the same batch write endpoint the admin list's bulk actions use: `POST /api/<name>/updateMany` with `{ ids, patch: { status } }`. Writing the static output is a separate action — see below; the admin's Publish button does both.

## Save, publish, and preview are three different actions

These look related but do different things, and none implies another:

- **Save** (`POST /api/<name>/updateOne/<id>`) writes to the database. It does not touch the static output — editing a published record's content does not change what is live, so a page can be worked on for days without the in-progress edit ever reaching visitors. The exception is a save that unpublishes or deletes: that prunes the page (and re-renders whatever embeds it) immediately, on the save itself, because serving withdrawn content is worse than a stale build.
- **Publish** (`POST /api/publish`, admin-only, body `{ collection, ids }`) writes the static output: the record's own page plus every page whose baked output embeds it (a nav link, an inline reference). A publish also holds back — leaves untouched — any route whose record has been saved since its last publish, so publishing an unrelated change can't flush an in-progress edit elsewhere on the site; the route the publish call was explicitly for is the exception, which is what pressing Publish on a record clears. Which other pages a given event re-renders, and how the hold works in detail, are in [publishing.md](./publishing.md).
- **Preview** shows unsaved changes without writing anything: `POST /api/createPreview` stores the editor's current form body in a short-lived, session-bound ticket and returns a token; opening `<url>?kestrel-preview-token=…` renders that ticket's content in place of the stored record, with images and internal links resolved exactly as they are on a real page. A record with no public URL (not pageLike, or not yet saved) previews on `/__kestrel/preview` instead.

```bash
# publish two records and everything that embeds them — admin session required
curl -X POST /api/publish \
  -H 'Content-Type: application/json' \
  -H 'Cookie: kestrel_session=<admin session cookie>' \
  -d '{"collection":"guides","ids":[12,13]}'
```

A site that wants every save to publish immediately can opt out of the split entirely with `output.publishOnSave: true` — see [publishing.md](./publishing.md#opting-out-publishonsave).

## Admin app vs. your public app, and the component namespace

A Kestrel site is really two apps sharing one Nuxt project. The **admin app** is the editor Kestrel ships — collection lists, record forms, the media library — reachable only to the authenticated session. Your **public app** is the Vue components, pages, and layout you write yourself against what Kestrel exposes: collections for data, [pipelines](./extending.md) for custom server logic, field types for custom input widgets. Kestrel's job is the first app and the API the second one calls; on the public side it ships no page components — only the render engine, the `<KestrelImg>`/`<KestrelLink>` primitives, and a bare `default` layout meant to be replaced.

The two are kept from colliding by a naming convention: every component Kestrel ships is registered under a `Kestrel` prefix — `KestrelUiButton`, `KestrelFieldText`, `KestrelCollectionList`, `KestrelMediaGrid`. Your own `app/components/ui/Button.vue` stays `UiButton` and belongs to you alone; a project using the conventional `app/components/ui/` layout can't replace an admin component by accident, in either direction.

To replace an admin component deliberately, put yours at `app/Kestrel/components/...`, mirroring its path inside Kestrel:

```
app/Kestrel/components/ui/Button.vue    replaces KestrelUiButton
app/Kestrel/components/field/Text.vue   replaces KestrelFieldText
```

No other location works — Kestrel's own registration outranks your app directory everywhere else. Prefer a registry where one exists — `registerFieldComponent` for a field widget, `registerCollectionEditor` for a whole editor body, `defineFieldType` for a new field type, all three in [custom-field-types.md](./custom-field-types.md) — and treat replacing a component by name as an escape hatch: a component Kestrel imports directly rather than through auto-import isn't reachable this way, and a replaced component carries no compatibility promise across versions. The admin editor's internal `use*` composables are not part of this surface at all and carry no compatibility promise either — build your own UI against collections, pipelines, and field types instead of reaching for one by name.

## See also

- [getting-started.md](./getting-started.md) — installing Kestrel and defining your first collection.
- [collections.md](./collections.md) — the full `defineCollection` reference.
- [publishing.md](./publishing.md) — the publish pipeline, invalidation, and the incremental publisher in detail.
- [schema-lifecycle.md](./schema-lifecycle.md) — what happens to the database when a collection's fields change.
- [extending.md](./extending.md) — what a pipeline is and how to add your own `/api/` endpoint.
