# Getting started

This page takes you from nothing to a running site with a working `/admin`, whether you start fresh or add Kestrel to an existing Nuxt project.

## Scaffold a new project

```bash
pnpm create kestrel my-site
cd my-site && pnpm install && pnpm dev
```

The scaffolder asks you once to choose an admin password, then writes a project that runs as-is. Sign in at `http://localhost:3000/admin`.

It **refuses** a directory that already holds project files — it will not merge into someone else's app. A `.git` directory or editor dotfiles don't count as occupying it, but a `.env`, `.env.example`, or `.gitignore` does. Use `kestrel init` (below) for that instead.

## What the scaffolder writes

| File | Why |
| --- | --- |
| `package.json` | `dev`/`build`/`generate` scripts, `@michaelthielemann/kestrel`, and `nuxt` as a direct devDependency — under a strict `node_modules` layout a transitive package's `nuxt` binary is not linked, so `pnpm dev` would not resolve |
| `pnpm-workspace.yaml` | `allowBuilds:` for `better-sqlite3`/`sharp`/`esbuild`/`@parcel/watcher`, so `pnpm install` builds them without you running `pnpm approve-builds`. Delete it if you use npm or yarn |
| `nuxt.config.ts` | The `extends` that loads Kestrel, plus the `kestrel: {}` keys worth setting first |
| `.env` | A fresh `KESTREL_SESSION_SECRET`, the scrypt hash of the password you entered, and `KESTREL_SECURE_COOKIES=false` as a scaffolder default. Gitignored; `.env.example` is the committed copy |
| `app/app.vue`, `app/layouts/default.vue` | The app root and your public frame — see "The app shell" below |
| `app/blocks/Prose.vue` | One block type, so the page builder is not empty on first run |
| `tsconfig.json`, `.gitignore` | Extends `.nuxt/tsconfig.json`; `noUncheckedIndexedAccess: false` is set in `nuxt.config.ts` instead, since it is not inherited from a layer. `.data`/`.env` must not be committed |

## Add to an existing project

```bash
pnpm add @michaelthielemann/kestrel
pnpm kestrel init      # completes the project
pnpm kestrel doctor    # or just diagnose one that misbehaves
```

`kestrel init` keeps every file that exists, merges `package.json` key-wise (your values win), and fills only the `.env` keys that are absent or empty. It is safe to re-run: it changes neither an existing session secret nor an existing admin hash. Both `pnpm create kestrel` and `kestrel init` end with a "Still to fix:" block for anything actually broken; `kestrel init` also prints an informational note about `output.publishOnSave` even on a healthy project. Both exit **non-zero** while the project still cannot serve `/admin`, so they are safe to chain in a script.

**Installing the package alone does nothing.** Nuxt only loads Kestrel once a config `extends` it — until then, every route including `/admin` serves the default Nuxt welcome page. This is the single most common "the admin is missing" report.

## The CLI

```bash
pnpm kestrel init            # scaffold into (or complete) the current project
pnpm kestrel doctor          # diagnose without changing anything
pnpm kestrel hash-password   # print a KESTREL_ADMIN_PASSWORD_HASH value
pnpm kestrel secret          # print a KESTREL_SESSION_SECRET value
```

`doctor`, `hash-password`, and `secret` take no flags. `init` accepts `--name`, `--password`, `--yes` (never prompt), and `--force` (overwrite existing files — `package.json` and `.env` are always merged, never replaced); `pnpm create kestrel` shares the same flags, but its `--force` means something else: it lets the scaffolder proceed in a non-empty directory instead. Rotating the password hash (`--password`) signs everyone out — the hash is folded into the cookie signing key.

## Wiring Nuxt by hand

