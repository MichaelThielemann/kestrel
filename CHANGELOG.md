# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 1.7.0 are documented by their tags and commit history.

## [4.0.0] — 2026-08-21

Every `/api/` endpoint is now a **pipeline** — a named, declarative step list fronted by structurally
enforced `access`/`csrf`/`ipAllowlist` gates. The CRUD engine, login/logout, media upload, publish/preview
and every extension route are all pipelines now; `server/api/` holds exactly one route file. See
[docs/internals/decisions.md](docs/internals/decisions.md) (ADR-0010) for the full design and
[docs/guide/extending.md](docs/guide/extending.md) for the how-to.

> ### ⚠ Breaking — URL scheme (verb-in-path)
>
> Every REST-shaped route is replaced by **`/api/<collection>/<pipelineName>[/<id>]`** — `GET` for a read
> pipeline, `POST` for a write. The pipeline name is now the one identity a route, a trace entry, an
> after-step registration and an admin action all share.
>
> | Old | New |
> | --- | --- |
> | `GET /api/<c>` | `GET /api/<c>/readMany` |
> | `GET /api/<c>` (singleton) | `GET /api/<c>/readOne` |
> | `GET /api/<c>/<id>` | `GET /api/<c>/readOne/<id>` |
> | `POST /api/<c>` | `POST /api/<c>/createOne` (still 201) |
> | `PATCH /api/<c>/<id>` | `POST /api/<c>/updateOne/<id>` |
> | `PUT /api/<c>` | `POST /api/<c>/updateOne` |
> | `DELETE /api/<c>/<id>` | `POST /api/<c>/deleteOne/<id>` |
> | `POST /api/<c>/bulk {action:'delete'}` | `POST /api/<c>/deleteMany {ids}` |
> | `POST /api/<c>/bulk {action:'publish'\|'unpublish'}` | `POST /api/<c>/updateMany {ids, patch:{status}}` |
> | `POST /api/<c>/bulk {action:'duplicate'}` | `POST /api/<c>/duplicate {ids}` (answers the created rows) |
> | `GET /api/<c>/<id>/translations` | `GET /api/<c>/translations/<id>` |
> | `GET /api/<c>/<id>/dead-refs` | `GET /api/<c>/deadRefs/<id>` |
> | `GET /api/collections/<name>` | `GET /api/<c>/schema` |
> | `GET /api/references/broken` | `GET /api/brokenRefs` |
> | `GET /api/references/referrers?collection=X` | `GET /api/X/referrers` |
> | `POST /api/auth/login` | `POST /api/login` |
> | `POST /api/auth/logout` | `POST /api/logout` |
> | `GET /api/auth/session` | `GET /api/session` |
> | `POST /api/preview` | `POST /api/createPreview` |
> | `GET /api/publish-status` | `GET /api/publishStatus` |
> | `GET /api/links/resolve` | `GET /api/resolveLinks` |
> | `GET /api/media` | `GET /api/media/readMany` |
> | `GET /api/media/<id>` | `GET /api/media/readOne/<id>` |
> | `POST /api/media` | `POST /api/media/upload` |
> | `PATCH /api/media/<id>` | `POST /api/media/updateAsset/<id>` |
> | `DELETE /api/media/<id>` | `POST /api/media/deleteAsset/<id>` |
> | `GET /api/media/<id>/usages` | `GET /api/media/usages/<id>` |
>
> Unchanged: `GET /api/<c>/options`, `GET /api/<c>/translations?group=`, `GET /api/collections`,
> `GET /api/blocks`, `GET /api/route`, `GET /api/preview`, `POST /api/publish`,
> `GET /api/media/{library,resolve,folders,backfill}` and the media `move`/`copy`/`rename`/`delete`
> per-id routes, sitemap/robots/llms.
>
> **Old → new URL map (4.0 break).** `GET /api/<c>` → `GET /api/<c>/readMany` ·
> `GET /api/<c>/<id>` → `GET /api/<c>/readOne/<id>` · `POST /api/<c>` → `POST /api/<c>/createOne` ·
> `PATCH /api/<c>/<id>` → `POST /api/<c>/updateOne/<id>` · `PUT /api/<c>` → `POST /api/<c>/updateOne` ·
> `DELETE /api/<c>/<id>` → `POST /api/<c>/deleteOne/<id>` ·
> `POST /api/<c>/bulk {action:'delete'}` → `POST /api/<c>/deleteMany {ids}` ·
> `{action:'publish'|'unpublish'}` → `POST /api/<c>/updateMany {ids, patch:{status}}` ·
> `{action:'duplicate'}` → `POST /api/<c>/duplicate {ids}` · `GET /api/<c>/options` unchanged ·
> `GET /api/<c>/translations?group=` unchanged · `GET /api/<c>/<id>/translations` →
> `GET /api/<c>/translations/<id>` · `GET /api/<c>/<id>/dead-refs` → `GET /api/<c>/deadRefs/<id>` ·
> `GET /api/collections/<name>` → `GET /api/<c>/schema` ·
> `GET /api/references/referrers?collection=X` → `GET /api/X/referrers` ·
> `GET /api/references/broken` → `GET /api/brokenRefs` · `POST /api/auth/login` → `POST /api/login` ·
> `POST /api/auth/logout` → `POST /api/logout` · `GET /api/auth/session` → `GET /api/session` ·
> `POST /api/preview` → `POST /api/createPreview` · `GET /api/publish-status` → `GET /api/publishStatus` ·
> `GET /api/links/resolve` → `GET /api/resolveLinks` · `GET /api/media` → `GET /api/media/readMany` ·
> `GET /api/media/<id>` → `GET /api/media/readOne/<id>` · `POST /api/media` → `POST /api/media/upload` ·
> `PATCH /api/media/<id>` → `POST /api/media/updateAsset/<id>` · `DELETE /api/media/<id>` →
> `POST /api/media/deleteAsset/<id>` · `GET /api/media/<id>/usages` → `GET /api/media/usages/<id>`.
> Unchanged: `GET /api/collections`, `GET /api/blocks`, `GET /api/route`, `GET /api/preview`,
> `POST /api/publish`, `GET /api/media/{library,resolve,folders,backfill}`, the media
> `move`/`copy`/`rename`/`delete` per-id routes, sitemap/robots/llms.
>
> **Action required:** update every client that calls the API directly (custom admin code, scripts,
> integrations) to the new grammar. The admin UI itself needs no change — it already goes through
> `useCollectionOps`/`useMediaLibrary`, which were migrated with this release.
>
> ### ⚠ Breaking — batch actions
>
> The single `POST /api/<c>/bulk {action, ids}` envelope is gone. Each action is now its own pipeline
> (`deleteMany`, `updateMany`, `duplicate` — see table above); `core/app/utils/bulk-actions.ts`'s action
> allow-list is removed along with it.
>
> ### ⚠ Breaking — write-event/write-effect buses removed
>
> `registerWriteListener` and `registerWriteEffect` are gone. Register a named **after-step** instead —
> `registerAfterStep({ step, critical, ops?, on? })`, auto-imported from `server/utils/after-steps.ts`
> exactly where the old functions were. `critical: false` is what a write listener used to be (logged,
> save stays green); `critical: true` is what a write effect used to be (a failure becomes the response).
> Unlike a bus subscription, every after-step is named and appears in `?debug=pipeline` and
> `GET /api/_pipelines`.

