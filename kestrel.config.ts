import type { KestrelConfig } from '@kestrel/core'

/**
 * Central Kestrel configuration (everything except auth/session, which stays env-only because secrets
 * don't belong in committed config). This one file is the single source: it flows into `nuxt.config`'s
 * `kestrel: { … }`, into `drizzle.config` (so `drizzle-kit` uses the same DB), and into the server at
 * runtime. Precedence per setting: the matching `KESTREL_*` env var → a value here → a built-in default.
 *
 * This instance's non-auth config lives here (not in `.env`) so `nuxt.config`, `drizzle-kit` and the
 * runtime server all derive the SAME values from one place — in particular the same SQLite file, so
 * `pnpm dev`, `pnpm build` and a migration never drift onto different DBs (they set no `KESTREL_*`, so
 * this file wins). `.env` keeps only the auth/session secrets. An explicit `KESTREL_*` env var OVERRIDES
 * this file — the escape-hatch for a per-environment value or an isolated test (the e2e suite sets
 * `KESTREL_DB` / `KESTREL_MEDIA_LOCAL_DIR` / `KESTREL_SITE_URL` per run). The static-publish `output`
 * target is left to its defaults (local `.data/published`, auto-publish on).
 */
export default {
  db: '.data/dev.sqlite',
  siteUrl: 'http://localhost:3000',
  locales: ['en', 'de'],
  primaryLocale: 'en',
  media: {
    driver: 'local',
    uploadDir: '.data/uploads',
    baseUrl: '/uploads',
    maxBytes: 26214400, // 25 MiB
  },
} satisfies KestrelConfig
