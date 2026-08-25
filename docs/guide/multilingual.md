# Multiple content locales

Configuring the locales content is translated into, how translated records are stored, and the editor and list UI for managing them.

## Configured locales

Website locales come from **`KESTREL_LOCALES`** (comma-separated, e.g. `en,de`) or the config key
**`locales: ['en', 'de']`** — env wins when both are set; default `['en', 'de']`. The primary locale comes
from **`KESTREL_PRIMARY_LOCALE`** or **`primaryLocale: 'en'`**, defaulting to the first entry in the
locale list; a value that isn't in that list also falls back to the first entry rather than erroring.
These are resolved once at module setup and shared between the server (per-locale routing, prerendering)
and the admin UI, so both always agree on the same locale set. These are read when the app is **built**,
not per request — exporting `KESTREL_LOCALES` in front of a prebuilt server is ignored; see
[configuration.md § When the environment is read](./configuration.md#when-the-environment-is-read--build-time-not-request-time)
for the prebuilt-server override names.

This content-locale setting is independent of the **admin-UI chrome language** (the interface strings),
which is separately switchable — see the "Admin-UI language" section below.

## URL scheme — locale prefixes

Every non-primary locale is prefixed `/<locale>/…`; the **primary** locale is **unprefixed** by default
(`/about`, with `/de/about` for German).

Set **`prefixPrimaryLocale: true`** (or `KESTREL_PREFIX_PRIMARY_LOCALE=1`) to prefix the primary locale
too — every page then lives under `/<locale>/…` (`/en/about`, `/de/about`), and the site root is
`/<primary>`. The bare `/` then has no page of its own: under the default `delivery: 'static'` the
published tree has no file at `/`, so **redirect `/` → `/<primary>` at the edge** (NGINX / S3 / CDN —
Kestrel answers no 30x itself in that mode); under `delivery: 'live'` the app is its own edge and honours
an authored redirect rule for it instead — so the rule belongs in the Redirects singleton either way, see
[redirects.md](./redirects.md). Turning the flag on changes every public URL. It is resolved once at boot,
so restart after changing it: the boot full publish then renders every route at its new path and the
always-on prune removes the old ones. On a `nuxt generate` deploy (`output.auto: false`), re-generate
instead. The flag is env → config → default **false**, so existing sites are unaffected until they opt in.

## Data model

A collection opts in with `translatable: true`.

- **`multi`** (the built-in `pages`): each locale is a **separate row**, grouped by a translation group
  id. Unique on `(translationGroup, locale)`; for page-like collections, the slug is unique on the
  **resolved route** — globally across all page-like collections, per locale — so `/about` and the
  prefixed `/de/about` coexist, but two collections can't both claim `/about` (see
  [collections.md](./collections.md) for the slug-uniqueness rules). `GET /api/<col>/translations/<id>`
  returns which locales the group has, and the sibling row id for each; a `single` collection answers
  400 — its locales are keyed by `(singletonKey, locale)`, not by a group. A record that does not exist
  yet has no id — `GET /api/<col>/translations?group=<translationGroup>` answers the same map:

  ```bash
  curl -s --cookie "$SESSION" http://localhost:3000/api/pages/translations/5
  # { "en": 5, "de": null }
  ```

  Admin-only — a public read grant on the collection never covers it.
- **`single`** (the built-in `site` head singleton): one singleton per locale, keyed
  `(singletonKey, locale)`; `POST /api/<col>/updateOne?locale=<loc>` upserts that locale's singleton.

## Editor — the LocaleBar

The collection editor shows a **locale bar** for translatable collections:

**`multi` collections:**

- **active** locale → a label.
- existing sibling → **pen** (edit: navigates to that locale's record) + **copy** (pulls that locale's
  field and block values into the current form).
- missing locale → **"+"** (create) → opens a new record for that locale, pre-linked to the same
  translation group; saving POSTs the `locale` and `translationGroup` to link the sibling.

**Translatable singletons:** the locale bar shows every other locale as a pen link; switching creates
that locale's row on first save (`updateOne?locale=` upserts), so there is no separate create or copy
affordance.

Switching locale navigates to that locale's own URL, so the editor remounts cleanly for the new record.

## List — filtered by locale and translation status

For a translatable collection, the collection list filters to the browsing locale (`?locale`, default
primary) and shows a small **locale switcher**; the *New* link carries the locale so a new record opens
in it.

Each list row also carries a translation sidecar in the same shape as `/translations/<id>` above — locale
→ sibling row id, or `null` when that locale is missing. It drives a small **locale chip** per configured
locale: filled for a locale that exists (links to its sibling), dashed and muted for one that is missing
(offers create-and-link, carrying the translation group along). A published-scope read — anonymous, or
the published site — never reveals a draft translation.

## Missing translations

There is no content-level fallback: a `multi` locale with no row has no route and nothing published for
it, and a missing translatable singleton row reads back a 200 with a `null` body. The one exception is
media metadata — `alt`/`title`/`description` fall back **per field** to the primary locale, so a locale
that sets only `title` still keeps the primary's `alt`.

## Reading a locale

`?locale=<code>` on `readMany`/`readOne` filters to that locale and drives which locale gets populated
for `?depth`:

```
GET /api/pages/readMany?locale=de
```

An absent or empty value falls back to the primary locale; an unsupported one is a 400. See
[querying.md](./querying.md) for the full read parameters.

## What the public pages emit

- `<html lang="<locale>">`, set from the resolved locale.
- `hreflang` alternates for each published sibling, plus `x-default` at the primary-locale variant.
- The sitemap's per-URL alternate set, mirroring the same locales.

See [seo.md](./seo.md) for canonical URLs, Open Graph, and the rest of the head.

## Admin-UI language

The interface **chrome** is fully translated (en/de) and switchable independently of the content
locales — a cookie-backed, SSR-safe preference set from the account menu in the admin rail. Chrome
language ≠ content locale: one is the language of the dashboard, the other the language of the content
being edited.

## See also

- [collections.md](./collections.md) — declaring `translatable: true`, singleton vs. multi collections, and slug-uniqueness rules.
- [configuration.md](./configuration.md) — when the environment is read, and prebuilt-server overrides.
- [publishing.md](./publishing.md) — how the boot full publish republishes affected routes.
- [redirects.md](./redirects.md) — edge-level and live-mode redirects, including the `/` → `/<primary>` case.
- [querying.md](./querying.md) — the `?locale` read parameter in full.
- [seo.md](./seo.md) — hreflang, canonical URLs, and the rest of the head.
- [../internals/data-model.md](../internals/data-model.md) — translation groups and the per-locale unique indexes in the schema.
