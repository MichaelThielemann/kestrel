# site/default
`site@1` on top of `content@1`: the website vocabulary that `content@1` deliberately does not carry.
`resolve` maps a site path from a `*path` route – `/`, `/<slug>`, `/<lang>`, `/<lang>/<slug>`; the
default locale has no prefix unless `?prefixPrimary=true` – onto one document by its slug field,
`pathOf` is the inverse, `resolveLinks` rewrites internal references (`kestrel:<type>:<id>` in
strings and richtext, `{ type: "internal", collection, id }` objects) to public paths in the
document's locale; targets not served there become `href="#" data-kestrel-broken="…"` / `broken: true`,
and `_links` maps every referenced id to its path. A locale is found only by its own slug there: a
locale without a slug of its own is never served, and never under another locale's slug (404), and a
linked page without a slug of its own in the link's locale is broken there. A locale that is not
published itself stays unserved and is never replaced by another locale's content (404). With
`?fallback=true` an empty field of a served locale other than the slug is filled from the default
locale only when the default locale's own values pass the filter too; with no such default the field
stays empty. `_translations` lists only the locales that pass the filter themselves. Every `site@1`
implementation must follow this rule; the shared contract suite
(`@michaelthielemann/kestrel-contracts/site.contract.test`) tests it.
Cost: with `?fallback=true` and N locales configured, resolving a non-default locale reads up to two
`content.get` calls (the requested locale's own values, the merged fallback read) and up to N+2
`content.list` calls (the slug lookup, a filter check each for the requested and the default locale,
one per remaining locale to narrow `_translations`). Every locale's filter membership is decided fresh at read time, on the store itself,
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
default none, so a route without it, such as a mounted collection, has no home and a document slugged
`home` keeps its own path; a call naming a `home` the route does not have throws), `liveWhen` (the filter a document must pass with its own values in a locale to be
reachable there; default `{}`), `labelField` (default `title`, names documents in messages) and
`parentField` (see below). Routed mode needs a `persistence@1` and an `events@1` provider; setup fails
without them. `maxDepth` (default 16) bounds a parent chain, `maxCascade` (default 1000) the rows one
save may change. The in-memory table is updated only in the process that saved, so one process
serves one database: a second process on the same store would keep answering with the paths it loaded
at its own start.

**Subpages.** With `parentField` (a non-localized `ref` to the same type, only on the type named by
`mountTarget`, default `pages`) a document's path is its parent's path plus its own slug:
`/ueber-uns/team`, `/en/about-us/team`. The slug is unique only where the whole path collides, so
`/ueber-uns/team` and `/projekte/team` both save; a routed type with parents must not have a `unique`
slug field, and setup fails if it does. In a locale where a page has no slug of its own, the page itself
has no path there, and its segment in its subpages' paths is its default-locale slug. A parent that is the page itself or one of its subpages, a chain deeper
than `maxDepth`, a missing parent and the home page as a parent or with a parent are field errors on
the parent field; deleting a page that still has subpages is a `CONFLICT` naming them. Renaming or
re-parenting a page moves every subpage in every locale; a subpage whose new path is taken rejects the
whole save and names both documents (`details.conflicts[].moving`).

**Mounted collections.** A routed type with `mount: true` lives under a page of the `mountTarget` type:
`mounts: { type: "settings", field: "mounts" }` names the single type and field holding the assignment
(`{ posts: "<page id>" }`; `null` or absent means the top level, where the collection shares the path
space with the pages). A post then reaches `/blog/hallo` and `/en/news/hallo`. Every pipeline that
writes that single type ends its atomic group with `site.indexMounts`, followed by
`site.announcePaths`, or boot fails:

```ts
{ atomic: ["content.set:settings", "site.indexMounts"] }, "site.announcePaths"
```

