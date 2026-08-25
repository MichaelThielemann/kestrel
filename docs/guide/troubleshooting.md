# Troubleshooting

Symptom-to-fix entries for the footguns that come up most often when wiring a project to Kestrel.

## Setup

### `/admin` shows the Nuxt welcome page or 404s after `pnpm add`

**Cause:** installing the package alone does nothing — Nuxt only loads Kestrel once a config extends it. Without an extending `nuxt.config.ts`, every route, `/admin` included, serves the default Nuxt welcome page; on a project that already has a working config and app shell, a different misconfiguration can instead 404 there. The next entry's shadowed-`app.vue` case looks the same at a glance, but its URL rewrites to `/admin/login?redirect=/admin` — that redirect is the distinguishing signal, not the welcome page.
**Fix:** run `pnpm kestrel init` to wire up an existing project, or extend it by hand:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  extends: ['@michaelthielemann/kestrel'],
})
```

See [Getting started](./getting-started.md).

### `/admin` loads but sign-in answers 503

**Cause:** `KESTREL_ADMIN_PASSWORD_HASH` is unset, so the admin renders but every login attempt is refused before checking credentials.
**Fix:**

```bash
pnpm kestrel hash-password
```

Put the resulting value in `.env` as `KESTREL_ADMIN_PASSWORD_HASH`. See [Configuration](./configuration.md).

### `nuxt dev` doesn't resolve after `pnpm add`

**Cause:** Kestrel depends on `nuxt`, but a strict `node_modules` layout (pnpm) does not link a transitive package's `nuxt` binary — if the project itself never listed `nuxt` as a direct dependency, `nuxt dev` has nothing to resolve.
**Fix:**

```bash
pnpm add -D nuxt
```

### `/admin` shows the Nuxt welcome screen even though the config extends Kestrel

**Cause:** a project-owned `app/app.vue` shadows the one Kestrel ships, and `nuxi init` writes one without `<NuxtPage />` — nothing renders on any route, though the router still runs (the URL rewrites to `/admin/login?redirect=/admin`), which reads as a missing route rather than a missing shell.
**Fix:** delete `app/app.vue` to let Kestrel's layer take over, or make it render both wrappers. Kestrel checks this at build time and prints the fix; `pnpm kestrel doctor` reports it without a build. See [Getting started § The app shell](./getting-started.md#the-app-shell).

### `/admin` renders but has no navigation shell

**Cause:** `app/app.vue` has `<NuxtPage />` without a wrapping `<NuxtLayout>`, so `definePageMeta({ layout })` is ignored.
**Fix:** wrap it — the same file fixes both this and the missing-welcome-screen case above:

```vue
<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
```

The same shadowing applies to `app/error.vue` and `app/layouts/default.vue` — overriding those is normal; only `app.vue` is load-bearing. See [Getting started](./getting-started.md) § The app shell.

### A component under `app/components/` doesn't override the admin UI

**Cause:** every component Kestrel ships is registered under a `Kestrel` prefix (`KestrelUiButton`, `KestrelFieldText`, …), a separate namespace from your own `app/components/`. A file at, say, `app/components/kestrel/UiButton.vue` never collides with it — Kestrel's own registration always wins there.
**Fix:** put the replacement at `app/Kestrel/components/…`, mirroring the path it has inside Kestrel (`app/Kestrel/components/ui/Button.vue` replaces `KestrelUiButton`). Prefer a registry when one exists — `registerFieldComponent`, `registerCollectionEditor`, `defineFieldType` — before reaching for a full override. See [How Kestrel works § Admin app vs. your public app](./concepts.md#admin-app-vs-your-public-app-and-the-component-namespace) and [Custom field types](./custom-field-types.md).

## Environment and config

### Settings changed in the environment don't take effect on a running server

**Cause:** `KESTREL_*` vars are resolved once, at build time, and frozen into `runtimeConfig` — a prebuilt server (`node .output/server/index.mjs`) never re-reads them. The failure is silent because login still works (auth vars are read per request), so the admin looks healthy while writes land in the wrong database.
**Fix:** set it in the environment that builds the app, or use the `NUXT_*` name on the prebuilt server instead. See [Configuration](./configuration.md) § When the environment is read — build time, not request time.

### Uploads fail with `500 … S3 media driver is not configured` naming vars you already set

**Cause:** the same build-time freeze as above — a prebuilt server's storage driver sees the baked-in empty `bucket`/`publicBaseUrl`/credential strings even though `KESTREL_S3_*` is set in the environment that starts it, not the one that built it.
**Fix:** set `NUXT_MEDIA_S3_BUCKET`, `NUXT_MEDIA_S3_PUBLIC_BASE_URL`, `NUXT_MEDIA_S3_ACCESS_KEY_ID` and `NUXT_MEDIA_S3_SECRET_ACCESS_KEY` (Nuxt's runtimeConfig env names) on the prebuilt server instead, or rebuild with `KESTREL_S3_*` present.

## Media

### Every image returns 403 after switching to S3

**Cause:** Kestrel never sets a per-object ACL, so `publicUrl()` points at objects the bucket doesn't actually serve publicly yet.
**Fix:** expose the bucket at the bucket/CDN level and set `publicBaseUrl` to match. See [Media](./media.md) § Exposing the bucket for the policy and the CloudFront/R2 alternatives.

### Upload rejected with `415 Unsupported media type`

**Cause:** the upload's detected MIME isn't in the configured allow-list.
**Fix:** see [Media](./media.md) § Configuring the allow-list and size limit.

## Saving and publishing

### A save fails with `409 Conflict`

**Cause:** several distinct causes all map to 409:

- an optimistic-concurrency check — an `updateOne` sent `X-Kestrel-If-Unmodified-Since` and the record changed since that timestamp;
- a resolved-route collision — the localized path a page slug resolves to is unique across **every** pageLike collection, not just within one, so a bare `/about` can't exist in both `pages` and another pageLike collection like `guides`;
- a UNIQUE-constraint violation on any other `unique` field, or a duplicate locale within a translation group or singleton;
- a duplicate filename on media upload.

**Fix:** for the concurrency case, reload the record and reapply the edit; the header exists precisely so a stale editor tab can't silently overwrite a newer save. Send it as epoch milliseconds, not the raw `Date`:

```ts
await $fetch(`/api/pages/updateOne/${id}`, {
  method: 'POST',
  headers: { 'X-Kestrel-If-Unmodified-Since': String(new Date(record.updatedAt).getTime()) },
  body: patch,
})
```

For a slug or route collision, pick a different explicit slug — an auto-generated one is de-duped instead of rejected; see [Collections](./collections.md) § Slug rules. For any other field, pick a value that isn't already taken. See [Querying](./querying.md) § Optimistic concurrency for the concurrency case.

### A new block field doesn't show up in the editor

**Cause:** editing a block's `defineProps` schema, or adding a new `app/blocks/*.vue` file, isn't picked up by dev HMR. See [Blocks](./blocks.md) § Dev HMR caveat.
**Fix:** restart the dev server after a block schema change:

```bash
pnpm dev   # restart after editing defineProps on an existing block, or adding a new one
```

### `nuxt generate` produces no page files, or the S3 deploy ships nothing

**Cause:** `output.auto` defaults to `true` — the build-time route-seeding and S3 deploy steps both assume the build-time model (`output.auto: false`) and skip themselves when it's on, since the running server owns publishing instead.
**Fix:** set `output.auto: false` (or `KESTREL_OUTPUT_AUTO=false`) to use the build-time model. See [Publishing](./publishing.md).

The next two entries also assume `output.auto: false`.

### `nuxt generate` errors on one route instead of producing a page

**Cause:** the route's page lookup couldn't *complete* — an unmigrated or drifted table means "no page here" is unknowable rather than true — so the prerender of that route errors instead of rendering. `prerender.failOnError` is off by design, so the generate still exits 0.
**Fix:** check the prerender log, not the exit code. Nothing destructive follows: the deploy step counts a failed route as an incomplete run and suppresses the S3 prune, so the live page survives. See [Deploying](./deploying.md).

### A draft record produces no HTML file

**Cause:** only published records are seeded as prerender routes — an unpublished draft was never a candidate, by design.
**Fix:** publish the record, or check its status in the admin if you expected it to be live. See [Publishing](./publishing.md).

## Diagnostics

### Something is misconfigured and the symptom doesn't match any entry above

**Fix:** run `pnpm kestrel doctor` before digging further — without requiring a build, it checks `package.json` validity, that `@michaelthielemann/kestrel` and `nuxt` are direct dependencies, a `dev` script, that `nuxt.config.ts` extends Kestrel, that `app/app.vue` renders `<NuxtPage />` and `<NuxtLayout>`, and that `.env` sets `KESTREL_ADMIN_PASSWORD_HASH` and `KESTREL_SESSION_SECRET`:

```bash
pnpm kestrel doctor
```

It is also the command to reach for after any of the fixes above, to confirm nothing else is left misconfigured.

## See also

- [Getting started](./getting-started.md)
- [Configuration](./configuration.md)
- [Concepts](./concepts.md)
- [Custom field types](./custom-field-types.md)
- [Media](./media.md)
- [Collections](./collections.md)
- [Querying](./querying.md)
- [Blocks](./blocks.md)
- [Publishing](./publishing.md)
