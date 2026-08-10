# Consuming Kestrel

Kestrel is distributed as a **Nuxt 4 meta-layer**. A site consumes it by extending the package and
defining its own collections — the database migrates itself.

## Install

```bash
pnpm create kestrel my-site
cd my-site && pnpm install && pnpm dev
```

The scaffolder writes a project that runs as-is, asking you once to choose an admin password:

| File | Why |
| --- | --- |
| `package.json` | `dev`/`build`/`generate` scripts, `@michaelthielemann/kestrel`, **and `nuxt` as a direct devDependency** — under a strict `node_modules` layout (pnpm) a transitive package's `nuxt` binary is not linked, so `pnpm dev` would not resolve |
| `pnpm-workspace.yaml` | `allowBuilds:` for `better-sqlite3`/`sharp`/`esbuild`/`@parcel/watcher`, so `pnpm install` builds them instead of you having to run `pnpm approve-builds`. It must be this file: pnpm 11 **ignores** `pnpm.onlyBuiltDependencies` in `package.json`. Delete it if you use npm or yarn |
| `nuxt.config.ts` | The `extends` that actually loads Kestrel, plus every `kestrel: {}` default made explicit |
| `.env` | A fresh `KESTREL_SESSION_SECRET` and the scrypt hash of the password you entered. Gitignored; `.env.example` is the committed copy |
| `app/app.vue`, `app/layouts/default.vue` | The app root and your public frame (see the warning below) |
| `app/blocks/Prose.vue` | One block type, so the page builder is not empty on first run |
| `tsconfig.json`, `.gitignore` | `noUncheckedIndexedAccess` is not inherited from a layer, and `.data`/`.env` must not be committed |

There are **two** entry points, and which one you want depends on whether the directory is empty:

| | Command | Behaviour |
| --- | --- | --- |
| **New project** | `pnpm create kestrel my-site` | Zero dependencies, downloads in a second. **Refuses** a directory that already holds a project — it will not merge into someone else's app |
| **Existing project** | `pnpm add @michaelthielemann/kestrel` then `pnpm kestrel init` | Keeps every file that exists, merges `package.json` key-wise (your values win) and fills only the `.env` keys that are absent or empty |

Both ask you to choose a password, are safe to re-run, and end by naming anything still broken — a
re-run never rotates a live session secret. The engine's CLI has three more commands:

```bash
pnpm kestrel doctor          # diagnose without changing anything
pnpm kestrel hash-password   # a KESTREL_ADMIN_PASSWORD_HASH value
pnpm kestrel secret          # a KESTREL_SESSION_SECRET value
```

Flags on both: `--name`, `--password`, `--yes` (never prompt), `--force` (overwrite / ignore a non-empty
directory). `kestrel init` and `create-kestrel` exit **non-zero** while the project still cannot serve
`/admin`, so they are safe to chain in a script.

> **`pnpm add` on its own does nothing.** Nuxt does not auto-load an installed package as a layer — until
> a config extends Kestrel, every route including `/admin` serves the default Nuxt welcome page. This is
> the single most common "the admin is missing" report.

