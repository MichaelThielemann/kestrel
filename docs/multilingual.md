# Multilingual content

Per-record **content** translations — the languages the published *website* exists in. This is distinct
from the **admin-UI chrome language** (the interface strings), which is independently switchable (en/de)
and cookie-backed — see *Admin-UI language* below.

## Configured locales

Website locales come from **`KESTREL_LOCALES`** (comma-separated, e.g. `en,de`; default `en,de`) and an
optional **`KESTREL_PRIMARY_LOCALE`** (default: the first locale). `core/server/utils/locale.ts` parses
them for the server (validation, per-locale SSG routing); the `kestrel` Nuxt module (registered by
`nuxt.config`) mirrors the same resolved values into `runtimeConfig.public` so the admin reads the
identical set via `useContentLocales()`.

## URL scheme — locale prefixes

Every non-primary locale is prefixed `/<locale>/…`; the **primary** locale is **unprefixed** by default
(`/about`, with `/de/about` for German). One pure function — `localePath` — is the single source of the
scheme (prerender, sitemap, links, the catch-all resolver, the slug-uniqueness check, the SEO preview),
and its inverse `resolvePublicRoute` parses a URL back to `(locale, path)`; the two always agree.

Set **`prefixPrimaryLocale: true`** (or `KESTREL_PREFIX_PRIMARY_LOCALE=1`) to prefix the primary locale
too — every page then lives under `/<locale>/…` (`/en/about`, `/de/about`), and the site root is
`/<primary>`. The bare `/` then has no page of its own: **redirect `/` → `/<primary>` at the edge** (NGINX
/ S3 / CDN — Kestrel does no runtime redirects). Turning the flag on changes every public URL; the
always-on prune republishes the site to the new paths and removes the old ones. The flag is env →
config → default **false**, so existing sites are unaffected until they opt in.

## Data model (backend, pre-existing)

A collection opts in with `translatable: true`.

- **`multi`** (e.g. `pages`, `posts`): each locale is a **separate row**, grouped by a `translation_group`
  (nanoid). Unique on `(translationGroup, locale)`; for page-like, the slug is unique on the **resolved
  route** — globally across all pageLike collections, per locale — so `/about` and the prefixed `/de/about`
  coexist but two collections can't both claim `/about` (see [reference-integrity.md](./reference-integrity.md)
  › Slug integrity; the per-table `(path, locale)` index is a within-collection backstop).
- **`single`** (e.g. `settings`): one singleton per locale, keyed `(singletonKey, locale)`; `PUT ?locale=`
  upserts.
- `GET /api/<col>/<id>/translations` → `{ en: 5, de: null }` (which locales a group has).

## Editor — the LocaleBar

`CollectionEditor` shows a **`LocaleBar`** for translatable collections (`useEditForm` resolves the active
locale: from `?locale` for a singleton / new translation, from the loaded row for an existing `multi`):

- **active** locale → a label.
- existing sibling → **pen** (edit: navigates to that locale's record / `?locale`) + **copy** (pulls that
  locale's field + block values into the current form via `useEditForm.applyFrom`).
- missing locale → **"+"** (create) → `/admin/<col>/new?locale=<loc>&group=<group>`; saving POSTs the
  `locale` + `translationGroup` to link the sibling.

The editor pages thread `?locale` / `?group` from the URL; the page `key` is the full path, so switching
locale remounts the editor cleanly.

## List — filtered by locale

For a translatable collection the collection list filters to the browsing locale (`?locale`, default
primary) and shows a small **locale switcher**; the *New* link carries the locale so a new record opens
in it.

Each list row also carries a server-computed **`$translations`** sidecar — `{ en: 5, de: null }`, the same
shape as `GET /api/<col>/<id>/translations` (locale → sibling row id, or `null` when that locale is
missing). It is built for the whole page in **one** batched query (`list()` →
`attachTranslationStatus`, `inArray(translationGroup, …)`), so it does not reintroduce a per-row N+1.
The `$`-prefix marks it a sidecar (like media's `$media`), so it never collides with a user field; it is
attached only for `multi` + `translatable` collections, and the sibling lookup honours `publishedOnly`
(a published-scope read never reveals draft translations).

## Per-row translation status

The collection list draws a per-record **translation badge** from the `$translations` sidecar (a
`translations` column type, "EN ✓ · DE —" per record): present locales link to their sibling, missing
ones offer create-and-link carrying the translation group (`CollectionList.vue`).

## Admin-UI language

The interface **chrome** is fully translated (en/de) and switchable independently of the content
locales. `useAdminLang()` is a cookie-backed (`kestrel-admin-lang`), SSR-safe preference read by
`useT()`; the switcher lives in the rail account menu (`AdminAccount.vue`), and the string catalogs are
the `ui` layer's `app/i18n/{en,de}.ts`. Chrome language ≠ content locale: one is the language of the
dashboard, the other the language of the content being edited.