`site.indexMounts` rejects an unknown collection, a missing page, the home page and one page for two
collections (`VALIDATION` on the mounts field), and a change whose documents would collide
(`CONFLICT` naming both); otherwise it moves every document of each collection whose page changed.
Renaming the mount page moves every mounted document; removing it is refused while it holds a
collection. The mount page follows the same independent reachability as a parent. On a routed
collection's own resolve pipeline, `site.route:<t>` before `site.resolve:<t>` ends the run with
`{ route: { type } }` when the path belongs to a reachable document of another routed type, so the
caller can fetch it from that collection's pipeline.

**Independent reachability.** Every page is reachable on its own: live in the locale and its path
valid. A page that is not published in a locale answers 404 there, but its subpages keep their paths,
also under a page that was never published, and unpublishing or republishing it moves only that page.
One deliberate consequence: the slug of an unpublished parent appears as a segment of its published
subpages' paths. No other field of the parent is served: links to it are broken, it has no output, and
a caller only learns its id through fields the caller is granted. `site.previewPath` reports such a
parent as `exposesParentSlug`. A subpage is placed structurally: its path is valid when it holds a slug
of its own in the locale and every page above it holds its segment, whatever those pages' publication
or claim strength. So when a page has no slug in `en` and its segment `/en/p` comes from its
default-locale slug while another page takes `/en/p` with a slug of its own, both pages' subpages keep
their full paths below `/en/p/`; full paths stay unique, so two documents never answer one path.
Publishing or unpublishing a page moves only that page, never its subpages.

**One path, one document.** The public path is unique per locale across every routed type; the slug
alone need not be. A document's path in a locale comes from its own slug there (a strong claim); a
document without one holds its default-locale slug only as the segment below which its subpages sit (a
weak claim), which is never a path of its own. Two strong claims on one path conflict whatever either
document's status, so drafts block each other, and so do two weak claims on one segment; a strong claim
meets a weak one without a conflict. A path equal to or below a `reservedPaths` entry, or starting
with a locale code, is a slug field error. A `unique` slug field is not needed and logs a warning at
setup, because it rejects the same slug without naming the occupant.

**Resolving.** `resolve` looks the path up in an in-memory table: the strong holder when it passes the
call's filter (an empty filter always does), otherwise nothing. The answer is then read as described above and gains `_paths`: every locale's
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
the run's moves. It also rejects, with `VALIDATION` on the slug field, a save that leaves the written
locale (`params.locale`, else `payload.locale`, else the default locale) passing `liveWhen` with a
translation there but no slug of its own: a translation cannot be published without its own slug. A
locale the save did not write is not checked, so a translation stored that way before keeps no path
and does not block edits of the other locales. A rejection rolls the whole group back. `site.announcePaths` runs right after the
group: it updates the in-memory table from the committed rows and raises `site.pathsMoved` with
`{ moves: [{ type, id, locale, from, to, seq }] }`, one entry per document and locale whose reachable
path changed (`null` for none). `seq` increases with every run. The announce never fails the run; what
it could not finish, `site.resumePaths` (on a cron, every minute) finishes, so the table lags by at most
one interval after a failure. Boot fails when a pipeline writes a routed type without this wiring, or
reads it with a `home` or `slugField` the route does not have.

`site.readTree:<t>` lists every document of the mount target type with its parent, label, valid
paths and per-locale `live` state. `site.attachPaths:<t>?reachable` adds `_paths` to a list or read answer (reachable paths only; without
`?reachable` every valid path, drafts included). `site.previewPath:<t>` answers, for a payload
`{ id?, locale?, slug }`, the path a save would give, whether it would be reachable and the occupant of a
taken path; `shadows` stays empty, since no page serves a path it does not hold with its own slug.

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

**Cost.** A save reads the stored path table and recomputes it in memory inside its group, and writes
only the rows that changed, in bulk calls of up to 500 rows. The group holds the store's write lock, so
public requests wait for it. A save that would change more than `maxCascade` rows is rejected with a
field error before anything is written; raising the limit lets larger sections move in one save, at
the price of every request waiting for that long. The cost of a save therefore grows with the total number of stored rows (documents × locales), not with
the size of the change: roughly 4 ms per 1000 rows. Measured on SQLite in memory with the default
persistence settings:
- 200 pages in 5 locales (1000 rows): a whole save run (content write, index, announce) takes about
  4 ms, and a full rebuild about 15 ms;
