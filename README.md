# Kestrel

A slim, **static-site-generator CMS**: a generic collection-driven CRUD core with a schema-driven admin
editor. You declare collections and fields in TypeScript; Kestrel derives the database, a typed CRUD API,
and a full admin UI from those definitions, and renders published content to static HTML via
`nuxt generate` — there is **no live public SSR**.

Built on **Nuxt 4 layers + Drizzle/SQLite + Zod**. The whole CMS is a stack of swappable Nuxt layers, so
a consumer extends it (`extends: ['@michaelthielemann/kestrel']`) and drops in their own collection/field/block definitions.

## What Kestrel is — and isn't

Kestrel is a **CMS engine**, not a finished website. It ships the admin UI, the schema/CRUD/render
engines, and two toggleable built-in collections (`pages` + the `media` library); **you** define your
content model and bring the public components and layout that render it.

It is for a private editing origin that publishes **static HTML** (a local dir or S3), served by any
static host. It is deliberately **not**:

- **No live public SSR** — published pages are static (`nuxt generate` or the runtime incremental
  publisher); there is no per-request rendering of the public site.
- **Single-user** — one admin (session + CSRF). No roles, capabilities, or multi-user.
- **SQLite only** — one database, single instance. (A Postgres `Dialect` seam exists; no impl is active.)
- **No public data API** — only published *page-like* records have a read surface (mirroring the static
  output); everything else stays behind the admin guard. No per-request rate limiting / live API.
- **No runtime redirect engine** — redirects are *authored* in the CMS and published as a `redirects.json`
  artifact, but Kestrel never answers a 30x itself; an edge (NGINX / njs / CloudFront) has to read it.
- **No per-file access control on uploads.** The admin guard protects the media *library*, not the
  bytes; the editing origin is meant to be non-public and published media is public by definition. See
  [media.md](./docs/guide/media.md).

## Features

- **Runnable in one command** — `pnpm create kestrel` scaffolds a project that boots with a working
  `/admin`, asking you to choose the admin password and writing its hash; `kestrel init` does the same to an
  existing project without clobbering it, and `kestrel doctor` names whatever is still missing.
- **Collection-driven** — declare collections + fields in TypeScript; Kestrel derives the SQLite tables, a
  typed CRUD REST API, and the full admin UI. The schema **migrates itself** (additive in dev; explicit
  `db:migrate` in prod).
- **Field types** — twelve built in: text (single- or multi-line), slug, richtext, number, boolean,
  datetime (date / time / range), choice (select / buttons / checkboxes), media, relation (single /
  many), link (internal / external / email / tel), repeater (nestable), JSON — plus per-field `condition`
  visibility rules. Register your own with `defineFieldType`.
- **Page-like collections** — give a collection a `path`, SEO meta, and block or flat content; published
  records render to static HTML and join the sitemap. **Singletons** for settings / navigation.
- **Block page-builder** — a 3-pane editor (tree · live preview · fields) with nestable block slots; each
  block is a single `app/blocks/*.vue` SFC (schema via field-factory `defineProps` + the display template).
- **Media library** — upload (magic-byte sniff + SVG sanitize), local or S3 storage, responsive WebP
  derivatives + thumbhash, folders, and a full-screen asset viewer. Optional **EU AI Act (Art. 50)
  disclosure** fields per asset, with an upload-time scan for AI-origin signals (off by default).
- **Multilingual content** — optional per-record translations, an editor locale flow, locale-prefixed
  routing, hreflang alternates in the sitemap.
