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
- **No per-file access control on uploads.** The admin guard protects the media *library* — listing,
  editing, deleting — but not the bytes. With `media.driver: 'local'` the files are served from the app
  origin by Nitro's static handler, which runs ahead of every middleware, so anyone who knows a URL can
  fetch it; the optional IP allow-list does not cover them either (see
  [configuration.md](./docs/configuration.md#ip-allow-list--optional)). That is the intended model — the
  editing origin is meant to be non-public, and published media is public by definition. If you deploy
  Kestrel as a general-purpose CMS whose uploads must stay private, restrict them at the reverse proxy or
  serve media from a private S3 bucket; the app will not do it for you.

## Features

- **Runnable in one command** — `pnpm create kestrel` scaffolds a project that boots with a working
  `/admin`, asking you to choose the admin password and writing its hash; `kestrel init` does the same to an
  existing project without clobbering it, and `kestrel doctor` names whatever is still missing.
- **Collection-driven** — declare collections + fields in TypeScript; Kestrel derives the SQLite tables, a
  typed CRUD REST API, and the full admin UI. The schema **migrates itself** (additive in dev; explicit
  `db:migrate` in prod).
- **Field types** — text, textarea, rich-text, number, boolean, choice (select / buttons / checkboxes),
  date / time, media, relation (single / many), link (internal / external / email / tel), repeater
  (nestable), JSON — plus per-field `condition` visibility rules.
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

Full guide: **[consuming-kestrel.md](docs/consuming-kestrel.md)**.

## Documentation

Start with the **[architecture guide](docs/architecture.md)** — a per-layer map (what each layer owns,
where to start reading, the cross-layer seams, the gotchas). Then the per-topic docs:

| Doc | Covers |
|-----|--------|
| [architecture.md](docs/architecture.md) | **Start here** — the layer model, boot order, cross-cutting seams, per-layer guide |
| [field-types.md](docs/field-types.md) | Every built-in field type with its options, the column it becomes, what the server enforces vs. what only configures the widget |
| [consuming-kestrel.md](docs/consuming-kestrel.md) | Using Kestrel in your own app: defining collections/fields/blocks, auto-discovery, the schema lifecycle |
| [configuration.md](docs/configuration.md) | The single config source (`kestrel.config.ts`), every `KESTREL_*` env var, the auth/session env split |
| [block-editing.md](docs/block-editing.md) | The block content model + the 3-pane block editor (tree · preview · fields) |
| [media-uploads.md](docs/media-uploads.md) | Ingest security, storage drivers (local/S3), responsive-image derivation, EU AI Act disclosure |
| [multilingual.md](docs/multilingual.md) | Content locales, the editor locale flow, locale-prefixed routing |
| [static-output.md](docs/static-output.md) | `nuxt generate` + the runtime incremental publisher, the live editor preview, `sitemap.xml` / `robots.txt` / `llms.txt` / `llms-full.txt`, the JSON-LD structured data, CMS-managed redirects, the optional S3 deploy |
| [reference-integrity.md](docs/reference-integrity.md) | How writes invalidate the static site precisely, dead-reference warnings (a dead link renders `#`, and the editor is warned), and required/unique page slugs |
| [architecture-decisions.md](docs/architecture-decisions.md) | ADRs (the collection-derived schema engine, reference integrity, the auth/password choice) |

## Layout

The CMS is split into Nuxt layers under `layers/`:

- **`core`** — the collection/field model, the generic CRUD engine + REST API, def→JSON serialization,
  the runtime schema-migration engine, config resolution, and the populate registry.
- **`fields`** — turns a definition into Drizzle tables + Zod schemas (the field-type registry).
- **`ui`** — the admin design system: schema-driven field widgets, generic primitives, tokens, i18n.
- **`auth`** — single-user authentication (session cookie, scrypt password, login, CSRF).
- **`access`** — authorization: a default-deny guard over the entire `/api/` surface + policy/grant registry.
- **`collections`** — the toggleable built-in `pages` collection + the plugin that registers every
  discovered collection/block. (Demo content — `posts`/`settings`, the `hero`/`prose` blocks, and a layout —
  lives in the repo root, dev-only, and is **not** shipped in the package.)
- **`media`** — uploads, pluggable storage, image derivation, the media library + asset viewer.
- **`admin`** — the editor SPA: collection list, record editor, the 3-pane block editor.
- **`public`** — the SSG render path: the catch-all page, `KestrelBlockRenderer`, the JSON-LD head, the literal-key
  artifacts (sitemap / robots / llms.txt / llms-full.txt / redirects.json), deploy.

`playground/` is a small consuming example. `templates/starter/` is what the scaffolder writes out;
`scripts/kestrel.mjs` is the engine's CLI and `packages/create-kestrel/` the standalone
`pnpm create kestrel` front end, which copies the same templates in at pack time rather than keeping
its own.

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

In dev, the schema auto-syncs from the collection definitions (additive changes only); production applies
schema changes explicitly via the `db:migrate` task. See
[architecture-decisions.md](docs/architecture-decisions.md) for the rationale.

### Publishing the static site

Two ways to produce the static output:

- **One-shot:** `pnpm generate` → `.output/public` (the classic full rebuild).
- **Runtime publisher (default):** a **production** run (`pnpm build && pnpm preview`, or
  `node .output/server/index.mjs`) publishes on boot and incrementally re-publishes the affected pages when
  you press **Publish** in the editor, into `output.dir` (default `.data/published`). Saving is a DB write
  and leaves the live page alone (unpublishing and deleting still take a page down at once) — see
  [ADR-0008](docs/architecture-decisions.md), or set `output.publishOnSave: true` for the pre-2.0 behaviour
  where every save republished. Serve that dir with any static server, e.g. `npx serve .data/published`.

The runtime publisher is **intentionally disabled in `pnpm dev`** (a dev render would write un-hashed Vite
HTML), so the static files only appear on a production run. In dev you instead get the **live preview**:
public pages render straight from the running server, and an authenticated admin can open an unpublished
page at its real URL (the "open in new tab" button in the editor) — with unsaved changes that button
carries them along in a preview ticket rather than saving them. See
[static-output.md](docs/static-output.md) for the full picture.

### Simulate a production deploy locally

A real deployment is **two processes**: the private CMS server that *renders* the static files, and a
public static host that *serves* them. Rehearse that split on one machine:

```bash
# 1. Auth secrets live in .env (pnpm preview loads it). At minimum:
#      KESTREL_SESSION_SECRET=<≥32 bytes, e.g. `openssl rand -hex 32`>
#      KESTREL_ADMIN_PASSWORD_HASH=<from `pnpm hash-password <your-password>`>
#    Leave KESTREL_SECURE_COOKIES at its default — see the note below.

pnpm build
pnpm preview                 # built Nitro server, NODE_ENV=production → admin at http://localhost:3000/admin
                             #   boot-publish writes .data/published; editing in /admin re-publishes affected pages

# in a SECOND terminal — serve the generated site like a CDN would:
npx serve .data/published    # the public static site, exactly as it ships
```

`pnpm preview` runs the build under `NODE_ENV=production` and **loads `.env`** (running
`node .output/server/index.mjs` directly does **not** — export the vars yourself if you go that route).
Note the split: the **auth** vars below are read per request, so exporting them works either way, but the
non-auth `KESTREL_*` settings are baked in during `pnpm build` — in front of an already-built server they
are ignored, and you override them with Nuxt's runtime names instead (`NUXT_KESTREL_DB_PATH`,
`NUXT_KESTREL_SITE_URL`, …; see [configuration.md](docs/configuration.md)).
Production mode makes the auth guards strict, so for a working local login:

- `KESTREL_SESSION_SECRET` is **required and ≥32 bytes** (dev uses a random per-process secret); the
  check runs per-request, not at boot, so a deploy that forgets it still starts and binds the port —
  every `/api/*` request then answers **500** until the secret is set.
- `KESTREL_ADMIN_PASSWORD_HASH` must be set, or `POST /api/auth/login` answers **503** (“admin login is
  not configured”) rather than a wrong-password 401.
- **Keep `KESTREL_SECURE_COOKIES` at its default (`true`).** `=false` is *refused* in production
  (`KESTREL_SECURE_COOKIES=false is not allowed in production`); you don't need it — the session cookie is
  `Secure`/`__Host-`, and browsers accept those over plain `http://localhost`, so login works without HTTPS.

Watch the CMS terminal: boot prints `[kestrel] boot publish: N route(s) written, …`, and each save logs
the routes it re-rendered. Env reference → [configuration.md](docs/configuration.md); publishing internals
→ [static-output.md](docs/static-output.md).

## Configuration

Non-auth settings live in `kestrel.config.ts` (`satisfies KestrelConfig`); each setting follows
`KESTREL_* env → config → default`, resolved at build/dev start and frozen into `runtimeConfig` (a prebuilt
server is retuned with the `NUXT_*` runtimeConfig names, not `KESTREL_*`). Auth/session secrets are
**env-only** and read per request (`KESTREL_SESSION_SECRET`, `KESTREL_ADMIN_PASSWORD_HASH`, …). Full reference:
[configuration.md](docs/configuration.md).

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
