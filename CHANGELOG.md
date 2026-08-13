# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 1.7.0 are documented by their tags and commit history.

## [Unreleased]

### Changed

- **Saving no longer publishes.** A save writes the DB; the new **Publish** button (right of Save in the
  record and singleton editors, or `POST /api/publish`) writes the static file(s) to the configured output.
  Editing a published page therefore leaves the live page exactly as it was until you publish — which is
  what makes previewing safe. Two deliberate exceptions keep the output honest: **unpublishing and deleting
  still prune immediately** (a page taken offline must not stay live), and a **full publish** (boot /
  reconciler) holds back routes whose record was saved after their last publish instead of pushing
  work-in-progress live. A route that was never published is still rendered by the boot publish, so a first
  deploy behaves as before. `nuxt generate` is unchanged: it builds the whole site from the current DB.
  Upgrading an existing project: nothing breaks, but content edits now need the Publish step. See
  [ADR-0008](docs/architecture-decisions.md). To keep the old behaviour, set **`output.publishOnSave: true`**
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

### Fixed

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
  see [static-output.md](docs/static-output.md) and [population.md](docs/population.md), and project the
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

- [static-output.md](docs/static-output.md) documents what a generated page actually contains, including
  the hydration payload and the exposure boundary it creates.
- [population.md](docs/population.md) explains how to project a relation, and why such an override must
  delegate to the type populator — one that re-reads the table instead loses `captureRead` and silently
  disables the invalidation that re-publishes the page.
- [consuming-kestrel.md](docs/consuming-kestrel.md) corrects the shipped public-component surface and the
  built-in collection list.

[1.7.0]: https://github.com/MichaelThielemann/kestrel/releases/tag/v1.7.0