### Added

- The **pipeline engine** (`layers/core/server/pipeline/`) — `definePipeline`, a step-composition
  registry with anchor-based patching (`before`/`after`/`replace`), sealed steps (`unsafeReplace` to
  override), a checked synchronous critical section (`assertUnique → persist` can never contain an
  `await`), and declarative `access`/`csrf`/`ipAllowlist` gates evaluated once, before step 1.
- **Traceability.** `GET /api/_pipelines` (admin-only) statically lists every routable pipeline — route,
  gates, every step and after-step, composed live from the registry. `?debug=pipeline` embeds a run's
  trace (`$pipeline`) into the response for an admin caller. A one-line dev-mode log
  (`[kestrel] pipeline <collection>/<op> step=Xms ... total=Yms`) covers every run, including a failed one.
- **Schema-driven admin actions.** A custom write pipeline's `ui: { kind?, label?, icon?, confirm? }`
  surfaces it in the collection list — a bulk-bar button, a row action, or both — with no admin-side code.
- Reads are pipelines too: `readOne`/`readMany` compose from named steps (`parseQuery`/`fetch`/`populate`/
  `attachMeta`), so a consumer's own custom read gets the same patching and access-declaration machinery a
  write does.
- `login`/`logout` are now ordinary pipelines (`layers/auth/server/pipelines/auth.ts`), registered the same
  way a consumer's own extension would register one.

