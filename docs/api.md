# Kestrel HTTP API (example instance `examples/minimal`)

This file is the interface for frontend projects. It describes what the example configuration of
Kestrel exposes over HTTP. A consumer can wire paths and pipelines differently in its own
`kestrel.config.ts` — the response formats and rules stay the same.

Local base URL: `http://127.0.0.1:4000` (the frontend runs on 3000). The CORS origin is configured
as `http://localhost:3000`.

## Machine-readable: `openapi.json`

The authoritative description lives as OpenAPI 3.1 in
[`../examples/minimal/openapi.json`](../examples/minimal/openapi.json) (generated with
`pnpm --filter kestrel-example-minimal openapi`; regenerate and commit it on every change to the
config or the pipelines). It carries, per endpoint, path/query parameters, request body (JSON or
multipart), response schema, error statuses and bearer security; the content model's fields are
derived from it. For clients/types: `openapi-typescript` or a generator of your choice. The tables
below are the readable short form of the same information.

## Two ways: HTTP or embedded

This API is available over HTTP (a standalone instance, `pnpm start`, port 4000) **and** embedded
in Nuxt — same pipelines, same responses, no round trip. Everything from "Ground rules" onward
applies to both; embedded, `status`/`result` correspond to the HTTP status/body.

### Embedding in Nuxt 4 (Nitro, h3 v1)

```
pnpm add @michaelthielemann/kestrel @michaelthielemann/kestrel-h3 \
  @michaelthielemann/kestrel-events-inmemory @michaelthielemann/kestrel-persistence-sqlite \
  @michaelthielemann/kestrel-authn-multi @michaelthielemann/kestrel-authz-roles \
  @michaelthielemann/kestrel-content-default @michaelthielemann/kestrel-site-default   # … depending on the config
```

Copy `kestrel.config.ts` and `pipelines/` from [`../examples/minimal`](../examples/minimal), and
set `http: null` in the config (Nuxt is the server). Then:

```ts
// server/plugins/kestrel.ts – boots once per process
import { boot } from "@michaelthielemann/kestrel";
import { createKestrelHandler } from "@michaelthielemann/kestrel-h3";
import eventsInmemory from "@michaelthielemann/kestrel-events-inmemory";
import persistenceSqlite from "@michaelthielemann/kestrel-persistence-sqlite";
import authnMulti from "@michaelthielemann/kestrel-authn-multi";
import authzRoles from "@michaelthielemann/kestrel-authz-roles";
import contentDefault from "@michaelthielemann/kestrel-content-default";
import siteDefault from "@michaelthielemann/kestrel-site-default";
import config from "~~/kestrel.config";
import login from "~~/pipelines/login";
import resolvePage from "~~/pipelines/resolvePage";
// … import every pipeline statically (no dynamic loading in the bundle)

export const kestrel = await boot({
  config,
  modules: [eventsInmemory, persistenceSqlite, authnMulti, authzRoles, contentDefault, siteDefault],   // order matches config.modules
  pipelines: [login, resolvePage /* … */],
});
await kestrel.start();                     // event and cron triggers; no HTTP because of http: null
export const kestrelHandler = createKestrelHandler(kestrel, { mountPath: "/api", trustProxy: false });
export default defineNitroPlugin(() => {});

// server/api/[...].ts – all Kestrel triggers under /api
import { kestrelHandler } from "../plugins/kestrel";
export default kestrelHandler;
```

After this, `/api/login`, `/api/site/*path`, `/api/pages`, … exist exactly as in the table below,
just with the `/api` prefix. In server code it also works without the handler, directly:

```ts
const res = await kestrel.run("resolvePage", { trigger: { kind: "http", name: "ssr" }, params: { path: "en/kontakt" }, headers: {} });
// res.status 200 → res.result is the document; 404 → res.error
```

Notes: `node:sqlite` needs Node ≥ 22 (no edge runtime). Nuxt itself handles the health route and
CORS. Rate limiting per IP only works behind a proxy with `trustProxy: true`. A runnable example
without Nuxt: [`../examples/h3`](../examples/h3).

## Ground rules

- **JSON in, JSON out.** Bodies are JSON objects (`content-type: application/json`), and so are
  responses; exceptions: file downloads (raw bytes) and multipart uploads.
- **Query parameters** land in the payload just like body fields (`?locale=en&limit=10`).
- **Every step validates its input.** Before a step runs, the body is checked against the
  step's declared JSON Schema and the declared query parameters against their types (query
  strings are read as `integer`/`number`/`boolean`/arrays where the declaration says so:
  `?limit=10` passes, `?limit=abc` fails). Undeclared body fields are rejected by the steps that
  declare a closed schema (most of them), undeclared query parameters are ignored. A violation
  answers `400 VALIDATION` with `step` and `details.problems: [{ path: "$.field", message }]`
  — the same shape `validate.check` uses — before anything is written. The check runs after
  authentication and authorization, so a missing login still answers 401.
