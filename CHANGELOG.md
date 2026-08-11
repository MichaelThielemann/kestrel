# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 1.7.0 are documented by their tags and commit history.

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