- a cascade of exactly `maxCascade` rows (renaming the mount page of 199 posts, 200 documents in
  5 locales): the atomic group takes about 42 ms and the announce afterwards about 8 ms, well inside
  the 5000 ms `scopeTimeoutMs`. Public requests wait for the duration of such a group.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-site-default` – module `site/default`: provides `site@1`; requires `content@1`; optional `persistence@1`, `events@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `routes` | record | no | `{}` |
| `prefixPrimary` | boolean | no | `false` |
| `reservedPaths` | array | no | `[]` |
| `mounts` | object | no | – |
| `mounts.type` | string | no | – |
| `mounts.field` | string | no | – |
| `mountTarget` | string | no | `"pages"` |
| `maxDepth` | integer | no | `16` |
| `maxCascade` | integer | no | `1000` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `site.resolve:<arg>` | Resolve a site path to a <arg> document (default locale unprefixed) | `params.path` | `result` | – | { id: string, createdAt: number, updatedAt: number, _locales?: object, _translations?: object, _locale?: string, _links?: object, … } | 404 no page at this path | – | no |
| `site.resolveLinks:<arg>` | Replace internal kestrel:<type>:<id> references in the <arg> document with public paths (_links map added) | `result` | `result` | ?locale: string | { _links?: object, … } | – | – | no |
| `site.indexPath:<arg>` | Recompute the public paths of the saved <arg> (result.id, else params.id) and of every document whose path depends on it; last step of the write's atomic group | `result.id?`, `params.id?`, `params.locale?`, `payload.locale?` | – | ?locale: string | – | 400 the path is reserved or starts with a locale code, or the written locale is published without a slug of its own; 409 another document holds the path; 503 the store is unavailable | – | yes |
| `site.announcePaths` | After the write's atomic group: patches the in-memory path table from the committed rows and raises site.pathsMoved; never fails the run | – | – | – | – | – | – | no |
| `site.resumePaths` | Announce path changes a run left unannounced (patches the in-memory path table from the committed rows and raises site.pathsMoved) and prune announced ones older than 7 days | – | `result` | – | { announced: integer, pruned: integer, … } | 503 the store is unavailable | – | no |
| `site.planRebuild` | Recompute every routed document's paths from content@1 outside any group (adds `rebuild` to the result) | – | `result.rebuild` | – | { rebuild: object, … } | 503 the store is unavailable | – | no |
| `site.applyRebuild` | Write the planned paths inside one atomic group; saves committed since the plan are recomputed there | `result.rebuild` | `result` | – | { indexed: integer, conflicts: object[], … } | 503 the store is unavailable | – | yes |
| `site.indexMounts` | Validate the stored mount assignment and move every document of each collection whose mount page changed; last step of the settings write's atomic group | – | – | – | – | 400 an invalid assignment, or a change moving more than maxCascade paths; 409 a moved document's path is taken; 503 the store is unavailable | – | yes |
| `site.readTree:<arg>` | Every <arg> with its parent, label, valid paths and live state per locale | – | `result` | – | object[] | 503 the store is unavailable | – | no |
| `site.route:<arg>` | End the run with { route: { type } } when params.path is reachable and belongs to a routed collection other than <arg>; pass through otherwise | `params.path` | `result?` | – | – (ends: { route: object }) | – | – | no |
| `site.previewPath:<arg>` | The public path a <arg> would get for payload { id?, locale?, slug, parent? }, whether it would be reachable and why not; writes nothing | – | `result` | { id?: string, locale?: string, slug: string, parent?: string \| null, … } | { path: string, reachable: boolean, reason: string \| null, conflict: object \| null, shadows: object[], exposesParentSlug: object \| null, … } | 400 slug is missing; 503 the store is unavailable | – | no |
| `site.attachPaths:<arg>` | Add _paths (locale → path) to the <arg> result, every valid path including drafts | `result` | `result` | – | { _paths: object, … } | – | – | no |

Used by 13 of 102 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
