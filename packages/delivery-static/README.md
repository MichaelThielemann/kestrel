# delivery/static
Static delivery with a publish status per document and locale. Requires `content@1`, `site@1`,
`renderer@1` (the site's own renderer), `blobstore@1` (filesystem or S3) and
`persistence@1`. `delivery.publish:<type>` after `content.create/update`: for every locale whose
own `statusField` equals `publishedValue` the document (an empty field filled from the default
locale only when the default locale's own values equal `publishedValue` too, `_translations`
narrowed to locales that satisfy it themselves, internal links resolved to public paths via
`site.resolveLinks`, `_links` attached) is rendered in each configured format and stored under the
path `site.pathOf` returns (default locale unprefixed unless `prefixPrimary`; a type's `home`, when
set, is passed to `site@1` and its slug maps to `/`; without it the `site@1` provider's own rule applies,
which for a routed type in `site-default` is the route's `home`, possibly none);
other locales are removed. Outcome per
locale in `delivery_publish_status` (`live` | `error` | `draft`, `path`, `error`, `publishedAt`); a failed
render keeps the previous live output, but a locale that is published yet has no public path
(`state: "error"`, error `no public path`: it has no slug of its own in that locale, since a locale
never takes another locale's slug, or `site.pathOf` answers `null` because another document holds the
path) removes its previous output instead — that content is no longer
publishable, so it does not stay public.
`delivery.unpublish:<type>` after remove, `delivery.readStatus:<type>`
for the editor's second lamp, `delivery.publishAll:<type>` to re-render everything.
`delivery.publish` takes the document id from `result.id` when present, else from the event
payload's `id`, so it also runs as the first step of a pipeline an event triggers; it merges
`_delivery` into the result instead of replacing it. `delivery.unpublish` does the same with
`params.id` and the payload's `id`. Both answer `VALIDATION` (400) when neither source names a
document, instead of throwing.
Formats come from the renderer (`html`, `pdf`, …) – `formats: ["html", "pdf"]` writes both.
Assets the renderer returns (`assets: [{ path: "/_assets/app.js", … }]` – hydration bundles, CSS)
are stored under `<prefix><path>` once per process; they are never removed on unpublish. Rendered
output is stored exactly as the renderer returned it: this module never scans or rewrites it, so
any media reference it contains (a URL a media module already returned as data) reaches the export
unchanged, in whatever spelling the renderer produced.
`reservedPaths` (e.g. `["/api", "/admin", "/media"]`) names paths the origin – not this export –
owns. A page whose path equals or lies under one of them is not written; its status becomes
`error` with `path <path> is reserved (<reserved>)`, and the previous live output (if any) stays. A
renderer asset under a reserved path fails the same way, naming the asset's own path.
Every `Delivery` method returns a `Result`; a failure is an `Err(KestrelError)`, never an exception.
A render failure (`RENDER_FAILED` or `TRANSIENT` from `renderer@1`) is not a step failure: it is
recorded on the status row as `state: "error"` with the message and the remaining locales are still
published. Only wiring bugs throw (unknown type, unconfigured type, an asset path that is empty or contains a
`..` segment).

| Step | reads | writes | codes |
|---|---|---|---|
| `delivery.publish:<type>` | `result.id` | `result._delivery` | TRANSIENT |
| `delivery.unpublish:<type>` | `params.id` | – | VALIDATION (missing id), TRANSIENT |
| `delivery.readStatus:<type>` | `params.id` | `result` | VALIDATION (missing id), TRANSIENT |
| `delivery.publishAll:<type>` | – | `result` | TRANSIENT |
| `delivery.exportIndexes` | – | `result._indexes` | TRANSIENT |
| `delivery.exportLlmsFull` | – | `result._llmsFull` | TRANSIENT |
| `delivery.markDependents:<type>` | `payload.id`, `payload.ids` | `result._dependents` | TRANSIENT |
| `delivery.markMoved` | `payload.moves` | `result._moved` | VALIDATION, TRANSIENT |
| `delivery.markAll:<type>` | – | `result.marked` | TRANSIENT |
| `delivery.checkBuild` | `payload.build` | `result` | VALIDATION, TRANSIENT |
| `delivery.republishOutput` | `payload.type`, `payload.docId`, `payload.locale` | `result` | VALIDATION, TRANSIENT |
| `delivery.requestIndexes` | – | – | TRANSIENT |
| `delivery.resumeStale` | – | `result` | TRANSIENT |
| `delivery.retryStale` | – | `result.retried` | TRANSIENT |
| `delivery.readStaleStatus` | – | `result` | TRANSIENT |

Status rows (`readStatus`, `_delivery`) also carry `stale` (marked for a re-render), `staleSince`, `staleFailed`
(the re-render failed `dependencies.maxAttempts` times), `staleError` and `dependencies` (how many dependencies the
last render recorded, `null` when they are unknown).

## Index files

`delivery.exportIndexes` writes `<prefix>sitemap.xml`, `<prefix>robots.txt` and `<prefix>llms.txt`;
`delivery.exportLlmsFull` writes `<prefix>llms-full.txt`. Neither runs inside an editor's request:
`delivery.requestIndexes` asks for both (see "Index exports" below), and a failed export never fails a
save or a render.

**Entries.** Both read the status rows of every delivered type page by page in id order and take every
row that serves a file: it has a path and is `live` or `error` (a failed render keeps serving its previous
output, so it stays listed). Each row's document is read again in that locale with the same published
check `delivery.publish` applies, so a row that has not caught up with a later draft save is skipped, and a
page whose merged `seo.noindex` is `true` is left out. URLs are `siteUrl` plus the path; two rows with the
same URL give one entry, the `live` one first, then the lower row id. Entries are sorted by URL.

**Guard.** When published documents exist but no row serves a file yet (before the first render, or after
every first render failed), sitemap.xml and llms.txt are left as they are and a warning is logged; robots.txt
is still written. A site whose every page is `noindex` gets an empty `<urlset>` and an llms.txt without
sections.

**sitemap.xml** (`application/xml; charset=utf-8`) lists one `<url>` per entry: `<loc>`, `<lastmod>` from the
document's own `updatedAt` for `live` entries only, and, for a document with more than one listed locale, an
`<xhtml:link rel="alternate" hreflang="…">` for each of them plus `hreflang="x-default"` for the default
locale. Values are XML-escaped. Without `siteUrl`, or with `sitemap: false`, no sitemap is written and a
stale one is removed; a missing `siteUrl` with the sitemap on logs one warning at setup. One file holds up to
50 000 URLs per the sitemaps.org limit; this module writes no sitemap index.

**robots.txt** (`text/plain; charset=utf-8`) is `User-agent: *` and `Allow: /` or `Disallow: /` from
`robots.policy`, then the lines of `robots.extra`, then `Sitemap: <siteUrl>/sitemap.xml` when a sitemap is
written. Without `robots.policy` the policy is `allow` when `NODE_ENV` is `production` and `disallow`
otherwise, and setup logs a warning that names the choice.

**llms.txt** follows [llmstxt.org](https://llmstxt.org): `# <settings title>` (default language; empty → the
host of `siteUrl`, otherwise `Website`), `> <settings description>`, one `## <headings[type] ?? type>`
section per delivered type with `- [<seo.title || title>](<url>): <seo.description>` per entry. An empty
`seo`/title field is filled from the default locale only when the default locale's own values are published
too, the same rule `delivery.publish` applies. Titles and descriptions are escaped so that editor-authored
text cannot introduce a stray line break or start with a heading marker.

**llms-full.txt** (with `llms.full: true`, which needs `"html"` in `formats`) holds the stored HTML of every
entry, restricted to `<main>` (matched greedily up to the last `</main>` tag, so a nested `<main>` does not cut
it short), converted with turndown: headings shifted three levels, so a page's own top-level heading becomes
`####` under its `###` page heading and `##` section heading, and root-relative links and images made
absolute with the origin of `siteUrl`. Each page's own recorded `html` key is read, falling back to the
format-name assumption only when that key does not lie under the page's own path. Without `llms.full`,
`delivery.exportIndexes` removes a stale `llms-full.txt` and `delivery.exportLlmsFull` writes nothing.

**Unchanged files** are not written again: each process keeps a hash of what it last wrote per file, so
the first export after a start always writes. The result gains `_indexes: { entries }` or
`_llmsFull: { entries }`; the outcome of each export (`at`, `entries`, `error`) is stored in `delivery_state`
and answered by `delivery.readStaleStatus` as `exports: { indexes, llmsFull }`. Both exports answer
`TRANSIENT` once the process is stopping.

**siteUrl** must be an absolute `http` or `https` URL without credentials, query or fragment. It is
normalized by lower-casing the host, dropping a default port and stripping trailing slashes; a base path
stays (`https://example.org/de/` → `https://example.org/de`), so the home page's URL is `https://example.org/de/`
and every other page's has no trailing slash. `normalizeSiteUrl` and `pageUrl` from
`@michaelthielemann/kestrel-delivery-static/impl` give that same form, for a canonical link that has to
equal the sitemap's `<loc>`.

## Dependent outputs

A published output (document × locale) shows more than its own document: the settings, the documents its blocks
reference, lists, the paths of the pages it links to, media. Each render records what it read, and a change to any
of it re-renders the output without the document itself being saved.

**What is recorded.** The paths `site.resolveLinks` answered for the document's links, and every read the renderer
made through this instance, in the same process, while it rendered. Reads are observed through
`@michaelthielemann/kestrel/reads`: `content-default` notes the documents, single types and filtered lists it answers,
`media-default` the media items, `site-default` the document a path resolved to (or the slug lookup that found
nothing). A renderer that fetches its page through this instance's API in the same process (a server-side rendered
frontend calling `/api` in memory) is observed completely. Reads of the published document itself are left out,
because its own save publishes it. The dependencies of one render are kept as one set in
`delivery_dependencies` and `delivery_dependency_sets`; a render that read more than
`dependencies.maxPerRender` things keeps one row per type for its largest groups instead. With
`dependencies.rendererReadsDocument: true`, a render in which the renderer did not read its own document is stored
with unknown dependencies and logs one warning per type: the reads were lost (another process, a socket, a cache).

**Not tracked.** Reads made in another process, over a socket, or answered from a cache kept across requests, and
lists bounded by time ("upcoming events", `date >= now`), which change without a write. For those,
`dependencies.maxAgeSeconds` makes `delivery.resumeStale` re-render every output older than that.

**Marking.** `delivery.markDependents:<type>` runs on a change event and takes the changed ids from the payload's
`id` and `ids`. It marks every `live` or `error` output whose last render read one of those documents, any document
of `<type>` as a whole, a list the store now puts one of them in (`content.list(<type>, { ...filter, id })` decides,
so list filters are never evaluated here), or a link whose path or published state changed. Outputs with unknown
dependencies are marked by every change. Drafts are never marked, and a re-render raises no content event, so a
change marks each dependent output once and a cycle of pages that show each other ends after one round.

**Moved paths.** `delivery.markMoved` runs on `site.pathsMoved` and takes `{ type, id, locale, from, to }` entries
from the payload's `moves`. It marks the moved documents' own `live` or `error` outputs in those locales, which a
change of their own document would not mark, and then every output that linked to one of them at a path that is
no longer current. The re-render stores each output at its new path and removes the old path's files unless
another output owns them, so two pages that swapped slugs each end up at their new path.

```ts
triggers: [{ event: "site.pathsMoved", pipeline: "pathsMovedDelivery" }],
definePipeline({ name: "pathsMovedDelivery", steps: ["delivery.markMoved"] });
```

**Rendering, never inside the request.** `dependencies.render` chooses who renders a marked output:

- `"background"` (default): the process that marked it, in a background loop of its own that starts with the first
  mark and renders one output at a time. The loop is detached from the request: the request never waits for it.
  Other processes' loops never render a row claimed here.
- `"events"`: every mark raises `delivery.outputStale` (`{ type, docId, locale, coalesceKey }`) through `events@1`,
  and a pipeline with `delivery.republishOutput` subscribed to it renders the output. With `events-queue`, at
  most one job per output is pending at a time, and the pipelines belong in lanes of their own, so re-renders and
  the exports never delay other queued work and the index files never wait for a re-render backlog:

```ts
modules: [
  {
    use: "@michaelthielemann/kestrel-events-queue",
    config: { lanes: { pages: ["republishOutput", "refreshLlms"], indexes: ["refreshIndexes"] }, delayMs: { refreshIndexes: 1000, refreshLlms: 3000 } },
  },
  {
    use: "@michaelthielemann/kestrel-delivery-static",
    config: { types: { pages: {} }, siteUrl: "https://example.org", robots: { policy: "allow" }, llms: { full: true }, dependencies: { render: "events", rendererReadsDocument: true } },
  },
],
triggers: [
  { event: "page.updated", pipeline: "pageDependents" },
  { event: "settings.updated", pipeline: "settingsDependents" },
  { event: "media.updated", pipeline: "mediaDependents" },
  { event: "media.deleted", pipeline: "mediaDependents" },
  { event: "media.trashed", pipeline: "mediaDependents" },
  { event: "media.restored", pipeline: "mediaDependents" },
  { event: "images.variantsChanged", pipeline: "mediaDependents" },
  { event: "delivery.outputStale", pipeline: "republishOutput" },
  { event: "delivery.indexesStale", pipeline: "refreshIndexes" },
  { event: "delivery.llmsStale", pipeline: "refreshLlms" },
  { cron: "*/5 * * * *", pipeline: "resumeStalePages" },
],
```

```ts
definePipeline({ name: "pageDependents", steps: ["delivery.markDependents:pages"] });
definePipeline({ name: "settingsDependents", steps: ["delivery.markDependents:settings", "delivery.requestIndexes"] });
definePipeline({ name: "mediaDependents", steps: ["delivery.markDependents:media"] });
definePipeline({ name: "republishOutput", steps: ["delivery.republishOutput"] });
definePipeline({ name: "refreshIndexes", steps: ["delivery.exportIndexes"] });
definePipeline({ name: "refreshLlms", steps: ["delivery.exportLlmsFull"] });
definePipeline({ name: "resumeStalePages", steps: ["delivery.resumeStale"] });
```

Every other page event (`created`, `restored`, `translationRemoved`, `deleted`) and every collection a page can
show needs its own dependents trigger the same way, and the pipeline that writes it must emit the event
(`examples/minimal`'s `setSettings` emits `settings.updated` after its atomic group). The
`media.trashed` and `media.restored` triggers belong to a deployment that composes `media-default`'s
trash pipelines; without a pipeline that raises them, boot warns about each.

Boot fails with `"events"` unless a trigger runs `delivery.republishOutput` on `delivery.outputStale` and
`delivery.exportIndexes` on `delivery.indexesStale`, and, with `llms.full`, `delivery.exportLlmsFull` on
`delivery.llmsStale`; it also fails under `events-direct`, which would run every re-render inside the request that
marked it.

**Index exports.** `delivery.requestIndexes` belongs after every step that changes what the index files list:
`delivery.publish`, `delivery.unpublish`, a settings change, `delivery.publishAll` or `delivery.markAll`, and the
pipeline that runs `delivery.checkBuild` at boot, so a changed `siteUrl` or `robots.policy` reaches the files after a
restart. It runs nothing itself:

- With `"events"` it raises `delivery.indexesStale` (`coalesceKey: "indexes"`) and, with `llms.full`,
  `delivery.llmsStale` (`coalesceKey: "llms"`). Both events carry no other data: coalescing keeps the first event of a
  window, and both exports read the current state. With `events-queue`, `delayMs` holds each job back for a fixed
  window, so one export follows a burst of saves; a delayed pipeline is never relayed into the request.
- With `"background"` the loop exports the index files once `dependencies.indexesDelayMs` (default 1000) passed
  after the first request, before its next batch of at most five renders, so the files never wait for a re-render
  backlog. A failed index export is logged and retried after `dependencies.backoffSeconds`, and the renders go on.
  llms-full.txt is exported once no render is due, with the same retry.

After each re-render, llms-full.txt is asked for again (it reads the HTML), and the index files only when the
output's path changed or the output started or stopped serving a file; a `live` output that fails and keeps its path
asks for nothing. `delivery.resumeStale` asks for the index files on every run, which also repairs a lost or
dead-lettered export and removes a deleted page that never got its export, and asks for llms-full.txt again while
its last export failed.

A render that fails keeps the previous output (`state: "error"`), records `staleError` and is tried again after
`dependencies.backoffSeconds`, up to `dependencies.maxAttempts` times; with `"events"`, set both to the event
delivery's own values. A render that throws counts as a failed attempt. Rows of a type or a locale that is no longer
delivered are never marked. The loop claims up to five marked outputs at a time and renews the claim before each
render; a row whose claim another process took over in the meantime is left to that process. Every render is bounded by `dependencies.renderTimeoutSeconds` per format (times the
number of formats, it must stay below `claimTtlSeconds`): a
render abandoned at the timeout is never written, but keeps its memory until it settles, and
`readStaleStatus.abandoned` counts those.

**Concurrent renders, unpublish, crashes.** Every status write compares and increments the row's `version`, so an
older render never overwrites a newer write. A render that loses removes the files it wrote, unless an output is
live at that path, and marks its output again whenever that output is still `live` or `error`, so the newer write
is always followed by a render of the current content. `delivery.unpublish` leaves a `deleted` row for every locale
(also one that was never rendered), which blocks a render still in flight, and which `delivery.resumeStale` removes
after `claimTtlSeconds`; reads never return it.

**Removes exactly what it wrote.** Each status row keeps the blob key its own `live` or `error` output wrote per
format, taken from the renderer's own `extension`, not derived from the format name – a renderer whose extension
differs from its format leaves nothing behind. Unpublish, a slug or locale change, a losing or partly failed render's
cleanup and the tombstone sweep all remove exactly those recorded keys, and a re-render that no longer writes a key
its previous render did removes that one key too, whether or not the path itself changed; only a key that still lies
under the path being cleaned up is ever touched, and a path or key that another live or error output still owns is
never removed. A row written before this was recorded derives its keys once, the same way an unpublish always did,
from its path and the currently configured formats, and remembers the result for the next removal instead of
deriving it again; recorded keys that no longer lie under the row's own path (an older process moved it without
knowing about them) are never trusted and are derived afresh the same way; that derivation is only ever recorded onto
a row still at the path it was derived for, so a render that lands back on its own recorded path right after the
move never has its own, correct write overwritten by the stale derivation. A re-render that writes fewer keys at the
same path removes the difference without recording a path change, so it never marks its own output stale over its
own cleanup; `delivery.exportLlmsFull` reads each page's own recorded `html` key the same way.

**Changes that overlap a render.** A render reads a document for the first time; the document changes and is
marked before the render has recorded its dependencies, so the mark finds nothing. To close that gap without
comparing clocks, `delivery.markDependents` first takes the next number of a sequence kept in `delivery_state`
(compare-and-swap, so every process agrees on the order) and records the change under that number in
`delivery_changes`, and only then looks for dependents. Every render reads the sequence before it reads anything
else, and after its status write it looks at the changes numbered above that: when one of them touched something the
render read (a document by id, or any document of a type it listed or read as a whole), the output is marked again
before its old mark is cleared. A change numbered at or below the render's start was made before the render read
anything, so the render saw it; a change whose record appears only after that look starts its own search for
dependents afterwards and finds the dependencies the render has just recorded. Removing a path's files is recorded
the same way, so a page that moved onto the path in the meantime is marked and writes its files again. Only the last
10 000 changes are kept, pruned by number; a render that started before the kept range counts as overlapped. A
failed render that stays marked for its retry keeps its attempt count and backoff; a change of the output's own
document is left to that document's own publish.

**Dependency sets** are written as `pending` before the status row names them, become `current` after the status
write and `retired` when a later render replaces them, so a crash leaves either the previous complete set or a
pending or retired set that `delivery.resumeStale` adopts or removes; it reads no set that is in use. The one way a
removed page can remain is a process that stops between a losing render's file write and its cleanup.

**Operations.** `delivery.markAll:<type>` marks every output of a type, creating a marked row for a document that
was never delivered (drafts are checked and never rendered), and answers `{ marked }` at once.
`delivery.checkBuild` compares `payload.build` with the build stored in `delivery_state`; on a change it marks every
output of every delivered type and stores the build only afterwards, so a failed or interrupted run marks again on
the next start. Run it after every deploy: every output is then re-rendered, and its dependencies recorded by the new
code. It answers `{ changed, restored, marked }`.

**A restored database.** A database restored from a backup holds older status rows than the files in the blob
store. `delivery.checkBuild` keeps a random marker both in `delivery_state` and in the blob `.delivery-static-marker`
(at the blob store's root, outside `prefix`) and replaces it in both after every check, on every
`delivery.resumeStale` run after an output changed, and when the process stops. When the two differ at the next
check, the database is older than the files: every output is marked as for a new build, `restored` is `true`, and
a warning is logged. A process that never ran `delivery.checkBuild` writes no marker.

`delivery.resumeStale` (a recovery net, not the render path) releases expired claims, removes tombstones and
orphaned sets, re-raises marks that are older than a minute, due and unclaimed, for example after a process
stopped, and asks for the index exports (see above). Once per database it also removes `index.<ext>` files under
`prefix` at paths no status row has, which older versions could leave behind after a failed render followed by a
slug change; files under `reservedPaths` and every other file are left alone. It waits while an output is marked or
rendering, or while a published document has no `live` output, and gives up a run during which a page was rendered;
each removed file is logged, and the completed run is recorded in `delivery_state`, so it never runs again. It
answers `{ released, swept, dispatched, aged, orphans }`. `delivery.retryStale` gives outputs that failed
`maxAttempts` times new attempts. `delivery.readStaleStatus` answers
`{ stale, failed, rendering, unknown, oldestStaleAt, abandoned, exports }`.

Not included: CDN invalidation, a sitemap index for more than 50 000 URLs.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-delivery-static` – module `delivery/static`: provides no contract; requires `content@1`, `renderer@1`, `blobstore@1`, `persistence@1`, `site@1`; optional `events@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `types` | record | yes | – |
| `formats` | array | no | `["html"]` |
| `prefix` | string | no | `""` |
| `prefixPrimary` | boolean | no | `false` |
| `fallback` | boolean | no | `true` |
| `reservedPaths` | array | no | `[]` |
| `siteUrl` | string | no | – |
| `sitemap` | boolean | no | `true` |
| `robots` | object | no | `{}` |
| `robots.policy` | enum | no | – |
| `robots.extra` | array | no | `[]` |
| `llms` | object | no | `{}` |
| `llms.full` | boolean | no | `false` |
| `llms.settings` | object | no | `{}` |
| `llms.settings.type` | string | no | `"settings"` |
| `llms.settings.titleField` | string | no | `"title"` |
| `llms.settings.descriptionField` | string | no | `"description"` |
| `llms.titleField` | string | no | `"title"` |
| `llms.seoField` | string | no | `"seo"` |
| `llms.headings` | record | no | `{}` |
| `dependencies` | object | no | `{}` |
| `dependencies.render` | enum | no | `"background"` |
| `dependencies.rendererReadsDocument` | boolean | no | `false` |
| `dependencies.maxPerRender` | integer | no | `1000` |
| `dependencies.renderTimeoutSeconds` | integer | no | `60` |
| `dependencies.maxAttempts` | integer | no | `5` |
| `dependencies.backoffSeconds` | array | no | `[60,300,900,3600]` |
| `dependencies.claimTtlSeconds` | integer | no | `300` |
| `dependencies.maxAgeSeconds` | integer | no | `null` |
| `dependencies.indexesDelayMs` | integer | no | `1000` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `delivery.publish:<arg>` | Render and store published locales of a <arg> (adds `_delivery` to the result) | `result.id?`, `payload` | `result._delivery` | object | { _delivery: object[], … } | 400 no document id in the result or the event payload | – | no |
| `delivery.unpublish:<arg>` | Remove rendered output of a <arg> | `params.id`, `payload` | – | object | – | 400 no document id in params or the event payload | – | no |
| `delivery.readStatus:<arg>` | Publish status per locale of a <arg> | `params.id` | `result` | – | object[] | 400 missing id | – | yes |
| `delivery.publishAll:<arg>` | Re-render every <arg> | – | `result` | – | { documents: number, live: number, errors: number, … } | – | – | no |
| `delivery.exportIndexes` | Write sitemap.xml, robots.txt and llms.txt from the outputs that serve a file (live or error) of every delivered type, skipping noindex pages (adds `_indexes: { entries }` to the result) | – | `result._indexes` | – | { _indexes: object, … } | 503 a file could not be written or a dependency failed | – | no |
| `delivery.exportLlmsFull` | Write llms-full.txt from the stored HTML of the same entries when `llms.full` is set (adds `_llmsFull: { entries }` to the result) | – | `result._llmsFull` | – | { _llmsFull: object, … } | 503 the file could not be written or a dependency failed | – | no |
| `delivery.markDependents:<arg>` | Mark every published output whose last render read the changed <arg> (payload id and ids) for a re-render, and start it outside the request (adds `_dependents: { marked }` to the result) | `payload` | `result._dependents` | object | { _dependents: object, … } | 503 the marks or their jobs could not be written | – | no |
| `delivery.markMoved` | Mark the own outputs of every document in payload.moves (site.pathsMoved) and every output linking to one of them for a re-render at its new path, and start it outside the request (adds `_moved: { marked }` to the result) | `payload` | `result._moved` | { moves: object[], … } | { _moved: object, … } | 400 payload.moves is missing or malformed; 503 the marks or their jobs could not be written | – | no |
| `delivery.markAll:<arg>` | Mark every <arg> output for a re-render in the background, including documents that were never delivered (adds `marked` to the result) | – | `result` | – | { marked: integer, … } | 503 the marks or their jobs could not be written | – | no |
| `delivery.checkBuild` | Mark every delivered output for a re-render when payload.build differs from the stored build or the database was restored from a backup, then store it | `payload` | `result` | { build: string, … } | { changed: boolean, restored: boolean, marked: integer, … } | 400 payload.build is missing; 503 the marks could not be written; the build is not stored | – | no |
| `delivery.republishOutput` | Render one marked output (payload type, docId, locale) under a claim; a failed render is recorded on the output and answered as an error so the event delivery retries it | `payload` | `result` | { type: string, docId: string, locale: string, … } | { rendered: boolean, state: "live" \| "error" \| "draft" \| null, … } | 400 payload needs type, docId and locale; 503 the render failed or another render holds the output | – | no |
| `delivery.requestIndexes` | Ask for a sitemap.xml, robots.txt and llms.txt export (and an llms-full.txt export with `llms.full`) without running it here | – | – | – | – | 503 the request could not be queued | – | no |
| `delivery.resumeStale` | Release expired render claims, remove old tombstones and orphaned dependency sets, start the re-renders a stopped process or a lost job left marked, and ask for an index export | – | `result` | – | { released: integer, swept: integer, dispatched: integer, aged: integer, orphans: integer, … } | – | – | no |
| `delivery.retryStale` | Reset the attempts of every output whose re-render failed maxAttempts times and start it again (adds `retried` to the result) | – | `result` | – | { retried: integer, … } | – | – | no |
| `delivery.readStaleStatus` | How many outputs wait for a re-render, failed it, are rendering or have unknown dependencies, the oldest mark, the renders this process abandoned at the timeout, and the last index and llms-full.txt exports | – | `result` | – | { stale: integer, failed: integer, rendering: integer, unknown: integer, oldestStaleAt: number \| null, abandoned: integer, exports: object, … } | – | – | yes |

Pipelines in `examples/minimal` using these steps:

- **mediaDependents** (event media.updated, event media.deleted, event media.trashed, event media.restored, event images.variantsChanged): **`delivery.markDependents:media`**
- **pageDependents** (event page.created, event page.updated, event page.restored, event page.translationRemoved, event page.deleted): **`delivery.markDependents:pages`**
- **pagePublishStatus** (GET /admin/publish-status/pages/:id): `authn.requireUser` → `authz.requireRole` → `authz.require:pages.manage` → **`delivery.readStatus:pages`**
- **pathsMovedDelivery** (event site.pathsMoved): **`delivery.markMoved`**
- **publishAllPages** (POST /admin/publish-all/pages): `authn.requireUser` → `authz.requireRole` → `authz.require:pages.manage` → **`delivery.publishAll:pages`** → `redirects.export` → **`delivery.requestIndexes`**
- **publishPage** (event page.created, event page.updated, event page.restored, event page.translationRemoved): **`delivery.publish:pages`** → **`delivery.requestIndexes`**
- **resumeStalePages** (cron */5 * * * *): **`delivery.resumeStale`**
- **settingsDependents** (event settings.updated): **`delivery.markDependents:settings`** → **`delivery.requestIndexes`**
- **unpublishPage** (event page.deleted): **`delivery.unpublish:pages`** → **`delivery.requestIndexes`**

<!-- kestrel-docs:end -->
