# Configuration

All **non-auth** configuration lives in one place: **`kestrel.config.ts`** (repo root). It is plain TS
(no Nuxt globals), so the *same* values are consumed by:

- **`nuxt.config`** → its `kestrel: { … }` key (resolved by the `kestrel` module in the `core` layer),
- **`drizzle.config`** → so `drizzle-kit` migrates the DB the app uses,
- the **server at runtime** (db / locale / site-url utils).

```ts
// kestrel.config.ts
import type { KestrelConfig } from './layers/core/server/utils/kestrel-config'

export default {
  db: 'storage/app.sqlite',           // relative → resolved against the project root; ':memory:' allowed
  siteUrl: 'https://example.com',     // sitemap <loc> + robots Sitemap:
  siteName: 'Example',                // human name for the generated llms.txt (falls back to the siteUrl host)
  siteDescription: 'What this site is about.', // one-line summary in llms.txt
  locales: ['en', 'de'],              // website/content locales
  primaryLocale: 'en',
  prefixPrimaryLocale: false,         // true → prefix the primary locale too (/en/about); root → /<primary>
  media: {
    uploadDir: 'storage/uploads',     // written to AND served at /uploads (single dir, can't drift)
    baseUrl: '/uploads',
    driver: 'local',                  // 'local' | 's3'
    maxBytes: 50 * 1024 * 1024,
    allowedMimes: '',                 // '' = the built-in allow-list
    s3: {                             // used only when driver: 's3' (secrets are env-only — see below)
      bucket: 'my-bucket',
      region: 'eu-central-1',         // default 'us-east-1'; use 'auto' for Cloudflare R2
      endpoint: '',                   // S3-compatible origin (R2/MinIO); omit for AWS S3
      prefix: 'media',                // key prefix prepended to every object
      publicBaseUrl: 'https://cdn.example.com',  // where publicUrl() points (CDN / bucket origin)
    },
    image: {                          // responsive-image derivation (usage-driven; see media-uploads.md)
      widths: [320, 640, 960, 1280, 1920], // legacy proportional ladder → `w<width>` webp presets
      webpQuality: 78,
      jpegQuality: 80,
      variants: [                     // named presets referenced by <KestrelImg :preset> (config-only, no env)
        { name: 'thumb', width: 320, height: 320, fit: 'cover', formats: ['webp', 'jpeg'] },
      ],
    },
  },
  output: {                           // where the published static site is written (separate from media)
    driver: 'local',                  // 'local' | 's3' (S3 credentials are env-only — see below)
    dir: '.data/published',           // local dir for the published HTML + synced _nuxt (relative → root)
    publicDir: '.output/public',      // source of the built client bundle the publisher mirrors in
    auto: true,                       // run the publisher in-process (publishing is an explicit action)
    publishOnSave: false,             // true → every save republishes again (pre-2.0 model, no Publish button)
    reconcileMinutes: 0,              // >0 → full re-publish every N min (self-heals a missed invalidation)
    verbose: false,                   // per-route render/prune log lines on each republish
    s3: {                             // used only when driver: 's3'
      bucket: 'my-site',
      region: 'eu-central-1',
      endpoint: '',                   // S3-compatible origin (R2/MinIO); omit for AWS S3
      prefix: '',                     // key prefix prepended to every object
    },
  },
  collections: {                      // built-in collections (default on); set false to define your own
    pages: true,
    media: true,
  },
  preview: {                          // admin page-builder live preview
    desktopWidth: 1440,               // reference width (px) the Desktop preset renders at (scale-to-fit shrinks it)
  },
} satisfies KestrelConfig
```

## Precedence