### Wiring it by hand

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: '2026-06-02',
  future: { compatibilityVersion: 4 },
  extends: ['@michaelthielemann/kestrel'],
  kestrel: {
    db: '.data/site.sqlite',
    siteUrl: 'https://example.com',
    siteName: 'Example',                  // human name used in the generated llms.txt
    locales: ['en', 'de'],
    media: { uploadDir: '.data/uploads' },
    // collections: { pages: false },     // omit a built-in (pages / media) to define your own
  },
})
```

> Nuxt resolves `extends: ['@michaelthielemann/kestrel']` to the package's `nuxt.config`, which composes Kestrel's sub-layers
> (access, admin, auth, collections, core, fields, media, public, ui). Nuxt does **not** transitively auto-scan a
> dependency's `layers/` dir, which is why Kestrel composes them explicitly.
>
> Extend it by **package name**, not by a relative path of two levels or more. c12 decides whether an
> `extends` entry is a directory from its file extension, via `pathe` — and `pathe` reports
> `extname('../..')` as `'.'`, so it resolves the layer one directory too shallow and every `./layers/*`
> sub-extend misses. The symptom is nine `Cannot extend config from ./layers/core` warnings and a project
> where the whole CMS silently vanished. A single `'..'` is unaffected (which is why `playground/` works).

### The app shell — the one file that can hide the admin

Kestrel ships `app.vue`, `error.vue` and a `default` layout in its `public` layer, and a **project-owned
copy shadows them**: Nuxt resolves the app root with `app.mainComponent ||= findPath(layerDirs…)`, and the
consumer's layer is first in that list. Two failure modes follow, both silent:

- **`app/app.vue` without `<NuxtPage />`** — nothing renders on any route. This is exactly what `nuxi init`
  writes (`<NuxtRouteAnnouncer /><NuxtWelcome />`), so a project started that way shows the Nuxt welcome
  screen at `/admin`. The router still runs — the URL even rewrites to `/admin/login?redirect=/admin` —
  which is why it reads as a missing route rather than a missing shell.
- **`<NuxtPage />` without `<NuxtLayout>`** — pages render, but `definePageMeta({ layout })` is ignored and
  the admin loses its entire navigation shell.

So either delete the file and let the layer's take over, or make it:

```vue
<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
```

Kestrel checks this at build time and prints the fix; `kestrel doctor` reports it without a build. The same
shadowing applies to `app/error.vue` and `app/layouts/default.vue` — overriding those is normal and
expected, it is only `app.vue` that is load-bearing.

### Auth (env-only)

Secrets stay out of committed config. `kestrel init` writes both of these for you; by hand:

```bash
KESTREL_SESSION_SECRET=$(openssl rand -base64 32)
KESTREL_ADMIN_PASSWORD_HASH=$(node node_modules/@michaelthielemann/kestrel/scripts/hash-password.mjs "your-password")
# plain-HTTP localhost only:
KESTREL_SECURE_COOKIES=false
```

Without `KESTREL_ADMIN_PASSWORD_HASH` the login page still renders — signing in is what fails, with a
**503** naming the missing variable rather than a 401, so a forgotten setup step is never mistaken for a
wrong password.

Every non-auth setting also accepts a `KESTREL_*` env var (precedence: `KESTREL_*` env → `kestrel: {}` → default).

## Define a collection

Drop a file in `server/collections/` and default-export a `defineCollection(...)`. `defineCollection` is
auto-imported from the meta-layer — no imports needed:

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
is registered for the admin + the generic CRUD API. Manage records at `/admin`.

Every field also accepts these common flags: `required`, `unique` (a unique DB index + validation), and
`index: true` (a **non-unique** DB index — add it to a field you filter or sort by a lot but that isn't
unique). Both index flags flow through the schema engine (dev auto-sync) and `drizzle-kit`.

> The built-in collections are `pages`, `media`, and `media_settings` (a nav-hidden system store).
> `folders` is a plain support table, not a manageable collection, and has no `collections` toggle. Only
> `pages`/`media` are toggleable. To customise one, either disable it
> (`kestrel: { collections: { pages: false } }`) and define your own, or define a collection with the same
> name — Kestrel warns and the later definition wins. (`posts` / `settings` are **not** built in — they're
> demo content in this repo; build your own as needed, e.g. a `settings` singleton for site-wide nav.)
>
> Kestrel ships the render engine but **no public components**: provide your own page layout and one
> block SFC per block type (`app/blocks/Hero.vue` — schema + display in one file — is the `hero` block).
>
> **Styling is yours.** Kestrel's admin uses SCSS internally but ships `sass` and scopes its design system
> to `/admin`, so it never touches your public site — use any CSS approach there (Bootstrap, Tailwind,
> plain CSS) with no conflicts.

### Page-like collections (rendered to static HTML)

Add `pageLike: true` and your collection's published records become routable: each gains a `path` (e.g.
`/promo`) that `nuxt generate` renders to a static HTML file — exactly like the built-in `pages`, and
across **every** pageLike collection, so your own page types ship to the static site. Pair it with
`seo: true` (meta tags) and `blocks: { enabled: true }` (block content):

```ts
export default defineCollection({
  name: 'guides',
  mode: 'multi',
  pageLike: true,            // gives the collection a `path` and makes its published records routable
  seo: true,                 // per-record SEO meta (title / description / noindex)
  blocks: { enabled: true },
  status: true,              // draft / published — only published records render or appear in the sitemap
  fields: { title: { type: 'text', required: true } },
})
```

Published records are reachable at their `path`, listed in `sitemap.xml`, and resolved across collections
by the catch-all; drafts never render. A pageLike record always has a slug: it is **required** and
auto-generated from the title (slugified) when left blank, and the resolved route is **globally unique
per locale** — one localized route maps to exactly one record across all pageLike collections (`/de/x` and
`/en/x` coexist as different routes, but a bare `/x` in `pages` and `posts` cannot both exist), so there
are no path ties. Migrate the schema (below) before generating so the new table ships.

A pageLike collection's **published** records are also reachable through the runtime API the same way they
ship to the static site — `GET /api/<name>` (published-only) and `GET /api/<name>/<id>` (404 for a draft);
drafts stay private and the tooling sub-routes (`/options`, `/<id>/translations`, `/<id>/dead-refs`) remain
admin-only. (A non-pageLike collection has no public surface — its whole `/api` stays behind the guard.)

**Writes** (all admin-only, CSRF-checked):

- `POST /api/<name>` create · `PATCH /api/<name>/<id>` update · `PUT /api/<name>` upsert a singleton.
- `POST /api/<name>/bulk` — one endpoint for batch actions: `{ action, ids }` where `action` is
  `delete` | `publish` | `unpublish` | `duplicate`. `delete`/`publish`/`unpublish` are all-or-nothing
  (an unknown id 404s before any write); `duplicate` returns the **created** ids in `ids`. This is the
  wire surface behind both the collection list's Bulk bar and the per-row quick-actions.
- **Optimistic concurrency:** a `PATCH`/`PUT` may send an `X-Kestrel-If-Unmodified-Since: <updatedAt-ms>`
  header (the `updatedAt` epoch you last read). If the record has changed since, the write is refused with
  **409** before any mutation — so a stale editor tab can't silently revert a newer save. Omit the header
  for an unconditional write.

### Field layout

By default the editor renders one field per row, in declaration order. Add a `fieldLayout` to arrange the
collection's fields into side-by-side columns and named groups. It is **presentation only** — it changes
nothing about storage, validation, or the API.

```ts
export default defineCollection({
  name: 'events',
  mode: 'multi',
  fields: {
    title: { type: 'text', required: true },
    startsAt: { type: 'datetime' },
    endsAt: { type: 'datetime' },
    metaTitle: { type: 'text' },
    metaDescription: { type: 'text' },
    body: { type: 'richtext' },
  },
  fieldLayout: [
    'title',                              // a lone string → its own full-width row
    ['startsAt', 'endsAt'],               // an array → a side-by-side row (equal columns)
    { 'SEO': [['metaTitle', 'metaDescription']] },  // a single-key object → a named group of rows
  ],
})
```

Each entry is one of:

- **a string** — a full-width row (`'title'`). Add a width to give it a single sized track: `'title|50%'`.
- **an array** — fields side by side. Equal columns by default, or size each with `|`:
  - `'field|2'` — a **flex weight** (`2fr`), so `['a|2', 'b|1']` splits 2 : 1.
  - `'field|30%'` — an explicit **length/percent** (`%`, `px`, `rem`, `em`, `fr` allowed).
- **a single-key object** — a **named group** rendered as a labelled `<fieldset>`: `{ 'SEO': [ …rows ] }`.
  A group's value is a list of **rows** (each a string or an array), so `{ 'SEO': ['a', 'b'] }` stacks two
  full-width rows while `{ 'SEO': [['a', 'b']] }` is one two-column row. Groups are **one level deep** — a
  group may not contain another group. A group heading is a **plain string** — it is the object's key, so
  (unlike a field or collection label) it is **not** localizable.

Any field you **omit** from `fieldLayout` is appended as a full-width row at the end, in declaration order,
so adding a field can never silently hide it. Columns collapse to a single column on narrow editor panes. An
unknown field name, a duplicate field, an invalid width, or a nested group **throws** — the layout is
validated both when the collection is defined (`defineCollection()`) and when its schema is serialized, so a
bad layout fails at import/startup, never silently at render.

A repeater's sub-fields take the same layout under `options.fieldLayout`:

```ts
fields: {
  links: {
    type: 'repeater',
    options: {
      fields: { label: { type: 'text' }, url: { type: 'text' } },
      fieldLayout: [['label', 'url']],   // each repeater row lays its sub-fields out side by side
    },
  },
}
```

> This is where Kestrel deviates from Pruvious: the layout lives **top-level** on the collection
> (`fieldLayout`, beside `fields`) rather than under a `dashboard` wrapper, matching Kestrel's flat
> `CollectionDef`. Repeaters keep Pruvious's `options.fieldLayout`.

### Conditional fields

Any field (collection field or block field, at any depth) can carry a `condition` that shows it only when
other fields match. A hidden field is exempt from `required` and gets a **nullable** column; `required` is
re-enforced — on the client and authoritatively on the server — only while the field is visible.

```ts
fields: {
  kind: { type: 'choice', options: { choices: [{ label: 'Image', value: 'image' }, { label: 'Embed', value: 'embed' }] } },
  // shown (and required) only when `kind` is "image":
  alt:      { type: 'text',  required: true, condition: { field: 'kind', is: 'image' } },
  embedUrl: { type: 'text',  required: true, condition: { field: 'kind', is: 'embed' } },
}
```

A condition is a leaf rule combined by explicit `and` / `or` / `not`:

```ts
condition: { field: 'kind', is: 'image' }                       // strict equality shorthand
condition: { field: 'count', op: { gte: 1, lt: 10 } }           // operators (multiple keys are ANDed)
condition: { or: [{ field: 'a', is: true }, { field: 'b', is: true }] }
condition: { not: { field: 'status', op: { in: ['archived'] } } }
condition: { field: 'tags', op: { empty: false } }              // present (non-empty)
```

Operators: `eq` `ne` `gt` `gte` `lt` `lte` (scalars; type-sensitive) · `in` `notIn` · `regexp`
(case-sensitive) · `empty`. A bare `{ field }` (no `is`/`op`) means "present". `is`/`op` are
type-sensitive — `{ is: true }` does not match `1`.

**v1 scope:** `field` references a **sibling** in the same scope (a sibling collection field, or a sibling
prop of the same block) — `name` or `./name`. Cross-scope paths (`../parent`, `/root`, repeater
item-counts) and conditions on repeater **sub**-fields are not yet supported; an unresolvable path simply
hides the field (it never errors). A hidden field's stored value is left as-is (not cleared) in v1.

### List filtering

The list endpoint `GET /api/<name>` accepts per-field filters on the query string. This is the **same** code
path the admin list UI uses — filtering is not admin-only. It also works on the public, published-only read
of a `pageLike` collection (your filters compose with the published scope, so drafts still never leak).

The wire form is `filter[<field>][<op>]=<value>`. A bare `filter[<field>]=<value>` (no operator) means `eq`,
so plain-equality URLs keep working unchanged. Repeat a key to AND two clauses on one field.

```bash
# products under 50, in stock, created this year
GET /api/products?filter[price][lt]=50&filter[inStock]=true&filter[createdAt][gte]=2026-01-01
# a repeated key ANDs: rows tagged BOTH "a" and "b"
GET /api/products?filter[tags][contains]=a&filter[tags][contains]=b
```

Which operators a field accepts depends only on its **kind** (its storage/semantics bucket):

| Kind | Field types (and system columns) | Operators |
| --- | --- | --- |
| `number` | `number` · the `id` column | `eq` `ne` `lt` `lte` `gt` `gte` |
| `datetime` | non-range `datetime` · `createdAt` · `updatedAt` | `eq` `ne` `lt` `lte` `gt` `gte` |
| `text` | `text` · `slug` · a `pageLike` `path` | `eq` `ne` `contains` |
| `richtext` | `richtext` | `contains` |
| `boolean` | `boolean` | `eq` `ne` |
| `enum` | single `choice` · a `status` column | `eq` `ne` |
| `ref` | single `relation` · single `media` | `eq` `ne` |
| `stringSet` | multi `choice` | `contains` `notContains` |
| `idSet` | many `relation` · multiple `media` | `contains` `notContains` |

`id`, `createdAt`, and `updatedAt` are always filterable (with the comparison operators shown); `path` only
on a `pageLike` collection and `status` only when `status: true`. `link`, `json`, `repeater`, and a **range**
`datetime` are not filterable at all. For the set kinds (`stringSet` / `idSet`), `contains` means **array
membership** — the value equals one element — not a substring, and `notContains` is its negation (an `idSet`
value must be a numeric id).

Everything is fail-loud with a clean **400** (never a 500): an unknown operator token, a field that does not
exist or is not filterable, and an operator that field's kind does not allow are each rejected with a
descriptive message. Values are coerced to the column's type — a `boolean` accepts `true`/`1`, a `datetime`
accepts any parseable date string (an unparseable one is a 400).

> **The negating operators INCLUDE empty values.** On a nullable column `ne` matches rows where the field is
> unset as well: `filter[category][ne]=news` also returns the uncategorised records, which are certainly not
> `news`. That is a deliberate departure from SQL's `<>`, whose three-valued logic drops NULL rows — it
> matches how the admin labels the operator ("is not") and how `notContains` already behaves on an unset
> set-valued field. On a `notNull` column (a required field, or one carrying a default) `ne` is plain `<>`.
> There is no operator for "is / is not empty"; use `eq`/`ne` against the value you do know.

> **`contains` matches the RAW STORED STRING** for `text`/`richtext`. Text is a case-insensitive substring
> (ASCII). For `richtext` the stored string is the **HTML source**, so `filter[body][contains]=span` (or
> `a`, `class`, …) can match a `<span>` tag or a `class="…"` attribute, not just visible prose. Treat
> richtext `contains` as a source-text search; a stripped/indexed text search is a possible later enhancement.

### Advanced: when you need the drizzle table object

The form above is all most collections need — records are managed through the admin and the generic
`/api/<name>` CRUD. If a custom server route needs to query your table directly with Drizzle, build it
explicitly and export the table; `buildCollection` is auto-imported too:

```ts
// server/collections/products.ts
const built = buildCollection(defineCollection({ name: 'products', mode: 'multi', fields: { /* … */ } }))
export const products = built.table   // import { products } in your own server code
export default built                  // discovery accepts a built collection too
```

## Custom field types

Beyond the built-ins you can register your own field type — its storage + validation (server) and its
editor input widget (client) — and use it in any collection or block, exactly like a built-in.

**Server** — drop a file in `server/field-types/` that default-exports `defineFieldType`. It is
auto-discovered and registered *before* any table is built. `constrain` (column nullable/unique/default)
and `opt` (Zod optionality) are the same helpers the built-ins use; both are auto-imported:

```ts
// server/field-types/color.ts
import { text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

export default defineFieldType({
  name: 'color',
  column: (n, f) => constrain(text(n), f),                       // TEXT column, honouring required/unique/default
  validator: (f) => opt(z.string().regex(/^#[0-9a-f]{6}$/i), f), // hex string, required-aware
})
```

**Client** — register an editor widget for the type from a client plugin. The widget honours the shared
field props (`field`, `name`, `error`, `disabled`, `id`) plus a `v-model`; `UiField` is the label/error
wrapper, and `registerFieldComponent` is auto-imported:

```vue
<!-- app/components/field/Color.vue -->
<script setup lang="ts">
defineProps<{ field: unknown; name: string; error?: string | null; disabled?: boolean; id?: string }>()
const model = defineModel<string | null>()
</script>
<template>
  <UiField :id="id" :label="name" :error="error">
    <input type="color" :value="model ?? '#000000'" :disabled="disabled"
      @input="model = ($event.target as HTMLInputElement).value" />
  </UiField>
</template>
```

```ts
// app/plugins/field-types.client.ts
import Color from '~/components/field/Color.vue'
export default defineNuxtPlugin(() => {
  registerFieldComponent('color', Color) // the editor resolves the widget by type name
})
```

Now `{ type: 'color' }` works in any collection or block, and flows through everything for free — the DB
column, server + client validation, the editor, the serialized schema, and the live preview. (An
unregistered type renders a clear "unsupported field" placeholder rather than crashing.)

> **Non-scalar backings.** A custom type stored as an **array/object** (e.g. a json column) should register
> a blank value so a new record/block seeds the right shape — `registerFieldEmpty('mytype', () => [])`
> (auto-imported, same client plugin) — and its widget should tolerate a `null` value like the built-ins do
> (`Array.isArray(v) ? v : []`). Scalar types (text/number/boolean-backed, like `color`) need nothing extra.

## Custom editor bodies

The editor's frame (header, save, unsaved-guard, locale bar, preview) is generic; the BODY between them is
pluggable per collection. A collection picks its body with the `editor` option:

```ts
export default defineCollection({ name: 'flows', mode: 'multi', editor: 'node-graph', fields: { … } })
```

`editor` defaults to `'blocks'` when `blocks.enabled`, else `'fields'` (both built-in). Register your own
body from a client plugin — any component that takes the shared edit-form props:

```ts
import { registerCollectionEditor } from '#imports' // auto-imported
registerCollectionEditor('node-graph', MyNodeGraphBody)
```

An `editor` type with no registered body renders a clear "no editor is registered" placeholder (localized)
rather than a blank pane. This is how the galleries and node-graph extensions swap the editor surface.

## Site-wide head settings

The **Site** entry in the admin holds the tier above a single page: a base title, its separator and
position, a default meta description, and a default sharing image. Per locale, because a base title is.

Each value is a fallback, not an override — a page that sets its own SEO description keeps it, and the site
value fills in for every page that does not. An untouched Site record changes nothing about the emitted
head.

- `siteUrl` and `siteName` stay in `kestrel.config.ts`. The build needs them for canonical URLs, the sitemap
  and `robots.txt`, so they cannot be read from the database.
- Only the document `<title>` is composed. `og:title` keeps the bare page title, since `og:site_name`
  already carries the site name.
- The separator is stored as a bare token (`|`, `·`, `—`) and padded with single spaces when rendered — a
  text field trims on write, so a stored `" | "` could not keep its spaces.
- A page title that already ends in the base title is left as it is, which matters for content migrated
  from a CMS that baked the site name into every title.
- Switch the whole thing off with `kestrel: { collections: { site: false } }`.

## Per-page layouts

Ship more than one layout in `app/layouts/` and an editor can pick which one renders a page — the page
editor grows a **Layout** control under Page Options, listing the layouts your project actually has. Nothing
to register: they are discovered from Nuxt's own layout resolution, so a layout of yours that shadows one of
Kestrel's is what appears.

```
app/layouts/
  default.vue            ← every page unless it says otherwise
  landing.vue            ← offered in the editor as "landing"
  legal.vue              ← offered as "legal"
```

Notes worth knowing before you rely on it:

- **A single-layout project sees no control.** With only `default.vue` there is nothing to choose, so the
  select stays out of the pane. The `admin` layout is never offerable.
- **Leaving it unset is the normal case** and stores `NULL`, which renders `default`. The select shows that
  as one entry ("Standard (default)"); `default` is not separately listed, because an unset value already
  means it.
- **Deleting a layout file does not break the pages that referenced it** — they fall back to `default`
  rather than blanking. Nothing warns you, though, so grep your DB for the name before you delete the file
  if a page depended on that layout for something load-bearing.
- **The choice is per row, not per translation group.** Each locale's page is set independently.
- Your layout can read the record it is rendering via `usePublicPageState()`, which holds during SSR and
  static generation.

## Opt-in extensions

Some features ship as **separate, opt-in extension layers** (own packages, never bundled with the core). You
compose them *after* the core and they add field types / composables / components you wire into your own
collections and blocks:

```ts
// nuxt.config.ts
export default defineNuxtConfig({ extends: ['@michaelthielemann/kestrel', '@michaelthielemann/kestrel-galleries-secure'] })
```

- **`kestrel-galleries-secure`** — the foundation for **zero-knowledge encrypted galleries** (images + folder
  names encrypted client-side with a password; the server only ever stores ciphertext). It ships *primitives*
  — a `secureGallery` field type, the `useSecureGallery` composable, and a `<SecureGalleryView>` component —
  not a finished collection/block, so you assemble your own (a `pageLike`+`status` collection for slug-reachable,
  toggleable galleries; a block with a `secureGallery` field; a 3-line display using `<SecureGalleryView>`).
  See its README for the copy-paste recipe (mirrored in `playground/` as a working demo).

## Schema lifecycle

The schema is **derived from your collections** (no hand-written migrations):

| Environment | Behaviour |
| --- | --- |
| **Dev** | Auto-syncs **additive** changes at server boot (new table/column/index). Destructive changes (drop/rebuild) are detected but withheld — you're told to run the explicit step. |
| **Prod** | Boot never touches the schema, but it DOES a read-only **drift check** and logs a loud warning (with the pending changes) if the live DB is behind your collections — so an upgrade that forgot `db:migrate` is obvious. Apply changes with the `db:migrate` task. |

> **Upgrading the `kestrel` package:** a release that adds an engine table/column changes the derived schema,
> so after `pnpm up kestrel` run the `db:migrate` task (below) against your prod DB. The boot drift warning
> tells you when it's needed; there is no automatic changelog of schema-affecting releases yet.

This Nuxt/Nitro (4.4 / 2.13) has **no `nuxi task run` CLI**. Trigger `db:migrate` via the dev task route,
or programmatically in prod (`runTask('db:migrate', { payload })` from an authenticated route or a cron
`scheduledTask` — the built node-server has no task endpoint):

```bash
# dev (server running): the dev-only task route
curl http://localhost:3000/_nitro/tasks/db:migrate          # apply additive changes
```

```ts
// prod: from inside the Nitro process
await runTask('db:migrate')                       // apply additive changes
await runTask('db:migrate', { payload: { check: true } })  // dry run — report pending DDL, change nothing
await runTask('db:migrate', { payload: { force: true } })  // also apply DESTRUCTIVE changes (drop/rebuild)
```

A rebuild that can't succeed (e.g. a new NOT NULL column with no default on a populated table) fails up
front with a clear message and changes nothing — see `docs/architecture-decisions.md` (ADR-0002).

> **Contributing to Kestrel itself** (not a concern for consumers): the repo ships committed `drizzle-kit`
> migrations AND runs the dev auto-sync, so on an existing in-repo dev DB a generated `CREATE TABLE`/index
> can collide with an already-synced object. Make new tables/indexes in a hand-checked migration idempotent
> (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`), or reset your local `.data/db.sqlite`
> before applying, so boot-time `00.migrate` doesn't fail on an already-present object.