### Changed

- `layers/core/server/utils/crud.ts`'s `create`/`update`/`remove`/`list`/`getOne`/`getSingleton` are now
  thin delegates over the pipeline engine (`runWrite`/`runRead`) — behavior is unchanged for a
  zero-config project (no `definePipeline` anywhere behaves exactly like 3.x's CRUD).
- The access-guard middleware (`layers/access/server/middleware/access-guard.ts`) shrank to 21 lines:
  resolve the principal, default-deny anything no pipeline claims, refresh the session. Authorization for
  every pipeline-claimed path now lives on that pipeline's own `access`/`csrf`/`ipAllowlist` declaration.
- `publicReadableResources()` (the anonymous-read set the sitemap and the relation populator consult) is
  now derived directly from read pipelines' `access` declarations — one statement of public reachability,
  not a separate `pageLike` derivation.

### Removed

- `registerWriteListener`, `registerWriteEffect`, and the two event buses behind them — replaced by
  `registerAfterStep` (see Breaking, above).
- `requireAdmin`, `evaluateAccess`, `resourceForPath`, `isBootstrapPath`, `isPublicRenderPath` — the
  route-level authorization helpers a pipeline's `access` gate now replaces.
- `core/app/utils/bulk-actions.ts` — its action allow-list was the wire contract of the deleted
  `POST /api/<c>/bulk` envelope.

### Documentation

- The hand-written docs are split by audience: [`docs/guide/`](docs/guide/README.md) for people building
  a site with the package (one page per feature area, a configuration reference, a deployment page and a
  troubleshooting page) and [`docs/internals/`](docs/internals/README.md) for people developing Kestrel
  (architecture, layers and packages, the pipeline engine, extension points, test rails, releasing, the
  ADR log). The old flat `docs/*.md` files and `docs/engineering/` are gone; links into them now point at
  the new pages.
- A `docs-hygiene` architecture test checks every relative link and anchor across the docs and keeps
  internal working vocabulary and source paths out of the consumer guide.

## [3.0.1] — 2026-08-19

### Fixed

- A consumer's global SCSS no longer breaks the build. Vite prepends
  `css.preprocessorOptions.scss.additionalData` to *every* SCSS entry — the `<style lang="scss">` blocks
  Kestrel ships included — so a design-system module forwarded `as *` lands in their global scope too.
  Kestrel's stylesheets resolved their own mixins globally as well, which made a shared name ambiguous and
  failed thirteen components with `This mixin is available from multiple global modules`; `focus-ring`,
  `sr-only` and `input-base` are exactly the names a consumer's own system tends to define. Every shipped
  stylesheet now reaches its members through the module namespace (`@include mixins.focus-ring`), so no
  name a consumer injects can collide. The emitted CSS is unchanged. Projects that worked around this with
  a `filename.includes('node_modules')` guard in `additionalData` no longer need it on Kestrel's account.

## [3.0.0] — 2026-08-19

Every component Kestrel ships moves into a `Kestrel` namespace, so a consumer project can no longer
replace an admin component by accident — and gets one deliberate way to replace one on purpose.

> ### ⚠ Breaking — component names
>
> A project whose own design system followed the conventional `app/components/ui/` layout was silently
> overriding Kestrel's admin components: `app/components/ui/Icon.vue` and Kestrel's own resolved to the
> same global name `UiIcon`, and Nuxt gives the consumer's app directory the higher priority. The admin
> broke with no error.
>
> **Every shipped component is now prefixed:** `UiButton` → `KestrelUiButton`, `FieldText` →
> `KestrelFieldText`, `CollectionList` → `KestrelCollectionList`, `MediaGrid` → `KestrelMediaGrid`.
> Components that already carried the prefix keep their exact name — `KestrelImg`, `KestrelLink` and
> `KestrelPreviewBridge` are unchanged, as is the `Blocks*` namespace for your own block components.
>
> **Action required** only if you referenced a Kestrel component in your own templates: add the prefix.
> Two consumer-visible names change beyond that rule — `BlockRenderer` → `KestrelBlockRenderer` and
> `MediaImage` → `KestrelMediaImage` (the latter appears in the starter's `Hero.vue`; it remains demo
> scaffolding rather than supported surface).
>
> **Your own component names are now yours alone.** `UiButton`, `UiIcon` and every other generic name
> are free for your site to use.

### Added

- `app/Kestrel/components/` — the one supported way to replace a shipped admin component. A file there
  mirroring Kestrel's own path (`app/Kestrel/components/ui/Button.vue`) outranks the layer's; anywhere
  else loses. Documented in [docs/guide/collections.md](docs/guide/collections.md).
- [docs/guide/field-types.md](docs/guide/field-types.md) — a reference for all twelve built-in field types: every
  option, the column it becomes, and whether the server enforces it or it only configures the widget.
  Covers what was previously undocumented, including the `json` type, `text.multiline`,
  `number.decimals`/`unit`, `datetime.precision`/`range`, `choice.display`, `link.types`,
  `media.accept` and `relation.labelField`.

### Removed

- `translatable` on a **field**. It was accepted, serialized to the admin and read by nothing — present
  since the first public release without ever taking effect. Per-locale content is, and remains,
  `translatable` on the **collection**. Setting it on a field is now a type error rather than a silent
  no-op; delete the line. Sharing a single field across a collection's locales was never implemented and
  is tracked separately.

### Changed

- Kestrel's component directories are registered with an explicit priority above the consumer's app
  directory, so a name inside the `Kestrel` namespace cannot be claimed from outside the override seam.
## [2.1.0] — 2026-08-14

Three additive, independently opt-in features. Nothing was removed and no API changed, but two new
migrations mean an existing project needs a `db:migrate` before it boots — see the note at the end.

### Added

- **CMS-managed redirects.** A built-in **Redirects** singleton lets editors keep a prioritised list of
  `from → to` rules (`*` = one path segment, `**` = one or more, `$1`/`$2` for the captures; 301/302/307/
  308). Saving compiles them and publishes `redirects.json` at the output driver's root — decoupled from
  the publish cycle, so a redirect goes live without a full republish (where the output target is what the
  site is served from: `output.auto: true`, or `auto: false` + `driver: 's3'`). Kestrel serves no
  redirects itself; an edge (NGINX/njs, CloudFront) reads the artifact. If the write fails, the save fails
  and says the artifact is stale. See [docs/guide/redirects.md](docs/guide/redirects.md)
  and [ADR-0009](docs/internals/decisions.md).
- **`CollectionDef.validate`** — whole-record, pre-write validation for what a per-field Zod validator
  cannot see (it only ever sees one field's value). Issues are keyed by field, so they land on the field
  in the editor like any other 400.
- **Structured data for search and answer engines.** Every page now carries a schema.org JSON-LD graph
  (`WebSite` + `WebPage`/`Article` + `BreadcrumbList`) alongside the canonical / Open Graph / hreflang tags
  it already emitted — unconditional, because it only restates what the page head already says. Two extras
  are **opt-in**, since each publishes something the site did not publish before: `seo.articleMeta`
  (`KESTREL_SEO_ARTICLE_META`) offers editors author / publication date / keywords and promotes the page's
  node to `Article`, and `seo.llmsFull` (`KESTREL_SEO_LLMS_FULL`) serves and publishes `/llms-full.txt`,
  every published, indexable page's full body as Markdown in one document. `noindex` removes a page from
  all of it consistently. See [docs/guide/seo.md](docs/guide/seo.md).
- **EU AI Act (Art. 50) disclosure on media assets** — opt-in via `aiDisclosure.enabled`
  (`KESTREL_AI_DISCLOSURE`), off by default. Two nullable columns (`aiSourceType`, `aiNote`) record how an
  asset was produced; with the flag on, the media viewer gains the controls and each upload is scanned for
  AI-origin signals (IPTC/XMP `DigitalSourceType`, C2PA presence, generator `Software` tags, PNG prompt
  chunks), quoted into `aiNote` — never into `aiSourceType`, which stays a human decision, and never over
  text a person wrote. Kestrel stores and manages this metadata only: it burns in no watermark, signs no
  C2PA manifest, and emits nothing into public output on its own. `ResolvedMedia.aiDisclosure` is always
  resolved, so turning the flag back off keeps existing data. `<KestrelImg ai-badge>` renders an optional,
  deliberately unstyled badge. See
  [docs/guide/ai-disclosure.md](docs/guide/ai-disclosure.md).

### Fixed

- A `choice` field's per-language labels (`{ en, de }`) rendered as a raw JSON blob instead of the label
  for the active admin language — in the editor's select and button group (visible on the built-in `site`
  collection's "Base title position") and in a list view's filter dropdown.
- An error banner in the editor could come up empty behind an HTTP/2 proxy: `statusMessage` was read from
  the response's reason phrase, which HTTP/2 does not carry. It is now read from the error body.

> **Action required: run `db:migrate`.** The `redirects` table is new, and `media` gains the nullable
> `ai_source_type` / `ai_note` columns. Both changes are additive and non-destructive, so a plain migrate
> applies them; an unset value behaves exactly as before, and nothing else changes for an existing project.

## [2.0.0] — 2026-08-14

The major is for one behaviour, not for an API break: **saving a record no longer publishes it**. Nothing
was removed and no consumer code has to change, but the moment content reaches the live site moved, and a
project that relied on the old timing must say so explicitly (`output.publishOnSave: true`). Everything
else in this release — the richtext fixes below — would have been 1.8.0; it never shipped.

> ### ⚠ Breaking behaviour change — read before upgrading
>
> **Saving a record no longer puts it on the live site.** No API was removed and nothing fails to build,
> but the moment content becomes public moved: it is now an explicit **Publish**, not a side effect of
> Save. An existing project upgrades without any code change and keeps working — editors simply have to
> press Publish (or the bulk Publish action) for a change to reach the static output.
>
> **Action required, per project, if you want the old behaviour:** set `output.publishOnSave: true` in
> `kestrel.config.ts` (or `KESTREL_OUTPUT_PUBLISH_ON_SAVE=1`). That restores the 1.x behaviour exactly — every write
> republishes, the Publish button disappears, and a full publish holds nothing back.
>
> **Unaffected:** unpublishing and deleting still take a page down immediately, `nuxt generate` still
> builds the whole site from the current DB, and the sitemap/`status` semantics are unchanged.
> Rationale and the full model: [ADR-0008](docs/internals/decisions.md).

### Changed

- **Saving no longer publishes.** A save writes the DB; the new **Publish** button (right of Save in the
  record and singleton editors, or `POST /api/publish`) writes the static file(s) to the configured output.
  Editing a published page therefore leaves the live page exactly as it was until you publish — which is
  what makes previewing safe. **Unpublishing and deleting still prune immediately** — a page taken offline
  must not stay live. Every publish, full or incremental, **holds back routes with unpublished changes**, so
  neither a restart nor somebody else's Publish pushes your work-in-progress live; withholding follows the
  RECORD, so a saved-but-unpublished rename keeps serving its old URL rather than publishing the new one.
  A held route is frozen whole, links included. A record that has never been published anywhere is still
  rendered, so a first deploy behaves as before. `nuxt generate` is unchanged: it builds the whole site from
  the current DB.
  Upgrading an existing project: nothing breaks, but content edits now need the Publish step. See
  [ADR-0008](docs/internals/decisions.md). To keep the old behaviour, set **`output.publishOnSave: true`**
  (env `KESTREL_OUTPUT_PUBLISH_ON_SAVE=1`): every save republishes as before, the Publish button disappears,
  and a full publish holds nothing back.

- **The richtext allowlist no longer accepts `img`, `figure`, `figcaption` or `table` markup.** It used to,
  but no editor extension can parse any of them: such content — which can only arrive through the API, a
  seed or a migration, never through the editor — was displayed as bare text and deleted by the first
  edit, and the next save persisted that loss. Rejecting it on write makes the loss immediate and visible
  instead of latent. Images belong in a media field or an image block; tables await an editor that can
  hold them. A test now asserts that the allowlist and the editor's schema agree, so widening one without
  the other fails the suite.

### Added

- **Preview unsaved changes in a real tab.** The editor's open-in-new-tab button no longer only shows the
  last saved state: with unsaved changes it mints a short-lived, admin-only, session-bound **preview
  ticket** (`POST /api/preview`) and opens `<url>?kestrel-preview-token=…`. The page renders the editor's
  current values over the stored record — populated server-side, so media and internal links resolve —
  marked with a "Preview — unsaved changes" badge and `noindex`. Nothing is saved and nothing is published.
  Records with no public URL (never saved, blank slug, non-pageLike) preview the same way on
  `/__kestrel/preview`.
- **An "Outdated" state in the editor's live lamp** — published, but the record has been saved since, so the
  live page is an older version. `GET /api/publish-status` reports it as `pending`.
- **ESLint**, dev-only (not part of the published package): `pnpm lint` runs a Nuxt-aware config generated
  from the playground (auto-import globals for every layer + extension), typescript-eslint's strict preset,
  and `eslint-plugin-vuejs-accessibility`, wired into CI right after `typecheck`. Fixing what it surfaced
  closed a few real accessibility gaps in the admin editor — missing labels on hand-rolled controls (the
  proofing gallery's comment box, the media upload trigger) — and replaced several `delete obj[key]` calls
  with `Reflect.deleteProperty`, test-only `any` with real types, and a couple of rethrows that had dropped
  their original error as `cause`.

### Fixed

- **A ticket preview no longer skips the richtext sanitizer.** `sanitizeRichtext` runs as part of the write
  schema, so a preview ticket — which is never written — carried the editor's raw HTML through to the page's
  `v-html`. The mint now sanitizes the payload it stores, walking blocks and repeaters the way a save does,
  so the preview renders exactly the bytes a save would have kept.

- **A cleared relation no longer previews as still set.** The ticket lays the editor's values over the saved
  record, and the populator omits a `$<relation>` sidecar entirely when the id is null — so clearing a single
  relation or media field left the previously populated record visible under the old sidecar.

- **The editor stops claiming a publish is running when none is.** A page with no publish row read as
  "Generating…", which was true while every save enqueued a republish and is not any more: nothing runs
  until someone presses Publish. It now reads "Not published" — unless `output.publishOnSave` is on, where a
  save really does enqueue one.

- **The editor stops overriding the server's link policy.** TipTap's Link mark stamps
  `target="_blank" rel="noopener noreferrer nofollow"` onto every anchor it renders, while the sanitizer
  applies those attributes only to absolute `http(s)` links and strips them from every other kind — so a
  stored internal, relative or `mailto:` link came back from the editor decorated, which the edit form
  read as an unsaved change that never converged (the next save stripped the attributes again). The mark
  no longer sets its own defaults; `sanitize.ts` remains the sole authority, and published output is
  unchanged.

- **Internal links in richtext survive the editor.** Setting one from the toolbar was a silent no-op — the
  picker closed and nothing was linked — and an already-stored `<a href="kestrel:…">` was dropped whole,
  leaving its text behind unlinked, so the first real edit to that field destroyed the reference with
  nothing in the stored HTML to recover the target from. The sanitizer allows the `kestrel:` scheme, but
  TipTap's Link mark keeps its own allowlist and rejects any scheme not in `protocols`; `UiRichtext` now
  registers `RICHTEXT_LINK_SCHEME` there. Merely opening a record was never enough to lose the link.

- **The page builder no longer falls back to "Unsaved" right after saving a richtext block.** The record
  was stored correctly, but the lamp returned to amber and stayed there until an unrelated save cleared
  it. The block pane is disabled while a save is in flight, and TipTap emits an `update` for that bare
  editability change — past the transaction pipeline, so the usual guards do not apply. The echo landed
  in the form after the save had already taken its baseline, and because the editor's serialization and
  the server's sanitizer are not byte-identical (`<br>` vs `<br />`, `&nbsp;`, `text-align: center`), it
  read as a real difference. `UiRichtext` now emits only when the document actually changed.

## [1.7.0] — 2026-08-11

A hardening release. No API was removed, but several behaviours changed in ways a deployment can notice —
read **Changed** before upgrading. The theme throughout: a read that *failed* is no longer treated as a read
that found *nothing*, because the second one silently overwrites live output with an empty result.

### Security

- **Anonymous `?depth=` reads no longer expand relations into non-public collections.** A relation from a
  page-like collection into one the access guard refuses (anything not `pageLike`) previously returned the
  related record's every column under `$<field>` to an unauthenticated caller, transitively bypassing the
  gate that answers `401` on the collection's own route. The generic `/api/<collection>` read routes now
  withhold that sidecar for an anonymous principal, leaving the raw id. Keyed on the principal's **role**,
  so the renderer and the admin are unaffected and static output is unchanged.
  Note the boundary this does *not* cover: the render entry `/api/route` still populates in full for every
  principal, and populated relations are serialised into each generated page's hydration payload. **Any
  collection reachable from a page-like record's relations is public data regardless of its access grant** —
  see [docs/guide/deploying.md](docs/guide/deploying.md) and [docs/guide/querying.md](docs/guide/querying.md), and project the
  relation if it holds columns that must not ship.
- **The IP allow-list no longer widens a malformed entry to `0.0.0.0/0`.** A token whose prefix was empty or
  non-numeric (`203.0.113.10/`, `/0x10`, `/1e1`) parsed to a zero mask and admitted the entire IPv4
  internet — silently, since the token looked valid and no warning fired. Such tokens are now rejected and
  reported. A deliberate `0.0.0.0/0` still works.
- **`kestrel init --password` no longer writes the password to disk as a directory name.** A value beginning
  with `-` was consumed as the target directory, so the cleartext admin password became a directory in the
  filesystem and no hash was written at all.

### Fixed

- A page lookup that could not *complete* (unmigrated or drifted table) no longer bakes a **blank home page
  over the live site root**. `/api/route` answers `503`, the publisher classifies the render as an error and
  keeps the existing file, and the editor's status turns red. Every other path already degraded safely.
- An unreadable `site` singleton no longer takes down every public page with a `500`, nor bakes a
  head-less page over a live one and records it as a successful publish.
- Publishing a translation sibling now re-renders the other members of its group, so their baked `hreflang`
  set includes the new locale. Previously only the new page rendered, leaving a one-way cluster that
  crawlers discard.
- `media:backfill` no longer prunes derivatives when the variant registry was not read authoritatively — an
  unreadable, unmigrated, empty or wholly invalid registry resolves to the config fallback, under which
  every registered variant looks deregistered. The prune is withheld and reported instead.
- `GET /api/references/broken` answers `503` when the reference index itself cannot be read, instead of an
  empty array that reads as a verified-clean site.
- `sitemap.xml` and `llms.txt` log a collection they had to skip rather than silently dropping its URLs, and
  an unreadable internal link target is logged instead of being cached run-wide as "not linkable".
- `create-kestrel --force` merges an existing `package.json` instead of overwriting it, and both front ends
  refuse a manifest that is not a JSON object before writing anything.
- `kestrel init --password` rotates an admin hash that is already set; previously the supplied password was
  silently discarded.
- Consumers no longer get `TS7016` errors inside Kestrel's own sources: `@types/better-sqlite3`,
  `@types/jsdom` and `@types/sanitize-html` are runtime `dependencies`, since the package ships
  uncompiled TypeScript.

### Changed

- **`nuxt generate` now fails when `KESTREL_SESSION_SECRET` is unset.** Generate runs in production mode,
  where the secret is required; without it every public route answers `500`. That error was previously
  swallowed and an empty site was emitted with a zero exit code. Set the variable in your build environment.
- **A previously accepted but malformed allow-list entry is now dropped.** If such a token was your only
  entry, `enforce` mode now blocks everything rather than admitting everyone. The startup warning names each
  rejected token, and a list that parses to zero CIDRs warns explicitly.
- **An interactive `kestrel init` re-run no longer prompts for a password** when the project already has an
  admin hash; pass `--password` to change it. Rotating the hash signs out every existing session, because it
  is folded into the cookie signing key.
- `BackfillReport` gains `pruneWithheld: boolean`, set when the prune was skipped for the reason above.
- A route whose lookup cannot complete writes no HTML, the site root included. The generate still exits `0`
  in that case (`prerender.failOnError` is off by design) — check the prerender log, not the exit code. The
  deploy step counts the failed route as an incomplete run and suppresses the S3 prune, so the live page
  survives.

### Documentation

- [docs/guide/deploying.md](docs/guide/deploying.md) documents what a generated page actually contains, including
  the hydration payload and the exposure boundary it creates.
- [docs/guide/querying.md](docs/guide/querying.md) explains how to project a relation, and why such an override must
  delegate to the type populator — one that re-reads the table instead loses `captureRead` and silently
  disables the invalidation that re-publishes the page.
- [docs/guide/collections.md](docs/guide/collections.md) corrects the shipped public-component surface and the
  built-in collection list.

[3.0.1]: https://github.com/MichaelThielemann/kestrel/releases/tag/v3.0.1
[3.0.0]: https://github.com/MichaelThielemann/kestrel/releases/tag/v3.0.0
[2.1.0]: https://github.com/MichaelThielemann/kestrel/releases/tag/v2.1.0
[2.0.0]: https://github.com/MichaelThielemann/kestrel/releases/tag/v2.0.0
[1.7.0]: https://github.com/MichaelThielemann/kestrel/releases/tag/v1.7.0