- **Static output** — `nuxt generate` (full rebuild) or a runtime **incremental publisher** (re-renders
  only the pages a write affects), to a local dir or S3; emits `sitemap.xml`, `robots.txt`,
  **`llms.txt`** (an [llmstxt.org](https://llmstxt.org) site map so AI agents grasp the site) and
  `redirects.json`. A live in-dashboard preview renders straight from the origin.
- **Search + answer engines** — canonical / Open Graph / hreflang tags and a schema.org JSON-LD graph
  (`WebSite` + `WebPage`/`Article` + `BreadcrumbList`) on every page, no wiring. Two opt-in extras publish
  more than the page already showed: `seo.articleMeta` (author / publication date / keywords) and
  `seo.llmsFull` (`/llms-full.txt`, every published page's body in one document).
- **Reference integrity** — writes invalidate exactly the affected static pages; dead-reference warnings;
  required + globally-unique page slugs per locale.

## Quickstart (consumer)

```bash
pnpm create kestrel my-site
cd my-site && pnpm install && pnpm dev
```

It asks you to choose an admin password and writes a project that runs as-is: `nuxt.config.ts` extending the
meta-layer, an `app.vue` that renders, a `.env` holding a fresh session secret and the scrypt hash of
your password, and one example block. Sign in at <http://localhost:3000/admin>.

Already have a project? Run it in place — existing files are kept, `package.json` and `.env` are merged:

```bash
pnpm add @michaelthielemann/kestrel
pnpm kestrel init      # completes the project
pnpm kestrel doctor    # or just diagnose one that misbehaves
```

Installing the package **alone does nothing**: Nuxt only loads Kestrel once a config extends it. If you
would rather wire it up by hand, that is two files:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  extends: ['@michaelthielemann/kestrel'],
  kestrel: {
    db: '.data/site.sqlite',
    siteUrl: 'https://example.com',
    siteName: 'Example',                // used in the generated llms.txt
    locales: ['en', 'de'],
    media: { uploadDir: '.data/uploads' },
    // collections: { pages: false },   // drop a built-in to define your own with that name
  },
})
```

```ts
// server/collections/products.ts — auto-discovered; the table is created on next boot
export default defineCollection({
  name: 'products',
  mode: 'multi',
  fields: { title: { type: 'text', required: true }, price: { type: 'number' }, image: { type: 'media' } },
})
```

Set the auth env (`KESTREL_SESSION_SECRET`, `KESTREL_ADMIN_PASSWORD_HASH`), start the app, and manage
content at `/admin`. You bring your own **public layout** and **block SFCs**
(`app/blocks/Hero.vue` — one file for schema + display — is the `hero` block).

> **Do not add an `app/app.vue` that omits `<NuxtPage />`.** A project-owned one shadows the layer's, and
> the file `nuxi init` writes renders `<NuxtWelcome />` instead of your routes — the admin then appears to
> be missing rather than blank. Kestrel reports this at build time; `kestrel doctor` catches it earlier.

Full walkthrough: **[getting-started.md](docs/guide/getting-started.md)**.

## Documentation

Two doors, one per audience:

- **[Guide](docs/guide/README.md)** — building a site with the package: collections, fields, blocks,
  media, publishing, deployment, configuration, extension points.
- **[Internals](docs/internals/README.md)** — developing Kestrel itself: architecture, layers and
  packages, the pipeline engine, test rails, releasing, the ADR log.

Most-asked pages: [getting started](docs/guide/getting-started.md) ·
[field types](docs/guide/field-types.md) · [blocks](docs/guide/blocks.md) ·
[configuration](docs/guide/configuration.md) · [deploying](docs/guide/deploying.md) ·
[troubleshooting](docs/guide/troubleshooting.md).

## Layout

The domain/server code lives in ten `@kestrel/*` packages under `packages/` (`contracts`, `core`,
`fields`, `auth`, `access`, `collections`, `media`, `publishing`, `delivery-live`, `delivery-static`).
The nine Nuxt layers under `layers/` are thin wiring shells around those packages, except where a surface
depends on Nuxt's own component resolution and auto-imports: the `ui` and `admin` layers (design system
and editor SPA) and the `app/` halves of `media` and `public` stay real code in layers. Layers import
packages by name; packages never import layers.

`playground/` is a small consuming example, `templates/starter/` is what the scaffolder writes,
`scripts/kestrel.mjs` is the CLI, and `packages/create-kestrel/` the `pnpm create kestrel` front end.
The full map: [layers-and-packages.md](docs/internals/layers-and-packages.md).

## Development

Requires Node + [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev            # dev server (admin at /admin)
pnpm build          # production build
pnpm generate       # render the static public site to .output/public

pnpm test           # node + happy-dom unit tests
pnpm test:nuxt      # Nuxt-environment component tests
pnpm test:e2e       # end-to-end tests (real dev server)
pnpm lint           # ESLint (Nuxt-aware, generated from the playground)

pnpm db:generate    # drizzle-kit: generate a migration
pnpm db:migrate     # drizzle-kit: apply migrations
pnpm hash-password  # produce a KESTREL_ADMIN_PASSWORD_HASH

node scripts/kestrel.mjs init <dir>   # the consumer scaffolder, from a checkout
node scripts/kestrel.mjs doctor <dir> # diagnose a consumer project
```

Conventions, test rails and the release flow: [internals/testing.md](docs/internals/testing.md) and
[internals/releasing.md](docs/internals/releasing.md). Running a built site — production env, the static
publisher, rehearsing a deploy locally: [deploying.md](docs/guide/deploying.md).

## Configuration

Non-auth settings live in `kestrel.config.ts` (`satisfies KestrelConfig`); each setting follows
`KESTREL_* env → config → default`, resolved at build/dev start and frozen into `runtimeConfig` (a prebuilt
server is retuned with the `NUXT_*` runtimeConfig names, not `KESTREL_*`). Auth/session secrets are
**env-only** and read per request (`KESTREL_SESSION_SECRET`, `KESTREL_ADMIN_PASSWORD_HASH`, …). Full reference:
[configuration.md](docs/guide/configuration.md).

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md), which also lists the documented design
decisions that are explicitly out of scope (uploads are not access-controlled; the editing origin is
assumed to be non-public).

## Licence

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). You may use, modify and distribute
Kestrel, including commercially and in closed-source work, as long as you keep the copyright notice and
the licence, state significant changes you make to the files, and pass the NOTICE along. The licence
grants patent rights but **no trademark rights**: the name "Kestrel" and the project's branding are not
covered, so a fork needs its own name.

Kestrel is provided free of charge, developed and published outside any commercial activity, **with no
warranty and no commercial support** (see sections 7 and 8 of the licence). If you need guarantees for a
production deployment, the honest answer is to read the code, run the test suite, and decide for yourself
— that is what the licence terms mean in practice.
