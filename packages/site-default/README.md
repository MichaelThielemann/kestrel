# site/default
`site@1` on top of `content@1`: the website vocabulary that `content@1` deliberately does not carry.
`resolve` maps a site path from a `*path` route – `/`, `/<slug>`, `/<lang>`, `/<lang>/<slug>`; the
default locale has no prefix unless `?prefixPrimary=true` – onto one document by its slug field,
`pathOf` is the inverse, `resolveLinks` rewrites internal references (`kestrel:<type>:<id>` in
strings and richtext, `{ type: "internal", collection, id }` objects) to public paths in the
document's locale; targets not served there become `href="#" data-kestrel-broken="…"` / `broken: true`,
and `_links` maps every referenced id to its path. With `?fallback=true` a locale without its own
slug is found by the same slug in the default locale; that lookup matches the slug and only the
filter's locale-independent fields, and the requested locale must then pass the whole filter
itself. A locale that is not published itself stays unserved and is never replaced by another
locale's content (404). A locale with a slug of its own is reachable through the default locale's
slug only while the default locale passes the filter too, so a draft default slug never becomes a
second address for it. An empty field of a
served locale — including a linked page's slug inside `resolveLinks` — is filled from the default
locale only when the default locale's own values pass the filter too; with no such default the field
stays empty. `_translations` lists only the locales that pass the filter themselves. Every `site@1`
implementation must follow this rule; the shared contract suite
(`@michaelthielemann/kestrel-contracts/site.contract.test`) tests it.
Cost: with `?fallback=true` and N locales configured, resolving a non-default locale reads up to two
`content.get` calls (the requested locale's own values, the merged fallback read) and up to N+2
`content.list` calls (the slug lookup, a filter check each for the requested and the default locale,
one per remaining locale to narrow `_translations`) — when the requested locale's own slug lookup
finds nothing, the default-locale slug lookup adds one list call, plus one `content.get` (and one
filter check if the requested locale has a slug of its own) to decide whether that slug routes
there. Measured at 4 locales: 8 calls for `resolve`. Every locale's filter membership is decided fresh at read time, on the store itself,
never cached or reused across these calls; that correctness is preferred over the read count.
Steps: `site.resolve:<t>?home=home&status=published&fallback=true` (`NOT_FOUND` otherwise) and
`site.resolveLinks:<t>?…` with the same arguments. With config `{}` every type resolves as described
above and the module stores nothing.
Not included: rendering, redirects (see delivery-static, redirects-default).

## Routed mode

`routes` makes `site/default` the owner of every public path of the listed types:

```ts
{
  routes: { pages: { home: "home", liveWhen: { status: "published" } } },
  prefixPrimary: false,              // the form of stored paths, _paths and moves
  reservedPaths: ["/api", "/admin"], // no routed document may take these paths or anything below them
}
```

A route has `slugField` (default `slug`), `home` (the top-level slug served at the locale's root;
default none), `liveWhen` (the filter a document must pass with its own values in a locale to be
reachable there; default `{}`) and `labelField` (default `title`, names documents in messages). Routed
mode needs a `persistence@1` and an `events@1` provider; setup fails without them.

**One path, one document.** The public path is unique per locale across every routed type; the slug
alone need not be. A document's path in a locale is its own slug there (a strong claim), or else its
default-locale slug (a weak claim). Two strong claims on one path conflict whatever either document's
status, so drafts block each other. A strong claim meets a weak one without a conflict: while the
strong holder is live it takes the path and the weak holder is unreachable in that locale; while it is
a draft the weak holder keeps serving. A path equal to or below a `reservedPaths` entry, or starting
with a locale code, is a slug field error. A `unique` slug field is not needed and logs a warning at
setup, because it rejects the same slug without naming the occupant.

**Resolving.** `resolve` looks the path up in an in-memory table: the strong holder when it passes the
call's filter (an empty filter always does), otherwise, with `fallback`, the weak holder unless a live
strong holder shadows it. The answer is then read as described above and gains `_paths`: every locale's
reachable path, `null` where the document is not reachable. `pathOf` answers `null` for a document whose
claim is not serving, and `resolveLinks` marks such a target as broken. A call naming a `slugField` or
`home` other than the route's throws.

**Writing.** Every write to a routed type goes through the index, inside the write's atomic group:

```ts
{ atomic: ["content.update:pages", "site.indexPath:pages"] }, "site.announcePaths", "events.emit:page.updated"
```

`site.indexPath:<t>` is the last step of the group. It recomputes the saved document and every document
whose path depends on it, rejects a taken or reserved path (`CONFLICT` with `details.conflicts` naming
path, locale and occupant, or `VALIDATION` with `details.fields`), writes the changed rows and records
the run's moves. A rejection rolls the whole group back. `site.announcePaths` runs right after the
group: it updates the in-memory table from the committed rows and raises `site.pathsMoved` with
`{ moves: [{ type, id, locale, from, to, seq }] }`, one entry per document and locale whose reachable
path changed (`null` for none). `seq` increases with every run. The announce never fails the run; what
it could not finish, `site.resumePaths` (on a cron, every minute) finishes, so the table lags by at most
one interval after a failure. Boot fails when a pipeline writes a routed type without this wiring, or
reads it with a `home` or `slugField` the route does not have.

`site.attachPaths:<t>?reachable` adds `_paths` to a list or read answer (reachable paths only; without
`?reachable` every valid path, drafts included). `site.previewPath:<t>` answers, for a payload
`{ id?, locale?, slug }`, the path a save would give, whether it would be reachable, the occupant of a
taken path and the fallback pages it would shadow.

**Rebuilding.** The table is stored in `site_docs`, `site_paths`, `site_runs` and `site_meta`. Setup
rebuilds it when the routes, the locales, `prefixPrimary`, `reservedPaths` or a routed slug field
changed, and when any routed document's `updatedAt` differs from the stored one (a write that bypassed
the index, such as a migration). A write that bypasses the index within the same millisecond as that
document's last indexed save goes unnoticed until the next rebuild. At run time a rebuild is a
pipeline:

