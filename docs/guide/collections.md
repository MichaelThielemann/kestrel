# Defining collections

A collection is a table plus its schema, its admin UI, and its CRUD API, all declared in one `defineCollection` call.

## Define a collection

Drop a file in `server/collections/` and default-export a `defineCollection(...)`. `defineCollection` is
auto-imported in a Kestrel-based site; import it explicitly from `@michaelthielemann/kestrel-core` only
outside a Kestrel app (e.g. standalone scripts, tests). This applies to the rest of Kestrel's server-side
authoring API too (`buildCollection`, `definePipeline`, `defineFieldType`, etc.) — see
[extending.md](./extending.md).

```ts
// server/collections/products.ts
export default defineCollection({
  name: 'products',
  mode: 'multi',          // 'single' for a singleton
  // translatable: true,  // optional — defaults to false
  fields: {
    title: { type: 'text', required: true },
    price: { type: 'number', options: { integer: false } },
    inStock: { type: 'boolean' },
    image: { type: 'media' },
  },
})
```

On the next dev start the collection is discovered, its table is built and created automatically, and it
is registered for the admin and the generic CRUD API. Manage records at `/admin`.

Every field also accepts these common flags: `required`, `unique` (a unique DB index + validation — a
no-op on multi-valued fields, see [field-types.md](./field-types.md)), and `index: true` (a **non-unique**
DB index — add it to a field you filter or sort by a lot but that isn't unique). Both index flags flow
through the schema engine — dev's additive auto-sync adds them at boot, production applies them with the
`db:migrate` task; see [schema-lifecycle.md](./schema-lifecycle.md) for migrating a live database.

Every field type and every option it accepts is documented in
[field-types.md](./field-types.md) — that page is the reference for what a type stores, which
options the server enforces, and which only configure the editor widget.

## Single vs. multi mode

`mode: 'multi'` is a normal table of rows, listed and paginated in the admin. `mode: 'single'` is a
singleton: one row, no list view, no delete — the record is upserted through `updateOne` with no `id`.
`pageLike` requires `mode: 'multi'`, because a routable record is governed by the slug engine, which only
runs through the multi create/update path; a `pageLike` singleton is refused at definition time.

Every collection, in either mode, gets three columns for free: `id`, and `createdAt`/`updatedAt`
timestamps that the write pipeline stamps automatically — neither is declared in `fields`.

These, plus the columns added by `translatable`, `mode: 'single'`, `pageLike`, `status`, `seo`, and
`blocks`, form the collection's reserved column set: a field key that resolves onto one of them fails
loud at startup rather than silently overwriting it.

## Status, translations, and other definition flags

- `status: true` adds a draft/published column. Combined with `pageLike`, only published records render,
  appear in the sitemap, or answer on the public read routes; combined with reference tracking, an
  unpublished target is reported as a dead reference (see [references.md](./references.md)).
- `translatable: true` gives the collection per-locale content instead of one shared record set — see
  [multilingual.md](./multilingual.md) for how locales, fallback, and the `pages`/`posts` split work.
- `editor` picks which body the admin editor renders, and you rarely set it: it defaults to `'blocks'` when
  `blocks: { enabled: true }` and to `'fields'` otherwise. Setting `editor: 'blocks'` *without* enabling
  blocks is refused at definition time, since the block editor would otherwise mount with nowhere to
  persist its edits. See [blocks.md](./blocks.md), and
  [custom-field-types.md](./custom-field-types.md) for registering a body of your own.
- `label`, `icon`, and `nav: false` control the admin rail: display names (`label.new` is the complete
  per-locale "create" phrase, not a template, so it can get grammatical gender right), a registry icon or
  raw SVG, and whether the collection appears as a top-level rail item at all — turn `nav` off for a
  system store a layer manages through its own UI (`media_settings` is one).
- `fieldLayout` arranges fields into rows/columns/named groups in the editor; a field left out of it still
  appears, as a full-width row. See [field-layout.md](./field-layout.md) for the full DSL.
- A collection name that collides with a reserved framework API namespace (`auth`, `blocks`,
  `collections`, `links`, `publish-status`, `references`, `route`, `galleries-secure`, and
  `galleries-secure-proofing`) is refused at definition time — it would shadow that tool endpoint under
  `/api/<name>`.

## Validating across fields

For a rule the per-field schema cannot express — a field validator only ever sees its own value — a
collection may declare `validate`. It runs server-side **before** the write and returns issues keyed by
field, so they land on the field in the editor like any other validation error. Mind the asymmetry: the
`record` it reads is keyed by **column** name (`authorId` for a single `relation`/`media` field), while
an issue's `path[0]` is the **field** key:

```ts
export default defineCollection({
  name: 'events',
  mode: 'multi',
  fields: { startsAt: { type: 'datetime' }, endsAt: { type: 'datetime' } },
  validate: (record) =>
    record.startsAt && record.endsAt && record.endsAt < record.startsAt
      ? [{ path: ['endsAt'], message: 'The end must not precede the start.' }]
      : [],
})
```

## The built-in collections

Kestrel ships four manageable collections — `pages`, `media`, `site` (the site-wide head singleton, see
[seo.md](./seo.md)) and `redirects` (the edge redirect rules, see [redirects.md](./redirects.md)) — plus
`media_settings`, a nav-hidden system store. `folders` is a plain support table, not a manageable
collection, and has no `collections` toggle. `posts` and `settings` are **not** built in — they're demo
content in this repo; build your own as needed, e.g. a `settings` singleton for site-wide nav.

Only `pages` and `media` are toggleable. To customise one, either disable it
(`kestrel: { collections: { pages: false } }`) and define your own, or define a collection with the same
name — the later definition silently wins (layer over package), with no warning.

## Rendering primitives, not page components

Kestrel ships the render engine and the two field-level rendering primitives it depends on:
`<KestrelImg>` (a `<picture>` built from a media record's derivatives — a variant is derived *because*
some `<KestrelImg>` declares it, see [media.md](./media.md)) and `<KestrelLink>` (an `<a>` for a `link`
field value). It ships **no page components**, and only a bare `default` layout (`<main><slot /></main>`)
meant to be shadowed: provide your own layout and one block SFC per block type
(`app/blocks/Hero.vue` — schema and display in one file — is the `hero` block, see [blocks.md](./blocks.md)).

## Styling

Styling is yours. Kestrel's admin uses SCSS internally but ships `sass` and scopes its design system
to `/admin`, so it never touches your public site — use any CSS approach there (Bootstrap, Tailwind,
plain CSS) with no conflicts. That includes a global `vite.css.preprocessorOptions.scss.additionalData`:
Vite prepends it to *every* SCSS entry, Kestrel's shipped `<style lang="scss">` blocks included, so a
module you forward `as *` lands in their global scope too. Kestrel's own stylesheets reference every
member through its module namespace (`@include mixins.focus-ring`, never a bare `focus-ring`), so a
name you share with them — `focus-ring`, `sr-only`, `input-base` — stays unambiguous and the build is
unaffected.

## Page-like collections (rendered to static HTML)

Add `pageLike: true` and your collection's records become routable: each gains a `path` (e.g. `/promo`)
that `nuxt generate` renders to a static HTML file — exactly like the built-in `pages`, and across
**every** pageLike collection, so your own page types ship to the static site. It also gains a `layout`
column, giving the editor a per-record layout picker — see [blocks.md](./blocks.md) § Per-page layouts.
Pair it with `seo: true` (meta tags, see [seo.md](./seo.md)) and `blocks: { enabled: true }` (block
content):

```ts
export default defineCollection({
  name: 'guides',
  mode: 'multi',
  pageLike: true,            // gives the collection a `path`/`layout` and makes its records routable
  seo: true,                 // per-record SEO meta — title / description / noindex / image / author / …
  blocks: { enabled: true },
  status: true,              // draft / published — without this, every record is public and prerendered
  fields: { title: { type: 'text', required: true } },
})
```

`status: true` is what creates the published-only scope: without it a pageLike collection has no draft
state at all, and every record is prerendered and readable by anyone.

Published records are reachable at their `path`, listed in `sitemap.xml`, and resolved across collections
by the catch-all; drafts never render. A pageLike collection must be `mode: 'multi'` — a routable
singleton is refused at definition time.

### Slug rules

A pageLike record always has a slug: it is **required** and auto-generated (slugified) when left blank,
from the `title` field, or the first text field when the collection has none — you only get an error when
that source field yields no slugifiable value. The editor previews the slug-to-be as the field's
placeholder.

The resolved route is **globally unique per locale** — one localized route maps to exactly one record
across all pageLike collections. Uniqueness is checked on the **resolved localized route**
(`localePath(path, locale, …)`): `/de/about` and `/en/about` coexist as different routes, but a bare
`/about` cannot exist in both `pages` and another pageLike collection, e.g. `guides`. An explicit slug
that collides is rejected (409); an auto-generated one is de-duped (`/about`, `/about-2`, …).

This keeps one route mapped to one output file: a record's URL is settled at save time, so publishing it
only makes that route live. See [publishing.md](./publishing.md) for what a publish then invalidates and
[multilingual.md](./multilingual.md) for how locale prefixes factor into the route.

### The API surface

A pageLike collection's **published** records are reachable through the runtime API the same way they
ship to the static site; a non-pageLike collection has no public surface at all — its whole `/api/<name>`
stays behind the guard. Which routes that leaves public, which stay admin-only, the tooling sub-routes, and
the full read/write route grammar around them (filtering, paging, population, optimistic concurrency) are in
[querying.md § Published-only and public reads](./querying.md#published-only-and-public-reads); the publish
endpoint itself is in [publishing.md](./publishing.md) § The publish action.

## Advanced: when you need the drizzle table object

The form above is all most collections need — records are managed through the admin and the generic
`/api/<name>` CRUD. If a custom server route needs to query your table directly with Drizzle, build it
explicitly and export the table:

```ts
// server/collections/products.ts
const built = buildCollection(defineCollection({ name: 'products', mode: 'multi', fields: { /* … */ } }))
export const products = built.table   // import { products } in your own server code
export default built                  // discovery accepts a built collection too
```

## See also

- [field-types.md](./field-types.md) — every built-in field type and the options it accepts.
- [querying.md](./querying.md) — the full CRUD/pipeline route grammar for reading and writing records.
- [publishing.md](./publishing.md) — what publishing a pageLike record invalidates and re-renders.
- [references.md](./references.md) — dead-reference warnings and how a target counts as dead.
- [schema-lifecycle.md](./schema-lifecycle.md) — migrating the database once a collection's shape changes.