- **Errors** always look like
  `{ "error": "<text>", "code": "<CODE>", "retryable": boolean, "runId": "<uuid>", "step"?: "<step>", "details"?: { … } }`.
  `code` is stable and machine-readable — the frontend should branch on it, not on `error` (the
  text can change). The status follows unambiguously from `code`:

  | Code | Status | Meaning |
  |---|---|---|
  | `VALIDATION` | 400 | invalid input (field name in the text or in `details.fields`; schema violations in `details.problems`) |
  | `DANGLING_REF` | 400 | a `ref` field or an internal link points to a target that doesn't exist (`details.fields`, `details.refs`) |
  | `UNAUTHENTICATED` | 401 | not logged in or the token is invalid |
  | `FORBIDDEN` | 403 | missing permission |
  | `NOT_FOUND` | 404 | not found |
  | `CONFLICT` | 409 | conflict (referenced, name/id already taken, last translation, …) |
  | `PAYLOAD_TOO_LARGE` | 413 | body or file too large |
  | `UNSUPPORTED` | 415 | file/content type not allowed |
  | `RATE_LIMITED` | 429 | too many requests (`details.retryAfterSeconds`) |
  | `INTERNAL` | 500 | internal error (a bug) |
  | `TRANSIENT` | 503 | temporarily unavailable — `retryable: true` |

  `retryable: true` (only for `RATE_LIMITED` and `TRANSIENT`) means: the same request may be
  retried after a short wait; the response then also carries the header `Retry-After` (seconds —
  `details.retryAfterSeconds` if it's a positive integer, otherwise `1`). `step` is the name of the
  step the error originated in (absent only for errors before the pipeline starts: unknown route,
  an unreadable or too-large body — there `retryable: false` and `code` follows from the status
  alone: 400 → `VALIDATION`, 404 → `NOT_FOUND`, 413 → `PAYLOAD_TOO_LARGE`, 500 → `INTERNAL`).
  `details` is an optional object the step attaches; typical shapes: validation errors from
  `content@1` deliver `{ "fields": [{ "field": "slug", "message": "must be unique, \"home\" exists" }] }`,
  so the frontend can attach errors to fields without parsing text; a dangling reference
  (`DANGLING_REF`) additionally delivers `{ "refs": [{ "field", "to", "id" }] }`; a body rejected by
  `validate.check` delivers `{ "problems": [{ "path", "message" }] }` and also duplicates one
  problem at the field root into `fields`.
- **Every response** carries `X-Kestrel-Run-Id` (for support/logs), `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`. If the caller sends `X-Request-Id` (short printable ASCII, max.
  200 characters), that value appears in the log of every line of the run and is returned as
  `X-Request-Id`; anything else is discarded.
- **Auth**: send the token from `POST /login` as `Authorization: Bearer <token>` (alternatively the
  `kestrel_token` cookie, impractical for cross-origin use). Sessions expire after 24 h.
- **Permissions**: anonymous callers may read (`pages.read`, `settings.read`, `media.read`);
  anything that writes needs a login and a role. Roles: `admin` (everything), `editor`
  (`pages.*`, `media.*`, `settings.read`, `redirects.*`).
- **Languages**: the model has `locales: ["de", "en"]`, `defaultLocale: "de"`. `?locale=en` on read
  returns **only** English values, a missing translation = `null`. On write, `locale` (query or
  body) sets only that language. Non-localized fields apply to every language. A `?locale=` outside
  `locales` is 400 (`VALIDATION`), not 500 — for both reading and writing.
- **Timestamps** are milliseconds since epoch (`createdAt`, `updatedAt`). `date` fields likewise; on
  write, ISO-8601 is also accepted.
- **Health**: `GET /health` → `{ "ok": true, "uptimeSeconds": n }`, no auth.

### Zero-Trust

Every input is validated in the backend — type, shape, an allowlist of permitted fields, otherwise
400 with the field name. After that, two paths diverge:

- **HTML-capable fields** (pagebuilder blocks, SVG uploads) are additionally sanitized against an
  allowlist: `validate.sanitize` at positions with `format: "html"`, `validate.sanitizeHtml` for
  whole rich-text fields, `sanitize.svg` for SVG.
- **Plain-text fields** (e.g. `alt`/`title`/`description`, navigation labels) are only validated —
  length, no control characters, allowed structure — and escaped on output. They are deliberately
  *not* sanitized: an HTML sanitizer would corrupt legitimate text such as `5 < 6`.

The rules live in the backend, not in the editor. The frontend also escapes on output — the backend
never relies on that.

## Auth

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/login` | `{ username, password }` | `{ token, identity: { id, claims: { username, roles } } }`; 401 on wrong credentials; 429 after 5 failed attempts/minute per IP |
| POST | `/logout` | – | `{ ok: true }` |
| GET | `/me` | – | `{ id, claims: { username, roles } }` |
| POST | `/me/password` | `{ currentPassword, newPassword }` | `{ ok: true }`; ends every other session |

## Users (permission `users.manage`, i.e. admin)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/users` | – | `[{ id, username, roles, active, createdAt }]` |
| POST | `/users` | `{ username, password, roles? }` | user; 409 (`CONFLICT`) on a duplicate, 400 (`VALIDATION`) on a password that's too short |
| GET | `/users/:id` | – | user |
| PUT | `/users/:id/password` | `{ password }` | `{ ok: true }`; ends that user's sessions |
| DELETE | `/users/:id` | – | deactivates (`{ ok: true }`); 400 for self |
| POST | `/users/:id/activate` | – | `{ ok: true }` |

Password hashes never appear in responses.

## Content

### Model of the example instance

```
settings (single):  title (text, required, localized), description (text, localized – blockquote in llms.txt),
                    navigation (json, localized – list of {label, path, children?})
pages (multi):      slug (slug, required, unique, localized), title (text, required, localized),
                    body (json, localized – pagebuilder blocks),
                    status (enum draft|finished|published, required, **localized** – publication per language),
                    hero (ref → media), seo (json, localized – { title?, description?, noindex? })
redirects (single): rules (json, list of {from, to, status}, order = priority)
```

`body` is checked against the JSON Schema of the block library (exported by the kestrel-web layer,
separate repository; copied into
[`../examples/minimal/schemas/blocks.json`](../examples/minimal/schemas/blocks.json); body = an
array of blocks `{ id, type, props, slots? }`): a violation → `400 pages.body: /0 must have
required property 'type'` (path + message per problem); depth > 32 or > 20,000 nodes → 400. If
`body` is missing from the payload or is `null`, `validate.check` checks nothing — the step only
validates a field that is present, required-field checking is the content model's job. Schema paths
in the `validate-jsonschema` config resolve against `deps.root` (the directory of the loaded
`kestrel.config`, default `process.cwd()`); the preset therefore always passes absolute paths.
**HTML is sanitized on write** (order: `validate.check` first, then `validate.sanitize`, then
`validate.check` again — an invalid body is rejected before anything is sanitized, and the
sanitized body is checked against the schema again before saving): strings at schema positions with
`format: "html"` (the rich-text fields of the block library) pass through an allowlist before
saving — the response contains the sanitized HTML. Allowed: text/list/table tags (`p br hr h1–h6
blockquote pre code em strong b i u s sub sup small mark ul ol li dl dt dd figure figcaption table
thead tbody tfoot tr th td caption span div`), `a[href title target rel data-kestrel-broken]`
(`target=_blank` gets `rel="noopener noreferrer"`), `img[src alt title width height loading]`,
`th/td[colspan rowspan]`, `id class lang dir` everywhere; schemes `http https mailto tel kestrel`
(`img` also `data`). Everything else — `script`, `iframe`, `style`, event handlers, `javascript:` —
is removed. The same list lives in
[`../packages/validate-jsonschema/sanitize.ts`](../packages/validate-jsonschema/sanitize.ts)
(`HTML_ALLOWLIST`) for an identical filter when rendering.
`status = published` can only be set for a language once that language's localized required fields
(`slug`, `title`) are present — otherwise `400 pages: status cannot be "published" for en: slug,
title missing` (model rule `completeWhen`). Documents always carry `id`, `createdAt`, `updatedAt`,
and, for models with languages, `_translations: { de: true, en: false }` (a translation is present
once that language's localized required fields are set). `slug` matches
`^[a-z0-9]+(-[a-z0-9]+)*$`. On write, `id`, `createdAt` and `updatedAt` are forbidden (400).

### Site resolution (public, for the frontend router)

`GET /site/*path` (step `site.resolve:pages`, module `site-default`) → exactly one document or
404. Only `status = published` **in the requested language** (status is localized: EN is only
delivered once EN itself is `published`). Fields without a translation fall back to the default
language (`_locales` names the origin per field, e.g. `{ "slug": "de", "title": "en" }`); the
fallback never overrides the publication status.
When a redirect rule matches, the route responds with `{ redirect: { to, status } }` instead of a
document — even if a page exists at that path. `redirects.lookup` runs only after
`authz.require:pages.read`; if `anonymous` lacks the `pages.read` permission on a deployment, logged
-out visitors get 403 there instead of the redirect.

| Path | Meaning |
|---|---|
| `/site/` | Home page (`slug = home`), default language |
| `/site/kontakt` | Slug `kontakt`, default language (no prefix) |
| `/site/en` | Home page in English |
| `/site/en/kontakt` | Slug `kontakt` in English; if the English slug is missing, found via the German one |
| anything else | 404 |

Mode `prefixPrimary=true` (a step argument in `resolvePage`, not active in the example instance):
then `/site/de` and `/site/de/kontakt` are also addresses of the primary language, and `/site/` and
`/site/kontakt` respond 404.

For Nuxt: a catch-all route → `GET /site/<route.path>`.

**Internal links** are resolved along the way (step `site.resolveLinks:pages`):
`kestrel:pages:<id>` in rich text/JSON becomes the public path of the target page in the requested
language (`/impressum`, `/en/imprint`, home page `/`); link objects
`{ type: "internal", collection: "pages", id }` get a `path`. If the target isn't published in that
language: `href="#" data-kestrel-broken="pages:<id>"`, or `broken: true`. The document additionally
carries `_links: { "<id>": { path, locale } | { broken: true } }` and `_locale` (the effective
language). The frontend needs no URL rule and no individual lookups. The renderer in static delivery
(`delivery.publish`) gets the same resolution — static HTML and `/site/*` contain identical paths.

### Pages

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/pages` | `?locale=&limit=&offset=&sort=-updatedAt` | `{ items: [...], total }` – published only |
| GET | `/admin/pages` | same as above | every status (permission `pages.manage`) |
| GET | `/admin/pages/:id` | `?locale=` | document, every status (permission `pages.manage`) |
| GET | `/pages/:id` | `?locale=` | document (strict, no fallback) – published only, otherwise 404 |
| POST | `/pages` | fields (+ `locale`) | `{ document, delivery: [{ locale, state, path, error, publishedAt }], llms: { entries, full } }` – the document plus the outcome of static delivery per language and of the freshly rewritten `llms.txt`; 400 with a field name on a validation error, e.g. `pages: slug must be unique, "home" exists` or `pages: hero references media/<id> which does not exist` |
| PATCH | `/pages/:id` | partial fields (+ `locale`) | `{ document, delivery: [...], llms }` as with POST |
| DELETE | `/pages/:id/translations/:locale` | – | `{ …document in the default language, delivery: [...], llms }` – deletes only this translation (all localized fields of that language become `null`, `_translations[locale]` becomes `false`, non-localized fields are untouched); 400 for an unknown language, 404 if the document or translation is missing, 409 `… is the last translation – remove the document` for the last remaining translation (even the default language can be deleted as long as another one remains — its URL then becomes 404). Afterwards `references.index`, `links.extract`, `delivery.publish` (removes the static file for that language) and `delivery.exportLlms` run; event `page.translationRemoved` (language in `params.locale`). Permission `pages.write` |
| DELETE | `/pages/:id` | – | `{ ok: true, llms }`; 409 if other documents reference it, e.g. `pages/<id> is referenced by pages/<id2> (hero)` (no 409 on `PATCH`, only on `DELETE`) |

`sort` is a field name, a leading `-` means descending; an unknown field → 400 (`unknown sort field
…`). `limit` and `offset` must be integers (`limit` ≥ 1, `offset` ≥ 0); an invalid value or a
`limit` above the ceiling (`maxLimit` in the `content/default` config, default 200) → 400. Without
`limit`, the list returns every match. Write calls need `pages.write`, deletion needs `pages.delete`
(deleting a single translation is a write, `pages.write`).

### Settings (single)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/settings` | `?locale=` | document; as long as it was never set: 200 with an empty document (every field `null`, `_translations` all `false`). If the step carries a fixed filter (`content.get:settings?status=published`), it also applies to the empty document → 404 |
| PUT | `/settings` | every field (+ `locale`) | `{ …document, llms: { entries, full } }` – replaces the language entirely (`settings.write`) and rewrites `llms.txt` (its title/description come from this document) |

`navigation` is checked against a JSON Schema: a list of `{ label, path, children? }`, both
non-empty strings, no other fields — otherwise 400 with path and reason
(`settings.navigation: /0 unexpected property "onclick"`). `label` is plain text, not HTML.

### Redirects (single)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/redirects` | – | document; as long as it was never set: 200 with an empty document (`redirects.read`) |
| PUT | `/redirects` | `{ rules: [{ from, to, status? }] }` | document, writes `redirects.json` to the blob store (`redirects.write`); 400 `redirects: Row N: …` on an invalid rule |
| GET | `/redirects.json` | – | `[{ pattern, target, status }]` – public, same content as the file in the blob store |

`from` uses `*` (one segment) / `**` (one or more segments), `to` is a path or an https URL with
`$1…`; `status` is 301 (default) | 302 | 307 | 308. List order = priority when several rules match.

`GET /redirects.json` is deliberately public: the rules are observable through browser behavior
anyway, `redirects.read` only protects the editor view.

## Media

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/media` | `multipart/form-data`: field `file`, repeatable for multiple files in one request, optional `folder`, optional `provenance` (`human`/`ai`/`mixed`/`unknown` or JSON `{ origin, tool?, model?, at? }`, applies to every file in the request; `unknown` if omitted) | exactly one file: `{ id, filename, folder, contentType, size, key, checksum, status, createdAt, provenance }` (`media.write`); multiple files: `{ items: [...same shape...], errors: [{ filename, status, message }], ids }` – each file is checked independently (type, size, 409 on a name conflict), a failed file doesn't stop the rest (partial success, 200); the blob key is `media/<folder>/<filename>` (no folder → `media/<filename>`; the `media/` prefix is configurable and separates media from replication snapshots, the site export and `redirects.json`), so on disk `data/blobs/media/2026/press/photo.jpg`; 409 for the same filename in the same folder (for multiple files, as an entry in `errors`, not as an HTTP status); no `file` field → 400 |
| GET | `/media/folders` | – | `[{ folder, count }]` – every folder, including empty ones (persisted in `media_folders`) and implicit parent folders (the client builds the prefix tree; `folder` is a label). The root is not a folder: files without a folder don't create a `""` entry |
| POST | `/media/folders` | `{ path }` | `{ folder, count }` – creates the folder (idempotent), including implicit parent folders (`media.write`); `count` is the number of files already there (0 for a new folder, otherwise the existing count) |
| PATCH | `/media/folders/*path` | `{ path }` | `{ folder, moved }` – renames or moves the folder; subfolders and files move with it, blobs are renamed accordingly (`media.write`); 404 if the folder doesn't exist, 409 on a target conflict. If a rename aborts partway (the process dies between the blob move and the row update), the target folder stays occupied and a repeated PATCH answers 409: move the remaining files individually via `PATCH /media/:id`, then delete the source folder |
| DELETE | `/media/folders/*path` | `?recursive=true` | `{ ok: true, removed }` – deletes a folder (`media.delete`); 409 if it isn't empty (without `recursive`); 409 if one of the contained files is referenced (nothing gets deleted) |
| GET | `/media` | `?folder=&recursive=true&q=&sort=&limit=&offset=` | `{ items, total }`; `folder` matches exactly, with `recursive=true` the exact subtree (`2026` → `2026` and `2026/…`, not `2026x` or `2026-alt`); `q` = substring match on `filename` (case-sensitive); `sort` = `createdAt`, `filename`, `size`, a leading `-` = descending (default `-createdAt`); every item also carries `variants[]`, see [Image variants](#image-variants) |
| GET | `/media?ids=a,b,c` | – | `{ items, total }` – exactly these items in the requested order (missing ones are skipped, max. 200); other parameters ignored |
| GET | `/media/:id` | `?locale=` | metadata incl. `updatedAt`, `checksum` (sha256 of the bytes, hex; `null` for files predating the field), `status` (always `ready`, see below), `width`/`height` (from the file header for PNG/JPEG/GIF/WebP, otherwise `null`), `alt`/`title`/`description` for the requested language (`null` if not set; default language `de`), `variants[]` (see [Image variants](#image-variants)) |
| GET | `/media/:id/file` | – | raw bytes, the file's `Content-Type`; images (incl. sanitized SVG)/audio/video `inline`, otherwise `attachment`; header `X-Content-Provenance: ai|mixed|unknown` when `provenance.origin` ≠ `human` |
| GET | `/media/:id/variants/:file` | – | image variant, `:file` = `<size>.<ext>` (e.g. `thumb.webp`), see [Image variants](#image-variants) |
| PATCH | `/media/:id` | `{ filename?, folder?, provenance?, locale?, alt?, title?, description? }` | metadata (`media.write`); changing `filename`/`folder` moves the underlying blob (key `media/<folder>/<filename>`), 409 on a conflict with an existing file; text fields apply to `locale` (body or query, default `de`), `null` or `""` clears that language's text; `updatedAt` advances on every PATCH |
| DELETE | `/media/:id` | – | `{ ok: true }`; deletes the row first, then the blob — if deleting the blob fails, the request still succeeds and the blob is logged (`media.reconcile` cleans it up later); 409 if a page references it — via a `ref` field (`hero`) or via an internal link in a `json` field (a block tree, e.g. `body`), e.g. `media/<id> is referenced by pages/<id2> (hero)` (`media.delete`); also deletes every image variant of that item |

Rules: allows `image/*` (including SVG) and `application/pdf`, forbids `text/html` (415,
`UNSUPPORTED`); max. 5 MB (413, `PAYLOAD_TOO_LARGE`). **SVG** is sanitized on upload
(`sanitize.svg` before `media.upload`): `script`, `style`, event handlers, `foreignObject`, `image`
and external `href`/`xlink:href` are removed, only internal references (`#id`) survive; the XML
prolog and comments are dropped; > 2 MB → 413 (`PAYLOAD_TOO_LARGE`), no `<svg>` root → 400
(`VALIDATION`). Sanitized SVGs are served `inline` on `GET /media/:id/file`
(`http.inlineTypes: ["image/svg+xml"]`), every other non-image type remains `attachment`. The two
are linked: `image/svg+xml` in `http.inlineTypes` without a module that registers `sanitize.svg`
aborts boot — unsanitized SVGs are never served inline. `folder` is a path label (`2026/press`), not
a directory: segments only `[A-Za-z0-9._-]`, separated by `/`, leading/trailing `/` are stripped,
`.`/`..` → 400. `filename` is sanitized on upload and rename (basename only, characters outside
`[A-Za-z0-9._-]` → `-`, leading `.`/`-` stripped, empty → `file`) — the response can differ from the
value that was sent; the UI should adopt the response value.
Image URL in the frontend: `/media/<id>/file`. A page references it via `hero: "<media-id>"`.
`alt`, `title` and `description` are plain text and are validated as such: at most 2000 characters,
no control characters other than tab and newline, otherwise 400
(`media/default: alt must be plain text (max 2000 chars)`). Nothing is sanitized here — an HTML
sanitizer would corrupt legitimate text such as `5 < 6`; the frontend escapes on output.
`GET /media?locale=en` and `?ids=…&locale=en` return the texts in that language.
`provenance` states who produced the file (`human`, `ai`, `mixed`, `unknown`) — the frontend should
visibly flag `ai`/`mixed` (EU AI Act Art. 50) and send the origin with every upload. Without one,
`{ origin: "unknown" }` is stored: a missing value is not proof that a human created the file. Rows
predating the field also read as `unknown`.
Upload happens in two phases: first the row with `status: "uploading"` and the `checksum` of the
bytes, then the blob, then `status: "ready"`. If writing the blob fails, the row stays at
`status: "failed"` and the request answers with an error; a repeated upload of the same name
replaces that row (no lasting 409). Only `ready` items are visible: `GET /media` (including `?ids=`)
hides everything else, `GET /media/:id` and `GET /media/:id/file` answer 404. A reconciliation
between the blob store and `media_items` is available as the step `media.reconcile`
(`{ blobsWithoutRow, rowsWithoutBlob }`; with `delete: true`, blobs without a row are deleted, rows
never); [`../examples/minimal`](../examples/minimal) doesn't wire up a route or a cron for it yet.

Migration: on start, a one-time check looks for blobs still under an old key scheme (`<uuid><ext>`
or a path without the `media/` prefix); these are rekeyed to `media/<folder>/<filename>`, name
collisions get the suffix `-2` (only in this migration step). The run is repeatable: if the blob is
already at the target key, only the row still gets updated.

## Image variants

For every image (not SVG, not GIF), `images-default` keeps a WebP variant per *effective size*:
generated on upload (event `media.uploaded`), caught up by a resumable sync job, listed on the media
metadata, served by path, exportable, deleted only on request. The original is never modified.

Default sizes (always generated unless the config replaces them): `thumb 320 · small 640 ·
medium 1024 · large 1600 · xl 2400` (each `inside`, WebP, quality 82). Additional sizes can be
registered via config or at runtime (`PUT /admin/images/sizes`); a registered size with the same
name as a config size but a different definition is rejected (409).

Sizes are code, not data: they are **not** persisted. Config sizes are rebuilt from the config on
every boot, registered sizes live only in the process that received them and are rebuilt from
scratch by every `images.register`. A host with its own sizes must therefore register them at boot
(see below); before that, the instance only knows the default/config sizes. Variants stay in the
database: variants for a size nobody declares any more are reported under `orphaned` by
`GET /admin/images/status`, and `POST /admin/images/prune` deletes them.

| Method | Path | Body | Response |
|---|---|---|---|
| PUT | `/admin/images/sizes` | `{ sizes: [{ name, width, height?, fit: "inside"\|"cover", format: "webp"\|"original", quality? }] }` (non-empty) | effective sizes after replacing the registered list (`images.write`); 400 on an empty list or an invalid definition, 409 on a name collision with a config size |
| GET | `/admin/images/sizes` | – | effective sizes (defaults/config merged with registered ones) (`images.read`) |
| POST | `/admin/images/sync` | – | starts or resumes a sync job, keeps running in the background; `{ id, state, total, done, failed, cursor, startedAt, updatedAt, finishedAt, error }` (`images.manage`); 409 `images: sync job <id> is running` if a fresh job is already running |
| GET | `/admin/images/status` | – | `{ sizes: [{ …size, source, used, variants: { done, pending, error, failed } }], job, orphaned: { sizes: [name], variants: n }, registrySeen }` – `used` = registered in this process (defaults are never "used" but are still generated); `orphaned` are sizes that still have variants but that nobody declares any more; `registrySeen: false` means this process has never seen `register()` — `orphaned` is then always empty, because "no longer declared" can't be told apart from "not yet registered" (`images.read`) |
| POST | `/admin/images/prune` | `{ sizes: [name] }` | deletes the variants (blob + row) for the named *orphaned* sizes; `{ sizes, variants }` (`images.manage`); 400 if a name is still declared or has no variants |
| GET | `/media/:id/variants/:file` | – | variant image bytes, `Content-Type: image/webp`; 404 for an unknown size or unknown medium; if the variant isn't ready yet (pending/error), the original bytes are served instead with header `x-kestrel-variant: pending`; if the variant has permanently given up after `maxAttempts` tries (`failed`), there is no original as a fallback, instead 404 with the reason (`images: variant <size> for media/<id> failed after <n> attempts: <error>`) (`media.read`, `identifyUser`) |

`GET /media/:id` and `GET /media` additionally return
`variants: [{ size, width, height, format, bytes, state, path }]`; `path` is the stable public path
`/media/<id>/variants/<size>.<ext>`. A broken original image only produces `state: "error"` on the
affected variant — upload and sync keep running unaffected. A cron job (every 5 minutes) calls
`images.resume` and automatically continues a paused/failed/stuck sync job, even without a manual
`POST /admin/images/sync`.

Embedded hosts (without HTTP) register sizes at boot directly via the pipeline API:
`kestrel.run("registerImageSizesBoot", { trigger: { kind: "event", name: "boot" }, payload: { sizes } })`
— the pipeline `registerImageSizesBoot` consists only of `images.register` and has no HTTP trigger,
so it's reachable only via `kestrel.run`.

## Static delivery (the second traffic light)

When a page is created or changed, `delivery-static` renders every language whose own `status` is
`published` through the site's renderer (`renderer@1` — implemented by the kestrel-web layer,
separate repository) and stores the result in the blob store: `site/<slug>/index.html` (primary
language), `site/en/<slug>/index.html`, home page (`slug = home`) → `site/index.html` and
`site/en/index.html` respectively. Assets delivered by the renderer (`_nuxt/…`) land under
`site/_nuxt/…`. Languages that are no longer published are removed.

| Method | Path | Response |
|---|---|---|
| GET | `/admin/publish-status/pages/:id` | `[{ locale, state: live \| error \| draft, path, error, publishedAt, updatedAt }]` (`pages.manage`) |
| POST | `/admin/publish-all/pages` | `{ documents, live, errors, redirects: { rules, skipped }, llms: { entries, full } }` – re-render everything, and afterwards also rewrite `redirects.json` and `llms.txt` (the pipeline chains `redirects.export` and `delivery.exportLlms` onto `delivery.publishAll:pages`) (`pages.manage`) |

`state`: `live` = delivered, `draft` = not published in that language, `error` = rendering or saving
failed (`error` names the cause; the last `live` output stays in place). The example instance uses
`renderer-plain` (an HTML skeleton) and the filesystem blob store (`data/blobs/site/`); in
production: the Nuxt renderer from the kestrel-web layer + `blobstore-s3`.

With `media` configured (`publicPath`, `collection`, `variants`, `target`), `delivery-static` scans
every rendered text output for `<publicPath>/<id>/file` and
`<publicPath>/<id>/variants/<size>.<ext>` references, copies the original or every finished
(`state: done`) variant under `site/media/<folder>/<filename>` or
`site/media/<folder>/<filename>.<size>.<ext>`, and rewrites the references in the HTML to these
paths — an exported site can therefore serve images without a running backend. Each target is
copied only once per process (`publishAll` forces a full refresh), so a medium re-uploaded under
the same name is only refreshed again by `publishAll`; unknown ids or variants that aren't ready yet
stay unchanged and get logged (a missing blob for an otherwise-known reference makes the publish
fail). The rewriter does not match HTML-escaped slashes (e.g. `&#x2F;`).

### llms.txt and llms-full.txt (GEO)

With `llms` configured, `delivery.exportLlms` writes two files per [llmstxt.org](https://llmstxt.org)
next to `redirects.json` in the blob store (`site/llms.txt`, `site/llms-full.txt`); nginx serves
them statically. The step takes no argument and, in the example instance, is chained onto
`createPage`, `updatePage`, `deletePage`, `setSettings` and `publishAllPages`; it adds
`llms: { entries, full }` to the result. The source is the `live` rows of the publish traffic light
for every type configured under `types` — i.e. exactly what is delivered: drafts are absent, and a
language only appears once it is itself published. For each row, the document is read (with field
fallback); `seo.noindex === true` excludes the page from both files. If `llms.txt` cannot be
written, the whole request (i.e. `POST`/`PATCH /pages`,
`DELETE /pages/:id[/translations/:locale]`, `PUT /settings`, `POST /admin/publish-all/pages`)
answers with 503 (`TRANSIENT`, `retryable: true`, `Retry-After`) instead of the `llms` field it
would otherwise contain — the same request can be retried. Likewise, `PUT /redirects` and
`POST /admin/publish-all/pages` answer with 503 if `redirects.json` could not be written.

`llms.txt`: `# <settings.title>` (default language; empty → the host from `siteUrl`, otherwise
`Website`), a blockquote `> <settings.description>` (only if set), then a
`## <headings[type] ?? type>` section per type with
`- [<seo.title || title>](<siteUrl><path>): <seo.description>` per page, sorted by URL. Without
`siteUrl`, only paths appear in the file.

`llms-full.txt` only with `full: true` (opt-in — this file bundles the entire site into one document
and reads every rendered page): per page `### <Title>`, `Source: <URL>`, the description, then the
stored HTML (`site/<path>/index.html`, which is why `full` requires the `html` format) restricted
to the `<main>` element and converted to Markdown with turndown (headings pushed three levels
deeper, root-relative links and images made absolute with `siteUrl`, `#` anchors lose their link,
`script`/`style`/`nav` chrome outside `<main>` is absent; without a `<main>`, the whole `<body>`,
logged). If `full` is off, an existing `llms-full.txt` is deleted. If the HTML for a `live` row is
missing, the page is included without a body and logged.

Config (`delivery-static`, everything optional — without `llms` the export is active with paths
instead of URLs and without `llms-full.txt`):
```ts
llms: {
  siteUrl: "https://example.org",     // absolute base; without it: paths
  full: false,                        // write llms-full.txt
  settings: { type: "settings", titleField: "title", descriptionField: "description" },
  titleField: "title", seoField: "seo",
  headings: { pages: "Pages" },       // section heading per type, default = type name
}
```
Boot checks: if `settings.type` exists in the model, it must be a `single` type with `titleField`
(if the type is absent entirely, only the fallback heading is used); `full` requires `"html"` in
`formats`. If `seoField` or `descriptionField` is missing from the model, only the filter or the
blockquote is skipped, respectively.

## Database replication (admin, permission `system.manage`)

The SQLite database is continuously replicated to the blob store (a snapshot per generation plus
WAL segments, cron every minute → data loss ≤ 60 s; snapshot daily, 48 h retention, all
configurable).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/admin/replication/status` | – | `{ generation, lineage, shippedFrames, lastSyncAt, lastSnapshotAt, lastCheckpointAt, walBytes, pendingRestore }` |
| GET | `/admin/replication/points` | – | `[{ generation, at, kind: snapshot \| wal, key }]` – restore points, chronological |
| POST | `/admin/replication/snapshot` | – | `{ generation, bytes }` – a new generation immediately |
| POST | `/admin/replication/restore` | `{ generation?, at? }` (`at` in ms or ISO; omitted = latest) | `{ generation, at, file, restartRequired: true }` – rebuilds the DB at that point in time next to the live DB; **takes effect on the next start** (the open DB can't be replaced while running); 404 if there's no snapshot before `at` |

UI suggestion: pick a point from `points` → `restore` → show a "restart required" notice;
`status.pendingRestore` shows that a restore is waiting.

## Content migrations (admin, permission `migrations.manage`)

When a consumer renames or nests a field or a block, existing documents still carry the old shape.
A migration `{ id, collection, up(document, locale) }` from the consumer's `migrations/` folder is
applied exactly once — per document and per stored language (from `_translations`), the result is
checked against the model and the JSON Schema, and the ledger entry is written only after success.
At boot: `mode: "apply"` applies whatever is pending (dev), `"check"` refuses to start and lists
what's pending (production; a deploy deliberately sets `apply`), `"off"` does nothing; the routes
work in every mode. No `<type>.updated` event fires per document, but `migrations.applied` fires
once after a run (`{ migrations: [id], documents }`). There is no `down` — the way back is
replication (point-in-time recovery).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/admin/migrations` | – | `{ applied: [{ id, appliedAt, documents, durationMs }], pending: [{ id, collection }] }` – ledger in chronological order, pending in config order |
| POST | `/admin/migrations/apply` | `{ dry?: true }` | without `dry`: `{ applied: [LedgerEntry] }` (empty if nothing was pending); with `dry: true`: `{ dry: true, changes: [{ id, documents }] }` – counts affected documents including validation, writes nothing; 409 (`CONFLICT`) `migrations: apply is running` while a run is in progress; 500 with code `MIGRATION_FAILED` and `migrations: "<id>" failed on <collection>/<docId> locale <l>: <cause>` (`details: { migration, document, locale?, problems? }`) — documents already migrated by this migration stay migrated, the ledger is unchanged |

For the UI: show the 500's error message verbatim (it names the migration, document and language);
offer "dry run" before "apply".

## Admin

| Method | Path | Response |
|---|---|---|
| POST | `/admin/media/export` | `{ written, skipped, missing, conflicts }` – copies every medium to `data/export/<folder>/<filename>` (a readable layout for external tools; matches the blob keys without their `media/` prefix; name collisions → `-2`, `-3`; unchanged files are skipped) (`media.manage`); afterwards also exports every finished image variant to `data/export/<folder>/<filename>.<size>.<ext>` and adds `variants: { written, skipped }` to the response — the media counters are unaffected |
| GET | `/admin/references/broken` | `[{ fromType, fromId, field, locale, toTarget, toId, via, broken, checkedAt }]` – `via` names the origin: `"field"` (a `ref` field) or `"body"` (an internal link in a `json` field) (`pages.manage`) |
| POST | `/admin/references/rebuild` | `{ documents, entries }` (`pages.manage`) |
| GET | `/admin/references/to/pages/:id`, `/admin/references/to/media/:id` | `[{ type, field, id, via }]` – documents that reference the target (`pages.manage`, also for the media endpoint; for delete dialogs; empty = safe to delete); `via: "field" \| "body"`, a document can reference via both origins and then appears twice |
| GET | `/admin/references/to/pages?ids=a,b,c`, `/admin/references/to/media?ids=a,b,c` | `{ [id]: [{ type, field, id, via }] }` – batch variant of the route above, max. 200 ids, comma-separated; missing or empty `ids`, or more than 200 → 400 (`pages.manage`) |
| GET | `/admin/links/broken` | `[{ url, fromType, fromId, field, locale, ok, status, error, checkedAt }]` – external links that failed the nightly check (`?type=pages` filters) (`pages.manage`) |
| POST | `/admin/links/rebuild` | `{ documents, entries }` (`pages.manage`) |

## What the frontend does not need to do

- Language fallback logic for `/site/*` (the backend handles it, transparently via `_locales`).
- Check slug uniqueness, required fields, reference existence — the backend answers with 400 and a
  field name; client-side validation is UX only.
- Refresh the token — there is no refresh; log in again after a 401.

## What the kestrel-web layer provides for delivery

A Kestrel module (step-only or a contract module) that fulfills `renderer@1`:

```ts
interface Renderer {
  formats(): string[];                                   // e.g. ["html"] or ["html", "pdf"]
  render(input: { type, id, locale?, path, format, document }): Promise<Result<{
    data: Uint8Array | string; contentType: string; extension: string;
    assets?: Array<{ path: string; data: Uint8Array | string; contentType: string }>;   // _nuxt/*, CSS – for hydration
  }, RendererError>>;
}
```

`path` is the page's eventual path (`/en/kontakt`), `document` the resolved document (with
fallback). The contract test `@michaelthielemann/kestrel-contracts/renderer.contract.test` must
pass. How rendering happens (Nitro `localFetch`, `renderToString`) is up to the kestrel-web layer.

## Not in this instance

Registration, password reset, on-demand image sizing (beyond the configured named variants),
search, versioning.