```ts
["site.planRebuild", { atomic: ["site.applyRebuild"] }, "site.announcePaths"]
```

The plan reads everything outside the group; the group writes only the difference, and recomputes
there the documents saved while the plan was being made. A tail already held keeps its holder, an
unheld one goes to its oldest claimant; the answer `{ indexed, conflicts }` lists every document that
lost a path, and such a document cannot be saved with that slug until the holder gives it up. Run it
after migrations, for example on `migrations.applied`.

**Cost.** A save's group holds the store's write lock, so public requests wait for it. Measured on
SQLite in memory with 200 pages in 5 locales: a whole save run (content write, index, announce) takes
about 1 ms, and a full rebuild about 20 ms.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-site-default` – module `site/default`: provides `site@1`; requires `content@1`; optional `persistence@1`, `events@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `routes` | record | no | `{}` |
| `prefixPrimary` | boolean | no | `false` |
| `reservedPaths` | array | no | `[]` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `site.resolve:<arg>` | Resolve a site path to a <arg> document (default locale unprefixed) | `params.path` | `result` | – | { id: string, createdAt: number, updatedAt: number, _locales?: object, _translations?: object, _locale?: string, _links?: object, … } | 404 no page at this path | – | no |
| `site.resolveLinks:<arg>` | Replace internal kestrel:<type>:<id> references in the <arg> document with public paths (_links map added) | `result` | `result` | ?locale: string | { _links?: object, … } | – | – | no |
| `site.indexPath:<arg>` | Recompute the public paths of the saved <arg> (result.id, else params.id) and of every document whose path depends on it; last step of the write's atomic group | `result.id?`, `params.id?` | – | – | – | 400 the path is reserved or starts with a locale code; 409 another document holds the path; 503 the store is unavailable | – | yes |
| `site.announcePaths` | After the write's atomic group: patches the in-memory path table from the committed rows and raises site.pathsMoved; never fails the run | – | – | – | – | – | – | no |
| `site.resumePaths` | Announce path changes a run left unannounced (patches the in-memory path table from the committed rows and raises site.pathsMoved) and prune announced ones older than 7 days | – | `result` | – | { announced: integer, pruned: integer, … } | 503 the store is unavailable | – | no |
| `site.planRebuild` | Recompute every routed document's paths from content@1 outside any group (adds `rebuild` to the result) | – | `result.rebuild` | – | { rebuild: object, … } | 503 the store is unavailable | – | no |
| `site.applyRebuild` | Write the planned paths inside one atomic group; saves committed since the plan are recomputed there | `result.rebuild` | `result` | – | { indexed: integer, conflicts: object[], … } | 503 the store is unavailable | – | yes |
| `site.previewPath:<arg>` | The public path a <arg> would get for payload { id?, locale?, slug }, whether it would be reachable and why not; writes nothing | – | `result` | { id?: string, locale?: string, slug: string, … } | { path: string, reachable: boolean, reason: string \| null, conflict: object \| null, shadows: object[], exposesParentSlug: null, … } | 400 slug is missing; 503 the store is unavailable | – | no |
| `site.attachPaths:<arg>` | Add _paths (locale → path) to the <arg> result, every valid path including drafts | `result` | `result` | – | { _paths: object, … } | – | – | no |