Two files are all Kestrel needs. The `kestrel: {}` block below can stay inline in `nuxt.config.ts`, or be factored into a root `kestrel.config.ts` and imported — the scaffolder writes the latter; see [configuration.md](./configuration.md) for the full precedence rules.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: '2026-06-02',
  future: { compatibilityVersion: 4 },
  extends: ['@michaelthielemann/kestrel'],
  // Not inherited from an extended layer, so it has to be repeated here.
  typescript: { tsConfig: { compilerOptions: { noUncheckedIndexedAccess: false } } },
  nitro: { typescript: { tsConfig: { compilerOptions: { noUncheckedIndexedAccess: false } } } },
  kestrel: {
    db: '.data/db.sqlite',           // default shown; override to taste
    siteUrl: 'https://example.com',
    siteName: 'Example',             // og:site_name, the JSON-LD `WebSite` node, and the generated llms.txt
    locales: ['en', 'de'],
    media: { uploadDir: '.data/uploads' },
    // collections: { pages: false },  // drop a built-in to define your own with that name
  },
})
```

```bash
KESTREL_SESSION_SECRET=$(pnpm kestrel secret)
KESTREL_ADMIN_PASSWORD_HASH=$(pnpm kestrel hash-password)   # prompts hidden; also reads the password from stdin off a TTY
KESTREL_SECURE_COOKIES=false   # scaffolder default; not required for localhost, and production refuses it
```

Extend Kestrel by its **package name**, not by a relative path — a config that instead points at a nested directory two or more levels deep can silently fail to compose the layer, and the whole CMS vanishes with no route rendering. `extends: ['@michaelthielemann/kestrel']` is always correct; don't hand-roll the path.

Set the auth env above, start the app, and manage content at `/admin`. Full env reference: [configuration.md](./configuration.md).

## The app shell

Kestrel ships `app.vue`, `error.vue`, and a `default` layout — and a project-owned file of the same name shadows them. Two failure modes follow, both silent:

- **`app/app.vue` without `<NuxtPage />`** — nothing renders on any route, though the router still runs: the URL rewrites to `/admin/login?redirect=/admin`. This is exactly what a bare `nuxi init` writes. That redirect is what tells this apart from a missing `extends`, which shows the Nuxt welcome screen instead — see [troubleshooting.md](./troubleshooting.md).
- **`<NuxtPage />` without `<NuxtLayout>`** — pages render, but the admin loses its entire navigation shell.

So either delete `app/app.vue` and let Kestrel's own take over, or write it as:

```vue
<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
```

Kestrel checks this at build time and prints the fix; `kestrel doctor` reports it without a build. The same shadowing applies to `app/error.vue` and `app/layouts/default.vue` — overriding those is normal and expected, it is only `app.vue` that is load-bearing.

## Your first collection

Drop a file in `server/collections/` and default-export `defineCollection(...)`, imported from `@michaelthielemann/kestrel-core`:

```ts
// server/collections/products.ts
import { defineCollection } from '@michaelthielemann/kestrel-core'

export default defineCollection({
  name: 'products',
  mode: 'multi',
  fields: {
    title: { type: 'text', required: true },
    price: { type: 'number' },
    image: { type: 'media' },
  },
})
```

On the next dev start the collection is discovered, its table is created, and it appears in the admin with a full CRUD API — `GET /api/products/readMany`, `POST /api/products/createOne`, and so on. Every option a field type accepts is in [field-types.md](./field-types.md).

## Your first block

A block is one Vue SFC under `app/blocks/`; the filename names the block type, and `defineProps` is its schema:

```vue
<!-- app/blocks/Prose.vue -->
<script setup lang="ts">
defineProps({
  body: richtextField({ required: true }),
})
defineBlock({ label: { en: 'Prose' }, icon: 'file-text' })
</script>

<template>
  <div class="block-prose" v-html="body" />
</template>
```

Give a collection `blocks: { enabled: true }` and its editor gains the 3-pane block builder — `pageLike: true` is a separate flag, for making its records routable. The full block model — nesting, slots, the editor panes — is in [blocks.md](./blocks.md).

## Run the dev server

```bash
pnpm dev            # dev server, admin at /admin
pnpm build          # production build
pnpm generate       # seed static public routes (only with output: { auto: false })
```

In dev, the schema auto-syncs from your collection definitions (additive changes only); a production deploy applies schema changes through the `db:migrate` task — see [schema-lifecycle.md](./schema-lifecycle.md). On the default `output.auto: true`, the running server publishes pages itself rather than `nuxt generate` prerendering them; with `output.auto: false`, `pnpm generate` writes the whole pre-rendered site at build time instead. Both models, and where each one's output is shipped, are in [deploying.md](./deploying.md). Either way the pages are served as static files — that is the default *delivery* mode, and the alternative, `delivery: 'live'`, serves public pages from the running server instead; both are covered in [publishing.md](./publishing.md).

## See also

- [configuration.md](./configuration.md) — every `KESTREL_*`/`NUXT_*` env var and the config precedence rules
- [collections.md](./collections.md) — the full collection model beyond this page's minimal example
- [field-types.md](./field-types.md) — every built-in field type and its options
- [publishing.md](./publishing.md) — how save, publish and preview differ, and the static/live delivery modes
- [deploying.md](./deploying.md) — building, publishing, and running Kestrel in production
- [schema-lifecycle.md](./schema-lifecycle.md) — how schema changes reach dev and production databases
- [troubleshooting.md](./troubleshooting.md) — symptom-to-fix entries for the setup footguns this page warns about
