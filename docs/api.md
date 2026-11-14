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
  @michaelthielemann/kestrel-events-inmemory @michaelthielemann/kestrel-events-direct \
  @michaelthielemann/kestrel-persistence-sqlite \
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
import eventsDirect from "@michaelthielemann/kestrel-events-direct";
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
  modules: [eventsInmemory, eventsDirect, persistenceSqlite, authnMulti, authzRoles, contentDefault, siteDefault],   // order matches config.modules
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
// res.status 200 → res.result is the document or { redirect: { to, status } }; 404 → res.error
```

Notes: `node:sqlite` needs Node ≥ 22 (no edge runtime). With `http: null` the host serves its own
health route, answered from `kestrel.health()`, and handles CORS. Rate limiting per IP behind a proxy needs `trustProxy: true` or `trustedHeader`, and the proxy's address in `trustedProxies` unless it connects over loopback. A runnable example
without Nuxt: [`../examples/h3`](../examples/h3).

## Ground rules

- **JSON in, JSON out.** Bodies are JSON objects (`content-type: application/json`, or any
  `application/*+json`), and so are responses; exceptions: file downloads (raw bytes) and multipart
  uploads. A non-empty body of any other type, or without a type, is refused with `415 UNSUPPORTED`
  before a pipeline runs.
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
  text can change). A step that throws (a bug) answers `INTERNAL` with
  `error: "<pipeline>/<step>: unexpected <ErrorName>"`; its message and stack are in the server log
  under the answer's `runId`. The status follows unambiguously from `code`:

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
  `content@1` deliver `{ "fields": [{ "field": "title", "message": "required" }] }`,
  so the frontend can attach errors to fields without parsing text; a dangling reference
  (`DANGLING_REF`) additionally delivers `{ "refs": [{ "field", "to", "id" }] }`; a body rejected by
  `validate.check` delivers `{ "problems": [{ "path", "message" }] }` and also duplicates one
  problem at the field root into `fields`.
- **Every response** carries `X-Kestrel-Run-Id` (for support/logs), `X-Content-Type-Options:
  nosniff` and `Cache-Control: no-store`, except where a file response sets its own caching: the
  public media file at `/media/:id/:name` is `immutable`. If the caller sends `X-Request-Id` (short
  printable ASCII, max. 200 characters), that value appears in the log of every line of the run and
  is returned as `X-Request-Id`; anything else is discarded.
- **Auth**: send the token from `POST /login` as `Authorization: Bearer <token>`. A browser can
  rely on the `__Host-kestrel_token` cookie instead, which the login response sets itself (`HttpOnly`,
  `Secure`, `SameSite=Strict`, `Path=/`, `Max-Age` = the session lifetime) and logout removes; page
  script never sees it. A `POST`, `PUT`, `PATCH` or `DELETE` authenticated by that cookie must come
  from the same origin — `Sec-Fetch-Site: same-origin`, or an `Origin` whose host is the request's
  `Host` — or it is answered `403 FORBIDDEN`; a bearer request is not checked. Sessions expire after
  24 h.
- **Permissions**: anonymous callers may read (`pages.read`, `settings.read`, `media.read`), and so
  may every signed-in caller, whatever its role; anything that writes needs a login and a role. An
  account without a configured role may only read its own identity (`GET /me`) and sign out; every
  other route behind a login answers it 403, and listing the media library needs `media.list`. Roles: `admin` (everything), `editor`
  (`pages.*`, `media.*`, `images.read`, `settings.read`, `redirects.*`).
- **What an anonymous caller receives**: the fields `anonymousFields` grants, cut by the last step of
  every public read (`authz.fields`). A document comes without `createdAt` and `updatedAt`; a media
  item without `folder`, `createdAt`, `updatedAt`, `available`, `variantCounts` and `framing` (it
  keeps `focus`), and each variant without `bytes` and `state`; a file answer keeps `cache-control`, `x-content-provenance` and
  `x-kestrel-variant` of the headers its step sets. A signed-in caller with a role receives the whole
  answer; one whose roles are all unknown to the config receives the anonymous one. The
  OpenAPI document describes both: `#/components/schemas/<operationId>` and
  `#/components/schemas/<operationId>.anonymous`, named per audience in the 200's
  `x-kestrel-answers`.
- **Languages**: the model has `locales: ["de", "en"]`, `defaultLocale: "de"`. `?locale=en` on read
  returns **only** English values, a missing translation = `null`. On write, `locale` (query or
  body) sets only that language. Non-localized fields apply to every language. A `?locale=` outside
  `locales` is 400 (`VALIDATION`), not 500 — for both reading and writing.
- **Timestamps** are milliseconds since epoch (`createdAt`, `updatedAt`). `date` fields likewise; on
  write, ISO-8601 is also accepted.
- **Health**: `GET /health` → `{ "ok": boolean, "restartRequired": boolean }`, no auth; 503 once a
  module reports `restartRequired`, otherwise 200.

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
| GET | `/roles` | – | `{ roles }`, the configured role names in config order – gated by `users.manage` like the rest of user management, not by every authenticated caller |
| POST | `/users` | `{ username, password, roles? }` | user; 409 (`CONFLICT`) on a duplicate, 400 (`VALIDATION`) on a password that's too short |
| GET | `/users/:id` | – | user |
| PATCH | `/users/:id` | `{ username?, roles? }` | user; 400 (`VALIDATION`) without either field, 409 (`CONFLICT`) on a duplicate name, 409 (`LAST_ADMIN`) when the last admin would lose the permission; a role change ends that user's sessions |
| PUT | `/users/:id/password` | `{ password }` | `{ ok: true }`; ends that user's sessions |
| POST | `/users/:id/deactivate` | – | `{ ok: true }`; ends that user's sessions; 400 for self, 409 (`LAST_ADMIN`) for the last admin |
| POST | `/users/:id/activate` | – | `{ ok: true }` |
| DELETE | `/users/:id` | `{ reassignTo? }` | deletes the user and their sessions (`{ ok: true, reassignTo: { id, name } \| null }`); 400 for self or an unusable target, 404 for an unknown target, 409 (`LAST_ADMIN`) for the last admin |
| POST | `/admin/users/:id/revisions/reassign` | `{ reassignTo: string \| { id } \| null }` | re-runs the author reassignment for that user: `{ from, to, revisions }`; `reassignTo` names the target's id only — it is looked up and must be an existing, active user (400/404 otherwise); a name is never sent or trusted, the response and the stored author always carry the target's current username |
| POST | `/admin/users/:id/audit/anonymize` | – | re-runs the audit anonymisation for that user: `{ entries }` |

The username is the identity — a user has no e-mail field. Roles are free strings; which ones
exist is the authz configuration's business (`authz.roles` in `kestrel.config.ts`). `LAST_ADMIN`
(409) protects the last active user who still holds `users.manage` (`authn.adminPermission`):
they can neither be deactivated, nor deleted, nor stripped of the role that grants it. Password
hashes never appear in responses.

Deleting removes the user row and their sessions and then, through the `user.deleted` event, takes
care of what they authored — see [Personal data](#personal-data). `reassignTo` is the id of the
user their revisions move to; it must exist, be active and not be the deleted user themselves
(400/404 otherwise, and the user is *not* deleted). Without it the author reference is anonymised.
The response repeats the resolved target with the username it had at that moment, which is what the
event payload carries too.

## Content

### Model of the example instance

```
settings (single):  title (text, required, localized), description (text, localized – blockquote in llms.txt),
                    navigation (json, localized – list of {label, path, children?})
pages (multi):      slug (slug, required, localized; the public path is unique), title (text, required, localized),
                    body (json, localized – pagebuilder blocks),
                    status (enum draft|finished|published, required, **localized** – publication per language),
                    hero (ref → media), seo (json, localized – { title?, description?, noindex? }),
                    parent (ref → pages – the page this one is a subpage of)
redirects (single): rules (json, list of {from, to, status}, order = priority)
```

`body` is checked against the JSON Schema of the block library (the example instance's is
[`../examples/minimal/schemas/blocks.json`](../examples/minimal/schemas/blocks.json); body = an
array of blocks `{ id, type, props, slots? }`). A violation answers `400 pages.body: /0 must have
required property 'type'` (path + message per problem); a body deeper than 32 levels or larger
than 20,000 nodes also answers 400. If `body` is missing from the payload or is `null`,
`validate.check` checks nothing — the step only validates a field that is present, required-field
checking is the content model's job. Schema paths in the `validate-jsonschema` config resolve
against `deps.root` (the directory of the loaded `kestrel.config`, default `process.cwd()`); the
preset therefore always passes absolute paths.

**HTML is sanitized on write.** Save order is `validate.check`, then `validate.sanitize`, then
`validate.check` again: an invalid body is rejected before anything is sanitized, and the
sanitized body is checked against the schema again before saving. Sanitizing runs on strings at
schema positions with `format: "html"` (the rich-text fields of the block library) — the response
contains the sanitized HTML.

Allowed by the sanitizer: text/list/table tags (`p br hr h1–h6 blockquote pre code em strong b i u
s sub sup small mark ul ol li dl dt dd figure figcaption table thead tbody tfoot tr th td caption
span div`), `a[href title target rel data-kestrel-broken]` (`target=_blank` gets
`rel="noopener noreferrer"`), `img[src alt title width height loading]`, `th`/`td[colspan
rowspan]`, `id class lang dir` on any tag, and the schemes `http https mailto tel kestrel` (`img`
also `data`). Everything else — `script`, `iframe`, `style`, event handlers, `javascript:` — is
removed. The same list lives in
[`../packages/validate-jsonschema/sanitize.ts`](../packages/validate-jsonschema/sanitize.ts)
(`HTML_ALLOWLIST`) and is reused when rendering.
`status = published` can only be set for a language once that language's localized required fields
(`slug`, `title`) are present — otherwise `400 pages: status cannot be "published" for en: slug,
title missing` (model rule `completeWhen`). Documents always carry `id`, and `createdAt` and
`updatedAt` for a signed-in caller, and, for models with languages, `_translations: { de: true, en: false }` (a translation is present
once that language's localized required fields are set). `slug` matches
`^[a-z0-9]+(-[a-z0-9]+)*$`. On write, `id`, `createdAt` and `updatedAt` are forbidden (400).

### Site resolution (public, for the frontend router)

`GET /site/*path` (step `site.resolve:pages`, module `site-default`) → exactly one document, a
redirect hit (below), or 404. Only `status = published` **in the requested language** (status is localized: EN is only
delivered once EN itself is `published`); a language that is not published is never replaced by
another one. Fields without a translation fall back to the default language (`_locales` names the
origin per field, e.g. `{ "slug": "de", "title": "en" }`), but only when the default language is
itself `published`; otherwise the field stays empty. `_translations` reports only the languages
that are themselves `published`.
Static delivery (`delivery.publish`) derives its published document the same way, so the export and
the live API never disagree.
A page with a `parent` lives below it: `/ueber-uns/team`, `/en/about-us/team`; in a language without
its own slug a segment falls back to the default language's slug. A subpage stays reachable while its
parent is not published (the parent itself answers 404), so the parent's slug is visible as a segment;
`parent` is not in the anonymous field grant. Renaming or moving a page moves all its subpages, and
each old path redirects.
The document carries `_paths: { de: "/kontakt", en: "/en/contact" }`: its public path in every
language, `null` where it is not published or another page holds the path; the language switcher
needs no further request. Paths come from `site-default`'s routed mode: a path belongs to exactly
one page per language. A language without its own slug reaches the page through the default
language's slug (`/en/kontakt`) until another published page takes `/en/kontakt` with a slug of its
own. When a page's path changes (slug renamed, translation removed, taken over), the old path
answers `{ redirect: { to: "<new path>", status: 301 } }` from then on, and `redirects.json` lists
it after the editor's rules.
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
language: `href="#" data-kestrel-broken="pages:<id>"`, or `broken: true`. A target published in that
language but without its own slug there gets one from the default language only when the default
language is itself published; with no such default the link stays broken instead. The document
additionally carries `_links: { "<id>": { path, locale } | { broken: true } }` and `_locale` (the
effective language). The frontend needs no URL rule and no individual lookups. The renderer in
static delivery (`delivery.publish`) gets the same resolution — static HTML and `/site/*` contain
identical paths.

### Pages

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/pages` | `?locale=&limit=&offset=&sort=-updatedAt` | `{ items: [...], total }` – published only; `sort=-updatedAt` also orders an anonymous caller's list, whose items carry no `updatedAt` |
| GET | `/admin/pages` | same as above | every status (permission `pages.manage`) |
| GET | `/admin/pages/:id` | `?locale=` | document, every status, with `_paths` for every language that has a valid path, drafts included (permission `pages.manage`; `/admin/pages` carries the same per item) |
| POST | `/admin/pages/path-preview` | `{ id?, locale?, slug }` | `{ path, reachable, reason, conflict, shadows, exposesParentSlug }` – the path a save would give, before saving (`pages.write`) |
| GET | `/admin/pages/tree` | – | `[{ id, parent, label, paths }]` – every page with its parent and valid paths per language (`pages.manage`) |
| POST | `/admin/paths/rebuild` | – | `{ indexed, conflicts }` – recomputes every page path from the stored pages; also runs after migrations (`pages.manage`) |
| GET | `/pages/:id` | `?locale=` | document (strict, no fallback) – published only, otherwise 404 |
| POST | `/pages` | fields (+ `locale`) | `{ …document, _events }` – the saved document plus `_events` reporting the triggered `publishPage` run (static delivery per language, then `llms.txt`), which happens after this response, not inside it; 400 with a field name on a validation error, e.g. `pages: hero references media/<id> which does not exist` or a slug whose path is reserved (`/media`) or starts with a language code; 409 when another page holds the path, naming path, language and occupant (`details.conflicts: [{ path, locale, type, id, label, moving }]`, `details.fields` on `slug` or `parent`); 400 on `parent` for a cycle, a missing parent or the home page; 400 when the save would move more than `maxCascade` (1000) paths |
| PATCH | `/pages/:id` | partial fields (+ `locale`) | `{ …document, _events }` as with POST |
| DELETE | `/pages/:id/translations/:locale` | – | `{ …document in the default language, _events }` – deletes only this translation, see below (`pages.write`) |
| DELETE | `/pages/:id` | – | `{ ok: true, _events }`; 409 if it still has subpages, or if other documents reference it, e.g. `pages/<id> is referenced by pages/<id2> (hero)` (no 409 on `PATCH`, only on `DELETE`) |

`sort` is a field name, a leading `-` means descending; an unknown field → 400 (`unknown sort field
…`). `limit` and `offset` must be integers (`limit` ≥ 1, `offset` ≥ 0); an invalid value or a
`limit` above the ceiling (`maxLimit` in the `content/default` config, default 200) → 400. Without
`limit`, the list returns at most `defaultLimit` items (`content/default` config, default `maxLimit`);
`total` counts every match, so page through with `offset`. Write calls need `pages.write`, deletion needs `pages.delete`
(deleting a single translation is a write, `pages.write`).

`GET /pages` and `GET /pages/:id` carry a fixed filter (`status=published`) in their step argument;
`_translations` on their response is narrowed to the languages that are themselves `published` too,
the same rule `GET /site/*path` follows — a language whose required fields are all present but is
itself a draft still reports `false`. `GET /admin/pages` and `GET /admin/pages/:id` carry no fixed
filter, so their `_translations` reports plain field completeness, every status included. A step
argument may never combine a fixed filter with `?fallback=true`; boot refuses it, naming the step.

**Deleting a translation.** `DELETE /pages/:id/translations/:locale` empties only that language:
all localized fields of that language become `null` and `_translations[locale]` becomes `false`;
non-localized fields are untouched. It answers 400 for an unknown language, 404 if the document or
translation is missing, and 409 (`… is the last translation – remove the document`) for the last
remaining translation — even the default language can be deleted as long as another one remains,
though its URL then answers 404. Afterwards `references.index`, `links.extract` and
`delivery.publish` (which removes the static file for that language) run, `llms.txt` is rewritten in
the background, and the event `page.translationRemoved` fires with the language in `params.locale`.

### Page revisions

Every `POST /pages` and `PATCH /pages/:id` records a full snapshot of what was saved, per language.
Restoring is a new save: it runs the same chain as `PATCH`, so validation, sanitizing, the reference
index, static delivery and `llms.txt` all behave exactly as on a normal edit — a restored page that
carries the status `published` is republished immediately, a draft is not. Listing and reading a
revision need `pages.manage`, restoring and labelling need `pages.write` (a restore *is* a write).

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/admin/pages/:id/revisions` | `?locale=&limit=&offset=` | `{ items: [Revision], total, head }` – newest first, without `snapshot`; `head` is the revision the next save will hang off (`pages.manage`) |
| GET | `/admin/pages/:id/revisions/:revisionId` | – | one `Revision` plus `snapshot` (the saved fields, `null` when the revision was skipped) and `restore` (see below); 404 for an unknown revision (`pages.manage`) |
| POST | `/admin/pages/:id/revisions/:revisionId/restore` | – | `{ …document, restore, _events }` – the shape `PATCH /pages/:id` returns plus `restore`; 404 for an unknown revision, 409 when the revision carries no snapshot, and every 400 a normal save can produce (`pages.write`); event `page.restored` |
| PATCH | `/admin/pages/:id/revisions/:revisionId` | `{ label: string \| null }` | the `Revision` – names a revision so retention keeps it forever; `null` or an empty string clears the name (`pages.write`) |

`Revision`: `{ id, collection, documentId, locale, parentId, createdAt, author: { id, name },
kind: "save" | "restore", label, status, live, bytes, skipped }`. `author.name` is the username at
save time, so a later rename does not rewrite history. **Both `author.id` and `author.name` can be
`null`**: that is the anonymous author a user deletion leaves behind, and a client has to render it
(e.g. as "deleted user") instead of assuming a name. `status` is the value of the document's
`status` field then, `live` says whether that counted as published.

**The tree.** `parentId` is the whole structure: a normal save points at the head, a save made by a
restore points at the restored revision — that is where the history forks. Switching to another
branch is the same gesture as going back: restore that branch's tip and save. There are no merges
(see the module README for why), and no separate branch id is needed to draw the tree.

**After a model change.** A restore does not fail because the content model moved on. `restore:
{ revisionId, dropped: string[], missing: string[] }` says what it could not carry over: `dropped`
are snapshot fields the model no longer has — the restore leaves them out of the write — and
`missing` are fields the model gained after the snapshot, which the restore cannot revert and leaves
at their current value. Both arrays are usually empty; the same object already comes with
`GET …/revisions/:revisionId`, so a UI can warn before restoring instead of after. Whatever lives
*inside* a field stays the validator's: a restored `body` whose blocks no longer match the schema
answers 400 with the validator's own problem list, and a block type that was removed is fixed by a
content migration, not by a restore.

**Retention.** A nightly cron keeps, per page and language, the newest 50 plus every revision that
was ever live, every labelled one, the head, every branch tip and every branch point; removed
revisions hand their children to their nearest surviving ancestor, so the chain never breaks. A
snapshot beyond 1 MiB is recorded as `skipped: true` without content — the save still succeeds, only
restoring that revision answers 409.

### Settings (single)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/settings` | `?locale=` | document; as long as it was never set: 200 with an empty document (every field `null`, `_translations` all `false`). If the step carries a fixed filter (`content.get:settings?status=published`), it also applies to the empty document → 404 |
| PUT | `/settings` | every field (+ `locale`) | `{ …document, _events }` – replaces the language entirely (`settings.write`) and emits `settings.updated`; every published page that shows the settings is re-rendered in the background, and `llms.txt` (its title/description come from this document) is rewritten after them |

`navigation` is checked against a JSON Schema: a list of `{ label, path, children? }`, both
non-empty strings, no other fields — otherwise 400 with path and reason
(`settings.navigation: /0 unexpected property "onclick"`). `label` is plain text, not HTML.

### Redirects (single)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/redirects` | – | document; as long as it was never set: 200 with an empty document (`redirects.read`) |
| PUT | `/redirects` | `{ rules: [{ from, to, status? }] }` | document, writes `redirects.json` to the blob store (`redirects.write`); 400 `redirects: Row N: …` on an invalid rule |
| GET | `/redirects.json` | – | `[{ from, pattern, target, status }]` – public, same content as the file in the blob store; editor rules first, then the automatic redirects of moved pages |
| GET | `/admin/redirects/auto` | – | `[{ from, to, type, docId, locale, seq }]` – automatic redirects in effect, sorted by `from` (`redirects.read`) |
| DELETE | `/admin/redirects/auto/*path` | – | removes the automatic redirect at that path (a later move of a page away from that path creates a new one) and rewrites `redirects.json` (`redirects.write`); 404 when there is none |

`from` uses `*` (one segment) / `**` (one or more segments), `to` is a path or an https URL with
`$1…`; `status` is 301 (default) | 302 | 307 | 308. List order = priority when several rules match.

An editor rule whose `to` is the source of an automatic redirect is rejected (`Row N: …`), and an
automatic redirect whose target an editor rule matches is left out of `redirects.json`.

`GET /redirects.json` is deliberately public: the rules are observable through browser behavior
anyway, `redirects.read` only protects the editor view.

## Media

Every file has exactly one public URL, `/media/<id>/<name>`, and the API returns it as `path` on
every item. `<name>` is fixed at upload — it never changes on rename or move — so a client never
builds a media URL from an id; it always reads `path` from the response.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/media` | `multipart/form-data`: repeatable `file` field, optional `folder`, optional `provenance` | one file or several, see below (`media.write`) |
| GET | `/media/folders` | – | `[{ folder, count }]` – every folder, including empty ones (persisted in `media_folders`) and implicit parent folders (the client builds the prefix tree; `folder` is a label). The root is not a folder: files without a folder don't create a `""` entry (`media.read`, signed in) |
| POST | `/media/folders` | `{ path }` | `{ folder, count }` – creates the folder (idempotent), including implicit parent folders (`media.write`); `count` is the number of files already there (0 for a new folder, otherwise the existing count) |
| PATCH | `/media/folders/*path` | `{ path }` | `{ folder, moved }` – renames or moves the folder; a metadata-only change: no blob moves, and no file's `path` changes (`media.write`); 404 if the folder doesn't exist, 409 on a target conflict |
| DELETE | `/media/folders/*path` | `?recursive=true` | `{ ok: true, removed, ids }` – deletes a folder (`media.delete`); 409 if it isn't empty (without `recursive`); 409 if one of the contained files is referenced (nothing gets deleted); `ids` lists the removed items, for a step after it (e.g. removing their image variants) |
| GET | `/media/trash` | `?q=&limit=&offset=&locale=` | `{ items, total }` – the trashed items, most recently trashed first; each item has the fields of `GET /media/:id` with `path: null`, plus `trashedAt` and `expiresAt` (`media.write`); no `variants[]`, since a trashed item's variants are not served |
| POST | `/media/trash` | `{ ids }` (1–200) | `{ ids, unchanged, skipped: [{ id, reason }] }` – moves the items to the trash (`media.delete`); `ids` lists every requested item that is in the trash afterwards, `unchanged` the ones among them that already were, and `reason` is `not_found`; raises `media.trashed` with `ids`. Sending the same request again after a failure is safe and withdraws the variants of every item in `ids`. A referenced item may be trashed: the server does not refuse it, so a client asks first (`GET /admin/references/to/media?ids=`) |
| POST | `/media/trash/folders/*path` | – | `{ path, ids, unchanged }` – moves every file in the folder and its subfolders to the trash, deletes failed and abandoned uploads in them and removes those folders (`media.delete`); an upload still under way keeps its folder listed until it ends; files of the subtree already in the trash are in `ids` too and listed in `unchanged`, so the same request can be repeated after a failure, also once the folder is gone; 404 if there is neither a folder nor a trashed file at the path; raises `media.trashed` |
| POST | `/media/trash/restore` | `{ ids }` (1–200) | `{ ids, unchanged, skipped, renamed: [{ id, from, to }] }` – brings the items back with the same `id`, `path`, folder and texts, and their variants (`media.write`); an item whose name was taken meanwhile comes back as `<stem>-<n>.<ext>` and is listed in `renamed`; `ids` lists every requested item that is in the library afterwards, `unchanged` the ones among them that already were, and `reason` is `not_found`; raises `media.restored` with `ids`. Sending the same request again after a failure is safe and serves the variants of every item in `ids` again |
| POST | `/media/trash/purge` | `{ ids }` (1–200) | `{ ids, skipped }` – deletes the trashed items for good, with their files and variants (`media.delete`); an item a page still references stays in the trash with `reason: "referenced"`, an id not in the trash is skipped as `not_trashed` or `not_found`; raises `media.deleted` with the deleted `ids` |
| POST | `/media/trash/empty` | – | `{ ids, skipped }` – like `/media/trash/purge` for every trashed item (`media.delete`) |
| GET | `/media` | `?folder=&recursive=true&q=&sort=&limit=&offset=` | `{ items, total }`; `folder` matches exactly, with `recursive=true` the exact subtree (`2026` → `2026` and `2026/…`, not `2026x` or `2026-alt`); `q` = substring match on `filename`, ignoring case; `sort` = `createdAt`, `filename`, `size`, a leading `-` = descending (default `-createdAt`); every item also carries `variants[]`, and for a signed-in caller `available`, see [Image variants](#image-variants). Without a signed-in caller and without `ids`, 401 (`UNAUTHENTICATED`) — anonymous callers read media by id only |
| GET | `/media?ids=a,b,c` | – | `{ items, total }` – exactly these items in the requested order (missing ones are skipped, max. 200); other parameters ignored; this form is anonymous |
| GET | `/media/:id` | `?locale=` | metadata incl. `path` (the file's one public URL), `updatedAt` (signed-in callers only), `width`/`height` (from the file header for PNG/JPEG/GIF/WebP, otherwise `null`), `alt`/`title`/`description` for the requested language (`null` if not set; default language `de`), `available` (signed-in callers only) and `variants[]` (see [Image variants](#image-variants)); anonymous, with the public fields |
| GET | `/media/:id/file` | – | raw bytes by id, with the `Content-Type` the file is published with (its stored `type/subtype` when listed, else `application/octet-stream`, see below), always `Cache-Control: no-store`; images (incl. sanitized SVG)/audio/video `inline`, otherwise `attachment`; header `X-Content-Provenance: ai|mixed|unknown` when `provenance.origin` ≠ `human` (`media.read`, `identifyUser`) |
| GET | `/media/:id/:name` | – | the file at its one public URL; `:name` must be the exact name it was uploaded under, else 404; `Cache-Control: public, max-age=31536000, immutable`; anonymous (`media.read`, `identifyUser`), and so open to every signed-in caller as well |
| GET | `/media/:id/variants/:file` | – | image variant, `:file` = `<size>.<ext>` (e.g. `thumb.webp`), see [Image variants](#image-variants); anonymous, like `/media/:id/:name` |
| PATCH | `/media/:id` | `{ filename?, folder?, provenance?, locale?, alt?, title?, description? }` | metadata (`media.write`); a metadata-only change: renaming or moving never touches the blob or `path`, 409 on a name clash within the folder (`details.field: "location"`); text fields apply to `locale` (body or query, default `de`), `null` or `""` clears that language's text; `updatedAt` advances on every PATCH |
| PUT | `/media/:id/framing` | `{ focus?, crops? }` | the media item like `GET /media/:id`, with its new `focus` and `framing`; replaces the item's focus and manual crops, see [Focus and crop](#focus-and-crop) (`media.write`); 400 for an invalid focus or crop, 404 for an unknown or trashed item and for one without variants (not an image, SVG, GIF) |
| DELETE | `/media/:id` | – | `{ ok: true }`; deletes for good, also a trashed item; removes the public copy (if configured), then the blob, then the row, then sweeps the item's files once more, so a retry after a partial failure completes; a failed blob delete now fails the request instead of only logging it; 409 if a page references it — via a `ref` field (`hero`) or via an internal link in a `json` field (a block tree, e.g. `body`), e.g. `media/<id> is referenced by pages/<id2> (hero)` (`media.delete`); also deletes every image variant of that item |

**POST `/media`.** The body is `multipart/form-data` with a repeatable `file` field (send several
for a multi-file upload), an optional `folder`, and an optional `provenance` (`human`/`ai`/`mixed`/
`unknown`, or `{ origin, tool?, model?, at? }`; applies to every file in the request; defaults to
`unknown` if omitted). A request with no `file` field answers 400. One request carries at most
`http.multipart.maxFiles` files (default 20) and `maxFields` other fields (default 100); one more
answers 413 before any file is stored, so a bulk upload is split over several requests.

A single file returns `{ id, path, filename, folder, contentType, size, createdAt, updatedAt,
provenance, width, height, alt, title, description }` (needs `media.write`) — no internal field
(`key`, `checksum`, `status`, the folder+filename uniqueness column) ever leaves the API. Several
files return `{ items: [...same shape...], errors: [{ filename, status, message }], ids }` — each
file is checked independently (type, size, a 409 on a name conflict), and one failed file doesn't
stop the rest (partial success still answers 200); `ids` lists only the newly stored items.

The blob key is `<prefix><id>/<name>` (the `media/` prefix is configurable and separates media from
replication snapshots, the site export and `redirects.json`), so on disk e.g.
`data/blobs/media/3f2e…-…/photo.jpg`. The declared content type must be exactly one media type
(`type/subtype`, optionally with `;` parameters, no comma); a list such as `image/png, text/html` or
an empty type answers 415 (`UNSUPPORTED`). Only the lower-cased `type/subtype` is stored, plus the
`charset` of a `text/*` type when it is a token (`IMAGE/PNG; x=1` is stored as `image/png`,
`text/plain; Charset=UTF-8` as `text/plain; charset=utf-8`); a static host that types by extension
picks its own charset. `<name>` is `filename` reduced to `[A-Za-z0-9_-]`, with
one extension, taken from that stored type and never from the uploaded name (`Photo 1.JPG` sent as
`image/jpeg` becomes `Photo-1.jpg`), so that a static host deriving `Content-Type` from the extension
serves the type the upload was checked as; a type outside the list in
`@michaelthielemann/kestrel-contracts/helpers/mediaType` becomes `.bin` (`x.html` sent as `image/x-foo` becomes
`x-html.bin`) and is published as `application/octet-stream`. `<name>` is fixed at upload and never
changes again — renaming the item only changes the display `filename`, never the key or `path`, and a
name stored as `.bin` stays `.bin` even once the list holds its type. The one exception is a name
whose file may no longer be published as the type its extension names, such as an unsanitized SVG
(below): it is published as `<name with - for every .>.bin`. The
same display name in the same folder answers 409 (`details: { collection: "media_items", field:
"location" }`; for multi-file uploads, as an entry in `errors` rather than an HTTP status) — the same
bytes again are idempotent, as described below.

Rules: allows `image/*` (including SVG) and `application/pdf`, forbids `text/html` (415,
`UNSUPPORTED`); max. 5 MB (413, `PAYLOAD_TOO_LARGE`). `allowedTypes`/`deniedTypes` entries are patterns
matched against the stored `type/subtype`, ignoring parameters and case: `*` and `*/*` match every
type, `type/*` every type of that top-level type, anything else the one type it names, and an entry
that is none of these matches nothing; a type is accepted when it matches an allowed entry and no
denied one (`mediaTypeMatches`/`mediaTypeAllowed` in `@michaelthielemann/kestrel-contracts/helpers/mediaType`,
for any client that checks a type before uploading). **SVG** is sanitized on upload
(`sanitize.svg` before `media.upload`): `script`, `style`, event handlers, `foreignObject`, `image`
and external `href`/`xlink:href` are removed, only internal references (`#id`) survive; the XML
prolog and comments are dropped; > 2 MB → 413 (`PAYLOAD_TOO_LARGE`), no `<svg>` root → 400
(`VALIDATION`). Sanitized SVGs are served `inline` on `GET /media/:id/file` and `GET /media/:id/:name`
(`http.inlineTypes: ["image/svg+xml"]`), every other non-image type remains `attachment`. The two
are linked: `image/svg+xml` in `http.inlineTypes` without a module that registers `sanitize.svg`
aborts boot, and so does `publicCopy` with SVG uploads allowed unless every pipeline that runs
`media.upload` runs `sanitize.svg` before it, with no step in between that writes the uploaded files.
Each stored SVG records whether its bytes passed `sanitize.svg` that way — `media.upload` knows it
from the pipeline it runs in, never from the request. Only such an SVG is stored as `<name>.svg` and
served as `image/svg+xml`, on `GET /media/:id/:name`, on `GET /media/:id/file` and in the public
copy. Every other SVG — one uploaded through a pipeline without `sanitize.svg` while `publicCopy` was
off, for instance — is served like a type outside the list, as `<name>.bin` with
`application/octet-stream`, and stays so after `publicCopy` and `sanitize.svg` are turned on; each
write of its public copy logs a warning naming its id. So an unsanitized SVG is never served inline,
neither here nor from the public copy. `folder` is a path label (`2026/press`), not
a directory: segments only `[A-Za-z0-9._-]`, separated by `/`, leading/trailing `/` are stripped,
`.`/`..` → 400. `filename` starts out as the public name (see above) and is sanitized on rename
(basename only, characters outside `[A-Za-z0-9._-]` → `-`, leading `.`/`-` stripped, empty → `file`)
— the response can differ from the value that was sent; the UI should adopt the response value.
Image URL in the frontend: the item's own `path` — never build one from an id. A page references a
medium via `hero: "<media-id>"`.
`alt`, `title` and `description` are plain text and are validated as such: at most 2000 characters,
no control characters other than tab and newline, otherwise 400
(`media/default: alt must be plain text (max 2000 chars)`). Nothing is sanitized here — an HTML
sanitizer would corrupt legitimate text such as `5 < 6`; the frontend escapes on output.
`GET /media?locale=en` and `?ids=…&locale=en` return the texts in that language.
`provenance` states who produced the file (`human`, `ai`, `mixed`, `unknown`) — the frontend should
visibly flag `ai`/`mixed` (EU AI Act Art. 50) and send the origin with every upload. Without one,
`{ origin: "unknown" }` is stored: a missing value is not proof that a human created the file. Rows
predating the field also read as `unknown`.

With `publicCopy` configured, `media-default` also keeps a copy of every ready original under
`<publicCopy.prefix><publicPath without its leading "/">/<id>/<name>` (e.g. `site/media/<id>/photo.jpg`
with the example instance's config) — the same tree `images-default` writes its variant copies into,
which is what a static export or a plain web server in front of the blob store serves directly, with
no backend involved. The copy is written by the request that makes the original visible (or, for a
variant, by the background job that places or renders it) and removed when the item is deleted; a
failed copy write fails that request like a failed blob write. Steps `media.syncPublic` and
`images.syncPublic` reconcile the copies with the stored items (used by an admin "repair public
media copies" action and a nightly cron); `media.reconcile` is unrelated and only ever looks at the
private blob prefix.

`media_items`'s internal uniqueness column (folder + display filename) means a name belongs to
exactly one item per folder: two uploads of the same name into the same folder at the same time end
as one item and one 409, never as two items sharing one name. Uploading is idempotent: same folder,
same filename and the same bytes (checksum) return the item that is already there, with 200 and its
original `id` and `createdAt` — no second item, no second blob, no second set of variants, and no
`media.uploaded` event (`media.upload` ends the pipeline itself, so the `events.emit:media.uploaded`
step after it does not run, see [pipelines.md](pipelines.md#event-data)). The same name with
*different* bytes stays a 409. Deleting an item removes its own copy and blob; nothing else shares
its id-based key.

Upload happens in phases: first the row with `status: "uploading"`, then the private blob, then (if
`publicCopy` is set) the public copy, then the row turns `ready`. If writing the blob fails, the row
stays at `status: "failed"` and the request answers with an error; a repeated upload of the same name
replaces that row (no lasting 409). Only `ready` items are visible: `GET /media` (including `?ids=`)
hides everything else, `GET /media/:id`, `GET /media/:id/file` and `GET /media/:id/:name` answer 404.
A reconciliation between the private blob store and `media_items` is available as the step
`media.reconcile` (`{ blobsWithoutRow, rowsWithoutBlob }`; with `delete: true`, blobs without a row
are deleted, rows never; a key counts as orphaned only when it has the shape `<prefix><id>/<name>`
and no item has that id, so variants stored under the same or a nested prefix are never touched); [`../examples/minimal`](../examples/minimal) doesn't wire up a route or a
cron for it yet.

No data migration: setup fails on start if a stored item's key is not `<prefix><id>/<name>`, naming
the first such item. A store from before this change must start empty.

**Trash.** `POST /media/trash` takes items out of the library without deleting them: `GET /media`
(also with `?ids=` and `?q=`) and the folder counts no longer list them, `GET /media/:id`,
`GET /media/:id/file`, `GET /media/:id/:name` and their variant URLs answer 404, `PATCH /media/:id`
answers 404, the public copies of the original and its variants are removed, and the item's name in
its folder is free for a new upload at once. Pages that show the item are re-rendered without it
(`media.trashed` marks them, as `media.deleted` does). `POST /media/trash/restore` undoes all of
that: same `id`, same `path` and variant URLs, same folder (recreated if it was removed), texts,
provenance and references; only when another upload took the name meanwhile does the display name
change, which the response reports in `renamed`. The pages are re-rendered with the item again
(`media.restored`). A page may still reference a trashed item, and `PATCH /pages/:id` accepts a new
reference to one, since the server counts it as existing until it is purged; the page renders
without it meanwhile.

The example instance keeps trashed items for 30 days (`trashRetentionDays` on `media-default`); a
cron at 04:00 (`purgeExpiredMedia`) then deletes the expired ones that nothing references, and
leaves the referenced ones in the trash. `DELETE /media/:id` and `DELETE /media/folders/*path` stay
the final deletes. A trashed file still takes up storage, and a copy a browser or CDN cached under
`immutable` is not withdrawn by the trash. Every request body with `ids` takes 1 to 200 ids (400
otherwise), and every answer is per id, so a client working through a larger selection sends it in
blocks and shows each skipped id with its reason. A purge that stopped halfway (the store failed
mid-delete) is finished by sending the same `POST /media/trash/purge` again.

## Image variants

For every ready image (not SVG or any other XML image type, not GIF), `images-default` keeps a WebP
variant per *effective size*, at `/media/<id>/variants/<size>.<ext>`. It learns about media only
through `media@1`, which `media-default` provides, so an upload still in flight or an item being
deleted gets no variants and `POST /admin/images/retry-failed` with its id answers 404. Its path,
dimensions and format are decided from the original
right after upload — before any variant is actually rendered — so the first render needs no
republish: until it lands, the path answers with the original's own bytes and type instead of the
resized image. Apart from a format change, which moves the size to a new path and retires the old
one, `variants[].path` changes only in its `?v=`, once a later render replaces bytes the path
already had (a re-crop, a changed size, a repair), and that marks the pages that show the item for
a re-render (see [Focus and crop](#focus-and-crop)). `available` on the media item (`false` while any size still lacks its path, `true` once every
size has one) is what an editor UI should gate insertion on; a page or an admin view can otherwise
link every `variants[]` entry from the very first read. Generation is caught up by a resumable sync
job if needed, and the item's variants are deleted only on request. The original is never modified.

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
| GET | `/admin/images/status` | – | status of all sizes, the sync job, orphaned sizes and failed variants, see below (`images.read`) |
| POST | `/admin/images/prune` | `{ sizes: [name] }` | deletes the variants (blob + row) for the named *orphaned* sizes; `{ sizes, variants }` (`images.manage`); 400 if a name is still declared or has no variants |
| POST | `/admin/images/retry-failed` | `{ id? }` | puts every variant that gave up back to `pending` with `attempts: 0` — all of them, or with `id` only that media item's — and does the work: for one item right away (`job: null`), for all of them by starting a sync job from the first media item; `{ variants, media, job }`, `{ variants: 0, media: 0, job: null }` when nothing had given up (`images.manage`); 404 for an `id` that is unknown or not ready |
| GET | `/media/:id/variants/:file` | – | variant image bytes; 404 only when `:file` is neither a size this item currently has nor a size it once had before a format change or a prune retired it, or the medium is unknown; otherwise, whenever no render is at that path yet — not planned, still pending, erroring, or permanently `failed` after `maxAttempts` tries — the original's own bytes and type are served instead, with header `x-kestrel-variant: original`; always `Cache-Control: no-store` (`media.read`, `identifyUser`) |

**GET `/admin/images/status`** returns `{ sizes: [{ …size, source, used, variants: { done, pending,
error, failed } }], job, orphaned: { sizes: [name], variants: n }, registrySeen, failed:
{ variants: n, recent: [{ mediaId, size, attempts, error, updatedAt }] } }` (needs `images.read`).

- `used`: registered in this process. Default sizes are still generated even though they're never
  marked `used`.
- `orphaned`: sizes that still have stored variants but that nothing currently declares.
- `registrySeen: false`: this process has never seen `register()` run, so `orphaned` reads as
  empty — there's no way yet to tell "no longer declared" apart from "not yet registered".
- `failed`: variants that gave up across all sizes, plus the twenty most recent failures with
  their last error text.

`GET /media/:id` and `GET /media` additionally return `available` and
`variants: [{ size, width, height, format, bytes, state, path, crop }]`; `path` is the public path
`/media/<id>/variants/<size>.<ext>`, followed by `?v=<token>` once a later render replaced bytes the
path already had, after a format change of a variant that rendered before, or once `images.syncPublic`
rewrote the variant's public copy at another byte size, with a token that path is never given again (the file name never carries the
query), and `width`/`height` are the planned dimensions, present in
every state, not only once the render is `done`. `crop` is the part of the original, after its EXIF
orientation, that the bytes of the last finished render at `path` show, `{ left, top, width, height }`
in pixels, or `null` for the whole image (an `inside` size), the centred cut of the size's ratio (up
to a pixel per edge), or a path without a finished render. Two `done` entries with the same aspect
ratio and an equal `crop` show the same picture, so a `srcset` combines only such entries; anonymous
callers do not receive `state` by default. The ratio test and the moments when the listing and the
bytes differ are in [Which variants show the same picture](../packages/images-default/README.md#which-variants-show-the-same-picture).
`variants[]` never lists a size whose path has no
object at all yet (still `planned`, internal to `images-default`) — every listed path always answers.
`available` is `false` for an eligible image with at least one such size still unplaced, `true`
otherwise (including for a non-image, an SVG or a GIF, which have no variants at all). A broken
original image only produces `state: "error"` (then `"failed"` after `maxAttempts`) on the affected
variant, whose path keeps answering with the original meanwhile — upload and sync keep running
unaffected. A cron job (every 5 minutes) calls `images.resume` and automatically continues a
paused/failed/stuck sync job and finishes any item a crash left mid-way, even without a manual
`POST /admin/images/sync`.

They also return `variantCounts: { done, pending, error, failed }`, the effective sizes tallied by
state: a size with no row yet, a row not yet placed, or a `done` row whose spec is outdated or
whose render was cut with another crop than the item's stored framing gives the size (a re-crop
under way, also one another process has not placed yet), counts as `pending`; a row for a size nobody declares any more is ignored. `variantCounts` is all zero for
an item with no eligible variants (not an image, SVG, GIF), the same as an empty `variants[]`. It
lets a client tell "no variants apply" apart from "still generating" without polling `variants[]`
itself.

A size whose format changes, and a size that is pruned, keep their old path answering with the
original's bytes until the item itself is deleted — nothing that ever linked the old path is left
with a dangling link, even without a republish.

A render that hangs is given up on after `renderTimeoutMs` (default 30000) and counts as a normal
failed attempt (`render timed out after <n>ms`); the render itself cannot be aborted, so it is left
to finish in the background and whatever it produces is dropped. After `maxAttempts` failures the
variant is `failed` and no longer retried — `POST /admin/images/retry-failed` is the way back.
There is deliberately no cancel for a running sync job: it holds nothing, writes one idempotent
variant at a time and stops at the end of the library; shutdown pauses it at its cursor.

Embedded hosts (without HTTP) register sizes at boot directly via the pipeline API:
`kestrel.run("registerImageSizesBoot", { trigger: { kind: "event", name: "boot" }, payload: { sizes } })`
— the pipeline `registerImageSizesBoot` consists only of `images.register` and has no HTTP trigger,
so it's reachable only via `kestrel.run`.

### Focus and crop

`GET /media/:id` and `GET /media` also return `focus`, a rectangle `{ x, y, w, h }` normalised to
0..1 on the image as displayed (after its EXIF orientation), or `null`; anonymous callers read it
too, so a page can set `object-position` from its centre. A signed-in caller also gets
`framing: { focus, crops, width, height, ratios: [{ key, sizes, manual, fits, crop }] }`: the manual
crops keyed by reduced aspect ratio (`"16:9"`), the original's width and height after its EXIF
orientation, which the rectangles and pixel cuts refer to (`null` until the item is planned), and per ratio of the `cover` sizes the names of its sizes, whether
a manual crop is set, whether the focus lies within the cut, and the cut in pixels
(`{ left, top, width, height }`, `null` for the centre, up to a pixel per edge).

`PUT /media/:id/framing` with `{ focus?, crops? }` replaces both; a field left out is empty, so `{}`
removes the framing. Only `cover` sizes are cut by it, from the manual crop of their ratio, else
around the focus, else from the centre; the example's default sizes are all `inside`, so with them a
framing changes no variant. A size whose cut changes renders again at the same path: until then its
path keeps answering with the old variant, afterwards `variants[].path` ends in `?v=<token>` and the
pages showing the item are marked for a re-render. A changed focus marks them at once, also when no
variant renders again. The token counts the variant's renders, so a crop set back, or a framing
reset to the centre, gets a new URL, not an earlier one. Ratio keys are exact, so a size of `1000x562`
gets a crop of its own, not the one of `"16:9"`. The `images-default` README, "Focus and crop", has
the rules, and `@michaelthielemann/kestrel-images-default/framing` computes the same cuts in the
browser.

## Static delivery (the second traffic light)

When a page is created or changed, `delivery-static` renders every language whose own `status` is
`published` through the site's renderer (`renderer@1`, a module the site brings) and stores the result in the blob store: `site/<slug>/index.html` (primary
language), `site/en/<slug>/index.html`, home page (`slug = home`) → `site/index.html` and
`site/en/index.html` respectively. Assets delivered by the renderer (`_assets/…`) land under
`site/_assets/…`. Languages that are no longer published are removed.

| Method | Path | Response |
|---|---|---|
| GET | `/admin/publish-status/pages/:id` | `[{ locale, state: live \| error \| draft, path, error, publishedAt, updatedAt, stale, staleSince, staleFailed, staleError, dependencies }]` (`pages.manage`) |
| POST | `/admin/publish-all/pages` | `{ documents, live, errors, redirects: { rules, skipped } }` – re-render everything, and afterwards also rewrite `redirects.json` and ask for an export of `sitemap.xml`, `robots.txt` and `llms.txt` (the pipeline chains `redirects.export` and `delivery.requestIndexes` onto `delivery.publishAll:pages`) (`pages.manage`) |

`state`: `live` = delivered, `draft` = not published in that language, `error` = rendering or saving
failed (`error` names the cause; the last `live` output stays in place).

A page is also re-rendered when something it shows changes, without being saved itself: each render
records what it read (with `renderer-plain`, the paths of the pages it links to; with a renderer that
reads through this instance, also the settings, the documents and media it shows), and
`pageDependents`, `settingsDependents` and `mediaDependents` mark the published pages that read what
changed. The example's background loop renders them after the response; `stale` says a page waits
for that, `staleFailed`/`staleError` that it failed `maxAttempts` times, `dependencies` how much its
last render recorded (`null`: unknown, re-rendered on every change). `resumeStalePages` (every five
minutes) picks up whatever a stopped process left marked. See the `delivery-static` README,
"Dependent outputs", for the queue wiring. The example instance uses
`renderer-plain` (an HTML skeleton) and the filesystem blob store (`data/blobs/site/`); in
production: the site's own renderer + `blobstore-s3`.

`delivery-static` no longer knows about media: it stores rendered output byte for byte, and never
reads `media_items` or `images_variants`. A page reaches a medium through the `path` the media API
already returned as data — the same URL on the export as on the live backend — so there is nothing
for `delivery-static` to rewrite, and no spelling (`&#x2F;`, a client-recomputed URL, …) can escape a
rewrite that no longer happens. `media-default` and `images-default` keep the export in sync
themselves: set `publicCopy` on both (see [Media](#media) and [Image variants](#image-variants)) to
`{ prefix: "site/" }` matching `delivery-static`'s own `prefix`, so every file anonymous visitors may
read lands under the same `site/` tree the pages do. `reservedPaths` (typically
`["/api", "/admin", "/media"]`) keeps `delivery-static` from ever writing a page or an asset under a
path the origin — or a media module's public copy — owns; a publish whose slug collides with a
reserved path fails with `state: "error"` instead of writing the file. Kestrel itself does not
reject the save for a colliding slug; a consumer that wants the collision rejected earlier validates
it itself before the document reaches `content.create`/`content.update`.

### sitemap.xml, robots.txt, llms.txt and llms-full.txt

`delivery-static` writes four files next to `redirects.json` in the blob store (`site/sitemap.xml`,
`site/robots.txt`, `site/llms.txt`, `site/llms-full.txt`); nginx serves them statically. No editor
request writes them: after a page save, a page delete, a settings change and `publishAllPages`,
`delivery.requestIndexes` asks for an export, which in the example instance the background loop runs
about a second later, before its next batch of re-renders. `delivery.resumeStale` asks again on every
run, so a lost or failed export is repaired by the next recovery pass. A failed export is logged and
retried and never fails a save; its outcome (`at`, `entries`, `error`, `skipped`) is part of
`delivery.readStaleStatus` as `exports`. `PUT /redirects` and `POST /admin/publish-all/pages`
answer with 503 if `redirects.json` could not be written.

The source is every row of the publish traffic light that serves a file — `live`, or `error` with a
path, since a failed render keeps its previous output online — for every type configured under
`types`: drafts are absent, and a language only appears once it is itself published. For each row,
the document is read; an empty `seo`/title field is filled from the default language only when the
default language is itself published, the same rule `GET /site/*path` and static delivery apply.
`seo.noindex === true` excludes the page from `sitemap.xml` and both llms files. While published
pages exist but none has a rendered output yet, `sitemap.xml` and `llms.txt` are left as they are.

`sitemap.xml`: one `<url>` per page with the absolute `<loc>` (`siteUrl` plus the path, `/` for the
home page and no trailing slash otherwise), `<lastmod>` from the document's `updatedAt` when the page
is `live`, and `hreflang` alternates plus `x-default` for a page published in several languages.
While no page is listed (every page `noindex`, or nothing published), `sitemap.xml` is removed and
`robots.txt` has no `Sitemap:` line. With `sitemap: false` or without `siteUrl` no sitemap is
written, and a `site/sitemap.xml` an earlier export wrote is removed; one the site placed itself is
left alone.

`robots.txt`: `User-agent: *`, then `Allow: /` or `Disallow: /` from `robots.policy` (without it:
`allow` when `NODE_ENV` is `production`, otherwise `disallow`, with a warning at boot), then the
lines of `robots.extra`, then a `Sitemap:` line when a sitemap is written. `robots: false` leaves
`site/robots.txt` alone. Crawlers only read the file at the root of the host, so a `siteUrl` with a
base path logs a warning at boot.

`llms.txt`: `# <settings.title>` (default language; empty → the host from `siteUrl`, otherwise
`Website`), a blockquote `> <settings.description>` (only if set), then a
`## <headings[type] ?? type>` section per type with
`- [<seo.title || title>](<siteUrl><path>): <seo.description>` per page, sorted by URL. Without
`siteUrl`, only paths appear in the file.

`llms-full.txt` only with `llms.full: true` (opt-in — this file bundles the entire site into one
document and reads every rendered page): per page `### <Title>`, `Source: <URL>`, the description,
then the stored HTML (`site/<path>/index.html`, which is why `full` requires the `html` format)
restricted to the `<main>` element and converted to Markdown with turndown (headings pushed three
levels deeper, root-relative links and images made absolute with the origin of `siteUrl`, `#`
anchors lose their link, `script`/`style`/`nav` chrome outside `<main>` is absent; without a
`<main>`, the whole `<body>`, logged). It is exported after the re-renders, since it reads their
HTML. If `full` is off, an `llms-full.txt` an earlier export wrote is deleted, and one the site
placed itself is left alone. If the HTML for a page is missing,
the page is included without a body and logged.

Config (`delivery-static`, everything optional):
```ts
siteUrl: "https://example.org",       // absolute base, a base path is kept; without it: paths, no sitemap
sitemap: true,                        // false: no sitemap.xml, and the one an earlier export wrote is removed
robots: { policy: "allow", extra: ["Disallow: /preview/"] }, // false: leave robots.txt alone
llms: {
  full: false,                        // write llms-full.txt
  settings: { type: "settings", titleField: "title", descriptionField: "description" },
  titleField: "title", seoField: "seo",
  headings: { pages: "Pages" },       // section heading per type, default = type name
}
```
Boot checks: `siteUrl` must be an absolute `http` or `https` URL without query or fragment; if
`settings.type` exists in the model, it must be a `single` type with `titleField` (if the type is
absent entirely, only the fallback heading is used); `full` requires `"html"` in `formats`. If
`seoField` or `descriptionField` is missing from the model, only the filter or the blockquote is
skipped, respectively.

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
| POST | `/admin/migrations/apply` | `{ dry?: true }` | applies pending migrations, or previews with `dry`, see below |

**POST `/admin/migrations/apply`** — body `{ dry?: true }`.

- Without `dry`: `{ applied: [LedgerEntry] }` (empty array if nothing was pending).
- With `dry: true`: `{ dry: true, changes: [{ id, documents }] }` — counts affected documents,
  including validation, but writes nothing.
- `409 CONFLICT` (`migrations: apply is running`) if a run is already in progress.
- `500 MIGRATION_FAILED` (`migrations: "<id>" failed on <collection>/<docId> locale <l>: <cause>`,
  with `details: { migration, document, locale?, problems? }`) on failure — documents already
  migrated stay migrated, and the ledger is unchanged.

For the UI: show the 500's error message verbatim (it names the migration, document and language);
offer "dry run" before "apply".

## Insights (admin, permission `insights.read`)

One view of the running instance for the admin's system page: what is wired (static) and how it
runs (live). Both routes need a login and `insights.read` (401 anonymous, 403 without the
permission; the example's `admin` role has `*`, `editor` does not). The manifest carries the
*effective* value of every config variable (`value`), so an admin UI can list what every module is
actually configured with — which is why both routes stay behind `insights.read` and why a secret
never leaves the process: a redacted variable answers `value: null, redacted: true`. The live
numbers are per process and start at zero on every boot — behind two instances each answers for
itself. `recentFailures` is a ring buffer of the last runs that ended with a status of 400 or
above (newest first, 50 by default, `recentFailures` in the module's config, `0` turns it off).
`message` is the same text the failing run returned to its caller, truncated at 500 characters;
an unexpected throw shows only `"<pipeline>/<step>: unexpected <ErrorName>"`, and a stack never
leaves the log. `warnings` carries the non-fatal conditions boot found (`BootWarning`, e.g. an
event trigger whose event no pipeline emits): `{ code, message, ...context }`, every context field
a string; a client must render a `code` it does not recognize generically. A boot warning never
influences readiness or `health()`.

| Method | Path | Response |
|---|---|---|
| GET | `/admin/insights/manifest` | `{ generatedAt, core: { version }, contracts: ["persistence@1", …], modules: [Module], steps: [Step], pipelines: [Pipeline], triggers: { http: [{ method, path, pipeline }], events: [{ event, pipeline }], crons: [{ expression, pipeline }] }, warnings: [BootWarning] }` — computed once at boot, `generatedAt` is the response time |
| GET | `/admin/insights/stats` | `{ generatedAt, process: { pid, startedAt, uptimeMs }, runs: { active, total, failed, errors }, pipelines: [{ name, count, failed, errors, p50Ms, p95Ms, lastAt }], steps: [{ pipeline, step, count, failed, errors, p50Ms, p95Ms }], events: [{ name, count, lastAt }], ratelimit: [], recentFailures: [{ at, runId, pipeline, trigger: { kind, name }, status, ms, code?, step?, message? }] }` |

`Module`: `{ name: "authn/multi", use: "@michaelthielemann/kestrel-authn-multi", version: string | null (null when the package cannot be resolved from the boot root, and for path entries), provides, requires, optional: ["<contract>@<major>"], config: { schema: JsonSchema, variables: [{ path: "bootstrap.passwordHash", type, required, default?, secret, set, status, source?, value, redacted }] }, steps: ["authn.login", …], eventHook: boolean, emits: ["migrations.applied"] (events the module emits from a contract method, `[]` for most modules) }`.
`type` is one of `string number integer boolean array object record enum union literal function unknown`. `required` is true only when neither the variable nor any of its ancestors is optional or
defaulted — `bootstrap.username` inside an optional `bootstrap` is *not* required, because leaving
`bootstrap` out is legal. `set` says whether the raw config carries the path itself; `status` is the
three-state version of it: `set` (same as `set: true`), `default` (the path is absent and the value
comes from the variable's own `.default()` or `.prefault()` or from an ancestor's — `default` then holds the effective
value, e.g. `archive.folder` → `"old_posts"` when `archive` is left out entirely) or `missing` (no
value at all). A parent that *is* spelled out in the config hands its children no default: only their
own `.default()` still applies. A parent left out whose `.default()` applies passes its value on as
written, so below it only what that value carries is `default` and every other child is `missing`,
even one with a `.default()` of its own; a `.prefault()` is parsed, so its children's own defaults
apply too.

When the module entry carries `defaults` (see [configuration](configuration.md#host-supplied-defaults)),
a path those values carry and `config` does not is `status: "default"` with `source` set to
`defaults.from`, and `default` holds the host's value; it takes precedence over the schema's own
default. `source` is absent on every other variable, including a path `config` sets over a host
default — that one is `set`, and its `default` still shows the host's value.

`value` is the effective value — what the config sets, otherwise the default, `null` when the status
is `missing`. It is a JSON snapshot, not the live object: a function, a class instance or a Buffer
becomes a type label (`"[function]"`, `"[URL]"`, `"[Buffer 4096 bytes]"`), a `Date` its ISO string, a
string longer than 200 characters is cut with `…[+n chars]`, an array beyond 20 items and an object
beyond 20 keys gain a `…[+n items]` / `"…": "[+n keys]"` marker, and nesting deeper than five levels
or a cycle reads `"[object]"` / `"[circular]"`. Filesystem paths are shown as they are.

`redacted: true` means the value is withheld and `value` is `null` (a `default` is left out too).
A variable is redacted when any of the following is true:

- its schema marks it secret (`writeOnly: true`, `format: "password"`, `x-secret: true` — which a
  zod `.describe("secret")` produces),
- its key name looks like a credential (`password`, `secret`, `token`, `credential(s)`,
  `authorization`, `passphrase`, `salt`, `dsn`, a connection string, or `key`/`keys` combined with
  `api`, `access`, `private`, `signing`, … — a bare `key` on its own is treated as an object name
  and stays visible),
- its value is a URL containing `user:password@`, or
- an ancestor field is redacted.

The same check runs everywhere a config value is emitted: in `value`, in `default` and in the
`default` of the JSON Schema. Anything the schema marks secret reads `"[redacted]"`, and so does
anything under a credential-like key or a URL with credentials. That covers object fields,
record values, array and tuple elements, and every member of a union or an intersection: a field
counts as secret when any member marks it. A `transform`, `preprocess` or `pipe` changes the value
so it can no longer be matched against the schema: when anything inside such a wrapper is secret,
the whole value reads `"[redacted]"` and the JSON Schema marks it `writeOnly`. `refine` and
`superRefine` keep the value and are looked through. The rows below such a wrapper, including every row of a
`configSchema` that is itself transformed, report the value as configured plus the declared
defaults instead of the transformed output. The JSON Schema leaves out the `default` of a
credential-like key. Its `enum` and `const` stay, because they are written by the module author,
not taken from config. Numbers and booleans are never redacted by name alone, so `minPasswordLength` keeps
its value.

A config that fails validation aborts the boot with `invalid config: <path>: <problem>`. For a
secret path, a path under a credential-like key or a path through a union or intersection, the
problem is only the validation code (`invalid_value`, `custom`, …). An enum mismatch names
only the expected values. Any other message is shown as the check wrote it, with URLs that carry
credentials replaced by `"[redacted]"`; a message a module author writes should not repeat the
value it rejects.
`Step`: `{ name: "content.list", module: "content/default", factory: boolean, description: StepDescription }` — a factory step's description is evaluated with the placeholder argument `<arg>`; a `describe()` that throws for it stops the boot, so the field is never `null`.
`Pipeline`: `{ name, steps: [{ spec: "content.list:pages", name: "content.list", module, description: StepDescription }] }` with the real arguments. `StepDescription` is the module's `describe()` entry: `summary`, `reads`, `writes`, `input`/`output`/`query` (JSON Schema), `errors`, `security`, `multipart`, `binary`.
Stats: `failed` counts every run or step whose outcome is not ok — 4xx included, so a 401 on `/me` is a failed run; `errors` is the 5xx share of that (thrown steps, `INTERNAL`, `TRANSIENT`). `p50Ms`/`p95Ms` are nearest-rank percentiles over the last 1000 samples per key, `count`/`failed` are unbounded. `step` in `steps` is the spec as written in the pipeline (`authz.require:pages.read`). `events` counts event-triggered runs per event name — an event nobody listens to is invisible. `ratelimit` is always `[]` in this release (no ratelimit contract exists yet); the field stays so a client can render it later.

## Admin

| Method | Path | Response |
|---|---|---|
| GET | `/admin/content/model` | `{ locales, defaultLocale, types: { [name]: { kind, fields: { [field]: type \| { type, required?, unique?, localized?, options?, to? } }, completeWhen? } } }` – the parsed `content-default` config, every logged-in user (no permission beyond the session); the host builds its admin schema from it |
| POST | `/admin/media/export` | `{ written, skipped, missing, conflicts }` – copies every medium to `data/export/<folder>/<filename>` (a readable layout for external tools; matches the blob keys without their `media/` prefix; name collisions → `-2`, `-3`; unchanged files are skipped) (`media.manage`); afterwards also exports every finished image variant to `data/export/<folder>/<filename>.<size>.<ext>` and adds `variants: { written, skipped }` to the response — the media counters are unaffected |
| GET | `/admin/references/broken` | `[{ fromType, fromId, field, locale, toTarget, toId, via, broken, checkedAt }]` – `via` names the origin: `"field"` (a `ref` field) or `"body"` (an internal link in a `json` field) (`pages.manage`) |
| POST | `/admin/references/rebuild` | `{ documents, entries }` (`pages.manage`) |
| GET | `/admin/references/to/pages/:id`, `/admin/references/to/media/:id` | `[{ type, field, id, via }]` – documents that reference the target (`pages.manage`, also for the media endpoint; for delete dialogs; empty = safe to delete); `via: "field" \| "body"`, a document can reference via both origins and then appears twice |
| GET | `/admin/references/to/pages?ids=a,b,c`, `/admin/references/to/media?ids=a,b,c` | `{ [id]: [{ type, field, id, via }] }` – batch variant of the route above, max. 200 ids, comma-separated; missing or empty `ids`, or more than 200 → 400 (`pages.manage`) |
| GET | `/admin/links/broken` | `[{ url, fromType, fromId, field, locale, ok, status, error, checkedAt }]` – external links that failed the nightly check (`?type=pages` filters) (`pages.manage`) |
| POST | `/admin/links/rebuild` | `{ documents, entries }` (`pages.manage`) |

### Event queue

The example instance runs `events-direct` for inline delivery, so it wires no queue routes. A
deployment that swaps in `events-queue` (next to `events-inmemory`, never in place of it) gets
four admin steps to put behind triggers of its own; the paths below are a suggestion, the step
names and response shapes are not.

| Suggested route | Step | Response |
|---|---|---|
| GET `/admin/events/status` | `events.readQueueStatus` | `{ pending, running, dead, done24h, oldestPendingAt, worker: { running, lastTickAt } }` – queue counters and the worker of this process |
| GET `/admin/events/dead` | `events.listDead` | `{ items: [{ id, name, pipeline, attempts, error, createdAt, availableAt }] }` – most recently failed first (`?limit`, max 500) |
| POST `/admin/events/retry` | `events.retryDead:all` | `{ retried }` – requeues every dead-letter event with `attempts` reset |
| POST `/admin/events/dead/:id/retry` | `events.retryDead:one` | `{ retried: 1 }` – requeues one; 404 when there is no dead event with that id |

### Event delivery status

`events.readDeliveryStatus` is on both delivery modules, so a consumer wires one route regardless
of which one runs; `examples/minimal` puts it at `GET /admin/events/delivery`
(`system.manage`). It answers `{ dead, scope, since, lastDeadAt }`: the deliveries the module gave
up on. With `events-queue`, `scope` is `"store"` — the dead-letter count across every process, the
same number as `events.readQueueStatus.dead`, `since` is `null`. With `events-direct`, `scope` is
`"process"` — the failed deliveries of the process that answers, counted since it started at
`since`; another process of the same site has its own count, and a restart starts at 0. Neither
number reaches `health()`, `http.healthPath` or a host's readiness probe.

## Personal data

Page content belongs to the operator and is not personal data about the editor. What is personal is
the *reference*: who wrote something and who was logged in when.

| Where | What is stored | How it disappears |
|---|---|---|
| `authn_users` | username, scrypt password hash, roles, active, createdAt | `DELETE /users/:id` removes the row for good |
| `authn_sessions` | session token, user id, expiry | deleted with the user, on logout, on a role or password change, and by the hourly cleanup cron |
| `revisions_entries` | `author: { id, name }` per revision — the username as a snapshot of that moment | the `user.deleted` event moves every revision to `reassignTo` or anonymises it to `{ id: null, name: null }`; snapshots, count and order stay untouched |
| `audit_entries` | `identityId` (who acted) and route params (which may carry a user id) per login and logout | the same event anonymises them — `identityId` becomes `null`, params naming that user are dropped, event and time remain — and `audit.prune` deletes everything older than `retentionDays` (365 in this instance) via the nightly cron |
| Log lines | run id, pipeline, step, duration, status | the process's logs, never stored by Kestrel itself |

Nothing else carries a user reference: page documents, media items, the reference and link indexes,
delivery status and revision *snapshots* hold no user id. Tokens and password hashes never leave the
backend, and neither ever appears in an event payload.

**How a deletion runs.** `DELETE /users/:id` deletes the user and their sessions and emits
`user.deleted` with `{ eventId, event, at, runId, identity, params, id, result: { ok: true,
reassignTo: { id, name } | null } }` — ids and the target's username snapshot, no secrets. Two
pipelines listen to it: one runs `authn.verifyUser:result.reassignTo` then
`revisions.reassignAuthor`, the other `audit.anonymize`. The audit log is only ever anonymised,
never reassigned: a login belongs to nobody else.

**Both reassignment routes run `authn.verifyUser` first, each reading its own path.**
`authn.verifyUser` is a factory step: `authn.verifyUser:reassignTo` reads `payload.reassignTo` (the
manual retry route's request body), `authn.verifyUser:result.reassignTo` reads
`payload.result.reassignTo` (the event above). Neither falls back to the other. Either one confirms
the target exists and is active, then writes the canonical `{ id, name }` to `verifiedUser`, which
`revisions.reassignAuthor` requires: it declares `reads: ["verifiedUser"]`, not optional, so a
pipeline that runs it without a preceding `authn.verifyUser` fails to boot — an unknown or inactive
id can never reach a revision unverified. `authn.verifyUser` does not check who is calling, so the
manual route also runs `authn.requireUser` and `authz.require:users.manage` first. Verifying a user
reference this way needs a real user store, so it only works with `authn-multi`; `authn-single`'s
one fixed admin has no second user to reassign to.

**When one of them fails.** Each listener is a run of its own, so a failure shows up in
`GET /admin/insights/stats` under `recentFailures` with the pipeline, step and message. Both steps
are idempotent, so repeating them is safe: `POST /admin/users/:id/revisions/reassign` with
`{ "reassignTo": "<id>" }` (or `null` to anonymise) and `POST /admin/users/:id/audit/anonymize`,
both with `users.manage`. A repeat that finds nothing left to change answers `revisions: 0` or
`entries: 0`.

## What the frontend does not need to do

- Language fallback logic for `/site/*` (the backend handles it, transparently via `_locales`).
- Check path uniqueness, required fields, reference existence — the backend answers with 400 or 409
  and a field name; client-side validation is UX only.
- Build page URLs from slugs — `_paths` and `_links` carry them.
- Refresh the token — there is no refresh; log in again after a 401.

## What a site provides for delivery

A Kestrel module (step-only or a contract module) that fulfills `renderer@1`:

```ts
interface Renderer {
  formats(): string[];                                   // e.g. ["html"] or ["html", "pdf"]
  render(input: { type, id, locale?, path, format, document }): Promise<Result<{
    data: Uint8Array | string; contentType: string; extension: string;
    assets?: Array<{ path: string; data: Uint8Array | string; contentType: string }>;   // scripts, CSS – for hydration
  }, RendererError>>;
}
```

`path` is the page's eventual path (`/en/kontakt`), `document` the resolved document (with
fallback). The contract test `@michaelthielemann/kestrel-contracts/renderer.contract.test` must
pass. How rendering happens (Nitro `localFetch`, `renderToString`) is up to that module.

## Not in this instance

Registration, password reset, on-demand image sizing (beyond the configured named variants),
search, versioning.
