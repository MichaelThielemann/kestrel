# {{name}}

A [Kestrel](https://github.com/MichaelThielemann/kestrel) site — a collection-driven CMS that renders
published content to static HTML.

```bash
pnpm install
pnpm dev
```

Admin: <http://localhost:3000/admin> — sign in with the password you chose during `kestrel init`.
Forgot it? `pnpm hash-password` prints a fresh hash for `KESTREL_ADMIN_PASSWORD_HASH` in `.env`.

## What is here

| Path | What it does |
| --- | --- |
| `nuxt.config.ts` | Composes Kestrel (`extends`) and holds every non-secret setting under `kestrel: {}` |
| `.env` | Session secret + admin password hash. **Never commit it** — `.env.example` is the committed copy |
| `app/app.vue` | The app root. Keep `<NuxtLayout>` and `<NuxtPage />` or the admin stops rendering |
| `app/layouts/default.vue` | Your public site frame — header, nav, footer |
| `app/blocks/Prose.vue` | One block type for the page builder: schema and display in a single file |
| `.data/` | The SQLite database, uploads and published output. Gitignored |

## Add a collection

Drop a file in `server/collections/`; the table is created on the next dev start and the collection
shows up in the admin. Nothing to register.

```ts
// server/collections/posts.ts
export default defineCollection({
  name: 'posts',
  mode: 'multi',
  pageLike: true,          // gives records a `path` so they render to static HTML
  status: true,            // draft / published
  seo: true,
  blocks: { enabled: true },
  fields: { title: { type: 'text', required: true } },
})
```

## Publish

Run `pnpm dev` at least once first: the database schema is derived from your collections and created on
a dev boot, and a production build never touches it. Generating against a database that does not exist
yet succeeds but emits an empty site plus `no such table` errors.

There are two ways to get static files out, and this project has **both** enabled:

- **One-shot:** `pnpm generate` renders everything published into `.output/public/`.
- **Incremental (the default at runtime):** a production run (`pnpm build && pnpm preview`) publishes on
  boot and re-renders only the pages each content write affects, into `.data/published/`. Turn it off with
  `kestrel: { output: { auto: false } }` in `nuxt.config.ts` if you only want the one-shot flow.

Either way, serve the resulting directory from any static host. The editing origin is not meant to be
public. Set `siteUrl` in `nuxt.config.ts` to the real public origin first — it is baked into canonical
URLs, `sitemap.xml` and `llms.txt` at build time.

## Health check

`pnpm doctor` checks this project for the things that silently break a Kestrel site: a missing
`extends`, an `app.vue` that renders no pages, unset auth env.

Full documentation: <https://github.com/MichaelThielemann/kestrel#documentation>