Per setting: **matching `KESTREL_*` env var → `kestrel.config` value → built-in default.** The committed
config is the normal source of truth; an explicit `KESTREL_*` env var **overrides** it — the escape-hatch
for a per-environment value or an isolated test, as long as it is set for the *build* (see
[When the environment is read](#when-the-environment-is-read--build-time-not-request-time) below; the e2e
suite sets `KESTREL_DB` / `KESTREL_MEDIA_LOCAL_DIR`
/ `KESTREL_SITE_URL` per run). `dev`, `build` and `drizzle-kit` set no `KESTREL_*`, so the config wins and
they never drift onto different DBs/paths. (Auth/session settings are the exception — they are env-**only**;
they are never read from this file.)

The mapping (env overrides): `db`→`KESTREL_DB`, `siteUrl`→`KESTREL_SITE_URL`, `siteName`→`KESTREL_SITE_NAME`, `siteDescription`→`KESTREL_SITE_DESCRIPTION`, `collections.pages`→`KESTREL_COLLECTIONS_PAGES`, `collections.media`→`KESTREL_COLLECTIONS_MEDIA`, `locales`→`KESTREL_LOCALES`,
`primaryLocale`→`KESTREL_PRIMARY_LOCALE`, `prefixPrimaryLocale`→`KESTREL_PREFIX_PRIMARY_LOCALE`, `media.uploadDir`→`KESTREL_MEDIA_LOCAL_DIR`,
`media.baseUrl`→`KESTREL_MEDIA_BASE_URL`, `media.driver`→`KESTREL_MEDIA_DRIVER`,
`media.maxBytes`→`KESTREL_MEDIA_MAX_BYTES`, `media.allowedMimes`→`KESTREL_MEDIA_ALLOWED_MIME`,
`media.s3.bucket`→`KESTREL_S3_BUCKET`, `media.s3.region`→`KESTREL_S3_REGION`,
`media.s3.endpoint`→`KESTREL_S3_ENDPOINT`, `media.s3.prefix`→`KESTREL_S3_PREFIX`,
`media.s3.publicBaseUrl`→`KESTREL_S3_PUBLIC_BASE_URL`,
`media.image.widths`→`KESTREL_MEDIA_IMAGE_WIDTHS` (csv), `media.image.webpQuality`→`KESTREL_MEDIA_IMAGE_WEBP_QUALITY`,
`media.image.jpegQuality`→`KESTREL_MEDIA_IMAGE_JPEG_QUALITY` (`media.image.variants` is **config-only** — no env override),
`output.driver`→`KESTREL_OUTPUT_DRIVER`, `output.dir`→`KESTREL_OUTPUT_DIR`,
`output.publicDir`→`KESTREL_OUTPUT_PUBLIC_DIR`, `output.auto`→`KESTREL_OUTPUT_AUTO`,
`output.publishOnSave`→`KESTREL_OUTPUT_PUBLISH_ON_SAVE`,
`output.reconcileMinutes`→`KESTREL_OUTPUT_RECONCILE_MINUTES`, `output.verbose`→`KESTREL_OUTPUT_VERBOSE`,
`output.s3.{bucket,region,endpoint,prefix}`→`KESTREL_OUTPUT_S3_{BUCKET,REGION,ENDPOINT,PREFIX}`,
`preview.desktopWidth`→`KESTREL_PREVIEW_DESKTOP_WIDTH`.

One env var has no config key because it is a build-time switch rather than a setting:
`KESTREL_OUTPUT_DRY_RUN` (`1` / `true` / `yes` / `on`) makes `nuxt generate` *report* what it would do
instead of doing it — the S3 output deploy logs the upload and the reconcile deletes without touching the
bucket, and the media prune logs the baked files it would remove without deleting them. See
[static-output.md](./static-output.md#output-target-local-directory-or-s3).

Resolution is the pure `resolveKestrel()` (`layers/core/server/utils/kestrel-config.ts`), used by every
consumer so they can't disagree. `drizzle-kit` honours `kestrel.db` because `drizzle.config` imports the
same file — no separate env needed for migrations.

### When the environment is read — build time, not request time

The `kestrel` module resolves all of the above **once, at Nuxt-module setup** (`dev` start, `nuxt build`,
`nuxt generate`) and freezes the result into `runtimeConfig`. Server utils read runtimeConfig, never
`process.env`. So a `KESTREL_*` var must be present in the environment that **builds** the app; setting one
in front of an already-built server does nothing:

```
KESTREL_DB=/var/lib/kestrel/prod.sqlite node .output/server/index.mjs   # ← ignored
```

and it fails *silently*: the server opens the build-time path (creating it empty if absent) while login —
auth is env-only and read per request — still works, so the admin looks healthy while every write lands in
the wrong database. The same holds for media/output S3 credentials: `useStorageDriver()` sees the baked
empty strings and answers **500** naming the very `KESTREL_S3_*` variables you just exported.

To change a non-auth setting on a **prebuilt** artifact, use Nuxt's own runtimeConfig env names, which
Nitro applies at server start — `NUXT_` + the runtimeConfig key path in SCREAMING_SNAKE:

| setting | build environment | prebuilt server (`node .output/server/index.mjs`) |
| --- | --- | --- |
| database | `KESTREL_DB` | `NUXT_KESTREL_DB_PATH` (resolved path — no project-root fallback) |
| site URL | `KESTREL_SITE_URL` | `NUXT_KESTREL_SITE_URL` **and** `NUXT_PUBLIC_SITE_URL` (client head) |
| local upload dir | `KESTREL_MEDIA_LOCAL_DIR` | `NUXT_MEDIA_LOCAL_DIR` |
| media S3 credentials | `KESTREL_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | `NUXT_MEDIA_S3_ACCESS_KEY_ID` / `NUXT_MEDIA_S3_SECRET_ACCESS_KEY` |
| output target | `KESTREL_OUTPUT_DIR` / `_DRIVER` | `NUXT_KESTREL_OUTPUT_DIR` / `NUXT_KESTREL_OUTPUT_DRIVER` |
| output S3 credentials | `KESTREL_OUTPUT_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | `NUXT_KESTREL_OUTPUT_S3_ACCESS_KEY_ID` / `NUXT_KESTREL_OUTPUT_S3_SECRET_ACCESS_KEY` |

Every other resolved value follows the same rule (`runtimeConfig.media.local.dir` → `NUXT_MEDIA_LOCAL_DIR`).
Note the two spellings differ on purpose: `KESTREL_*` names the *config* key, `NUXT_*` names the
*runtimeConfig* key the module wrote it to. `nuxt generate` output has no server at all, so there only the
build environment exists. Auth/session vars are the exception to all of this — they are read from
`process.env` per request and work as-is on a prebuilt server.

## Auth / session — env-only (by design)

Secrets don't belong in committed config, so these stay environment variables:

- `KESTREL_SESSION_SECRET` — HMAC signing secret (prod: required, ≥32 bytes; dev: random per process).
- `KESTREL_ADMIN_PASSWORD_HASH` — scrypt hash of the single admin password (also folded into the key).
  When unset, `POST /api/auth/login` answers **503** ("admin login is not configured") rather than a
  misleading 401, so a forgotten hash is diagnosable.
- `KESTREL_DEV` — `=1` is an explicit **dev** signal. The auth/session safeguards treat anything that
  isn't an explicit dev signal (`NODE_ENV=development`/`test`, or this) as **production** — so a deploy
  that merely omits `NODE_ENV` stays hardened (secret required, Secure cookies) rather than silently
  downgrading to dev. Set this ONLY for a non-production run that lacks `NODE_ENV`; never in production.
- `KESTREL_SECURE_COOKIES` — `=false` only permitted outside production (local http dev).
- `KESTREL_SESSION_MAX_AGE` — session **idle window** in seconds (default 604800). Activity slides the
  expiry forward; after this long with no authenticated request the admin is logged out and must sign in
  again. Lowering it applies to newly issued or refreshed sessions only — it does **not** shorten a
  session already outstanding, since its expiry was baked in at issue time. To invalidate every live
  session immediately regardless of this setting, use `POST /api/auth/logout` (bumps the revocation
  epoch below).
- `KESTREL_SESSION_EPOCH_FILE` — path to the session-revocation epoch file (default: `.kestrel-session-epoch`
  next to the DB). Logout bumps this counter (folded into the signing key) so every outstanding token is
  invalidated server-side immediately; it must live on persistent storage to survive a restart.
- `KESTREL_TRUST_PROXY` — trusted reverse-proxy depth for deriving the client IP. Shared by the
  login-throttle **and** the IP allow-list below (both call the same `clientIp()`). Default off → the
  socket peer is used and `X-Forwarded-For` is ignored (it is attacker-spoofable without a proxy). Set
  `true`/`1` for a single trusted proxy, or an integer N for N chained proxies; the Nth-from-right XFF
  hop is then trusted. Enable this only when a proxy actually fronts the app.

Generate a password hash with `node scripts/hash-password.mjs <password>`.

## IP allow-list — optional

A stage-level gate (`layers/access/server/middleware/00.ip-allowlist.ts`) that covers every route this app
defines — admin UI, public preview, and API — not just `/api/*`. Off by default; typically used to lock a
non-public DEV/EDIT stage down to an office/VPN range.

It does **not** cover the assets Nitro serves ahead of the middleware stack: `/_nuxt/**`, and `/uploads`
when `media.driver: 'local'`. Nitro unshifts its own static handler in front of every middleware, so those
bytes are returned to any IP. If a stage holds non-public media, enforce the allow-list at the reverse
proxy (or serve media from a private S3 bucket) instead of relying on this gate alone.

- `KESTREL_IP_ALLOWLIST` — the allow-list, IPv4/CIDR only (`1.2.3.4`, `10.0.0.0/8`). Newline/comma/
  semicolon separated; `# comments` and a leading `allow`/`set_real_ip_from` keyword are stripped, so an
  nginx `allow` block can be pasted in verbatim. Invalid tokens are dropped rather than failing the
  whole list. **IPv6 client addresses always fail closed** (never match, never pass) — there is no IPv6
  CIDR support. Unset or blank ⇒ the gate is `off` regardless of the mode below.
- `KESTREL_IP_ALLOWLIST_MODE` — `enforce` (default the moment a list is set), `log` (never blocks; logs
  what *would* be blocked, to calibrate `KESTREL_TRUST_PROXY` before enforcing), or `off`.

Set `KESTREL_TRUST_PROXY` above whenever a reverse proxy fronts the app — without it the gate sees the
proxy's own address for every client.

## S3 credentials — env-only (by design)

Like the auth secrets, the S3 access keys never live in committed config:

- `KESTREL_S3_ACCESS_KEY_ID` — access key id.
- `KESTREL_S3_SECRET_ACCESS_KEY` — secret access key.
- `KESTREL_S3_SESSION_TOKEN` — optional, for temporary (STS) credentials.

Unlike the auth secrets they are **not** read per request: the `kestrel` module reads them at module setup
(build/dev start), unconditionally — whatever `media.driver` is — and copies them into
`runtimeConfig.media.s3`, which is what the driver later reads. Two consequences:

- They must be in the **build** environment, and they then sit in the build artifact. Keep them out of a
  shared/CI-published `.output/` by leaving them unset at build time and supplying
  `NUXT_MEDIA_S3_ACCESS_KEY_ID` / `NUXT_MEDIA_S3_SECRET_ACCESS_KEY` (`_SESSION_TOKEN`) to the server
  process instead — see [When the environment is read](#when-the-environment-is-read--build-time-not-request-time).
- Exporting `KESTREL_S3_*` in front of a prebuilt server does **not** configure it: media operations
  answer 500 ("S3 media driver is not configured") naming those same variables.

The **non-secret** S3 settings (`bucket` / `region` / `endpoint` / `prefix` / `publicBaseUrl`) follow
the normal `KESTREL_S3_* → config → default` precedence above. See
[media-uploads.md](./media-uploads.md#storage-drivers) for the full driver walk-through.

The **static-output** bucket (`output.driver: 's3'`) reads its S3 credentials from the environment too.
Both publish paths — the **runtime incremental publisher** (the live server re-rendering pages on writes)
and the build-time **`nuxt generate` → S3 deploy** — read an output-specific trio and fall back to the
shared media keys when unset, so a single S3 account "just works":
`KESTREL_OUTPUT_S3_ACCESS_KEY_ID` → `KESTREL_S3_ACCESS_KEY_ID`, `KESTREL_OUTPUT_S3_SECRET_ACCESS_KEY` →
`KESTREL_S3_SECRET_ACCESS_KEY`, `KESTREL_OUTPUT_S3_SESSION_TOKEN` → `KESTREL_S3_SESSION_TOKEN`. The
`generate` deploy runs inside the build, so the build environment is the only one it can read; the runtime
publisher takes the values the build froze, so on a prebuilt server override them with
`NUXT_KESTREL_OUTPUT_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_SESSION_TOKEN`.

So to point uploads and the published site at *different* accounts, set the `KESTREL_OUTPUT_S3_*` trio. See
[static-output.md](./static-output.md#output-target-local-directory-or-s3) for the deploy walk-through.

## State & backups

All mutable state lives under two paths (both gitignored), not in the code or the build artifact:

- **The database** — `db` / `KESTREL_DB` (default `.data/db.sqlite`). It runs in **WAL mode**, so recent
  writes can sit in the `-wal` / `-shm` sidecars: a raw `cp db.sqlite` may capture a torn, inconsistent
  snapshot. Back it up with a consistent method instead — `sqlite3 db.sqlite ".backup backup.sqlite"` (or
  `VACUUM INTO`), or stop the server first and copy all three files together.
- **Uploads** — `media.uploadDir` / `KESTREL_MEDIA_LOCAL_DIR` (default `.data/uploads`) for the local
  driver; on the `s3` driver they live in the bucket instead. Back these up alongside the DB so media
  references stay resolvable.
- **The session-revocation epoch** — `KESTREL_SESSION_EPOCH_FILE` (default `.kestrel-session-epoch` next
  to the DB). Include it in a backup/restore set: restoring an OLDER epoch alongside the DB would
  **resurrect sessions you had revoked** (logout bumps this counter). Restoring it forward is harmless
  (it only ever revokes more).

Restore is the inverse: replace the DB file (server stopped), the uploads dir/bucket, and the epoch file.
There is no backup CLI — this is deliberately left to standard OS / cloud tooling.