Pipelines in `examples/minimal` using these steps:

- **createPage** (POST /pages): `authn.requireUser` → `authz.require:pages.write` → `validate.check:pages.body` → `validate.sanitize:pages.body` → `validate.check:pages.body` → [ `references.check:pages` → `content.create:pages` → `revisions.record:pages` → `references.index:pages` → `links.extract:pages` → **`site.indexPath:pages`** ] → **`site.announcePaths`** → `events.emit:page.created` → `events.relay`
- **deletePage** (DELETE /pages/:id): `authn.requireUser` → `authz.require:pages.delete` → [ `references.guard:pages` → `content.remove:pages` → `revisions.remove:pages` → `references.unindex:pages` → `links.unextract:pages` → **`site.indexPath:pages`** ] → **`site.announcePaths`** → `events.emit:page.deleted` → `events.relay`
- **deletePageTranslation** (DELETE /pages/:id/translations/:locale): `authn.requireUser` → `authz.require:pages.write` → [ `content.removeTranslation:pages` → `revisions.removeTranslation:pages` → `references.index:pages` → `links.extract:pages` → **`site.indexPath:pages`** ] → **`site.announcePaths`** → `events.emit:page.translationRemoved` → `events.relay`
- **listAllPages** (GET /admin/pages): `authn.requireUser` → `authz.require:pages.manage` → `content.list:pages` → **`site.attachPaths:pages`**
- **previewPagePath** (POST /admin/pages/path-preview): `authn.requireUser` → `authz.require:pages.write` → **`site.previewPath:pages`**
- **readAnyPage** (GET /admin/pages/:id): `authn.requireUser` → `authz.require:pages.manage` → `content.get:pages` → **`site.attachPaths:pages`**
- **rebuildPaths** (POST /admin/paths/rebuild): `authn.requireUser` → `authz.require:pages.manage` → **`site.planRebuild`** → [ **`site.applyRebuild`** ] → **`site.announcePaths`**
- **rebuildPathsAfterMigrations** (event migrations.applied): **`site.planRebuild`** → [ **`site.applyRebuild`** ] → **`site.announcePaths`**
- **resolvePage** (GET /site/*path): `authn.identifyUser` → `authz.require:pages.read` → `redirects.lookup` → **`site.resolve:pages?home=home&status=published&fallback=true`** → **`site.resolveLinks:pages?home=home&status=published&fallback=true`** → `authz.fields:pages?shape=item`
- **restorePageRevision** (POST /admin/pages/:id/revisions/:revisionId/restore): `authn.requireUser` → `authz.require:pages.write` → `revisions.restore:pages` → `validate.check:pages.body` → `validate.sanitize:pages.body` → `validate.check:pages.body` → [ `references.check:pages` → `content.update:pages` → `revisions.record:pages` → `references.index:pages` → `links.extract:pages` → **`site.indexPath:pages`** ] → **`site.announcePaths`** → `revisions.reportRestore` → `events.emit:page.restored` → `events.relay`
- **resumePaths** (cron * * * * *): **`site.resumePaths`**
- **updatePage** (PATCH /pages/:id): `authn.requireUser` → `authz.require:pages.write` → `validate.check:pages.body` → `validate.sanitize:pages.body` → `validate.check:pages.body` → [ `references.check:pages` → `content.update:pages` → `revisions.record:pages` → `references.index:pages` → `links.extract:pages` → **`site.indexPath:pages`** ] → **`site.announcePaths`** → `events.emit:page.updated` → `events.relay`

<!-- kestrel-docs:end -->
