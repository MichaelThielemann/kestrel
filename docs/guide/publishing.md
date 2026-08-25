# Saving, publishing and previewing

Save writes to the database, publish writes the static output, and preview shows a record — draft or unsaved — without doing either.

## Save ≠ publish ≠ preview

Saving a record writes the DB and leaves the live site alone. **Publishing** is the separate action that
writes the static file(s) for a record: `POST /api/publish` (admin-only body `{ collection, ids?, id? }`,
at most 500 ids per call).
**Preview** shows a record's rendered page — published or not, saved or not — without writing anything to
the DB or the static output. The editor's Publish button always saves first: it promotes a draft to
`published` (a statusless collection has nothing to promote), submits the form, then calls `/api/publish`
for the saved id — a single action, not "save" and "republish current state" as two independent choices.
`/api/publish` itself is a pure republish of whatever the DB already holds; called directly (or by a
future caller with no form to submit) it does not touch `status`. See "Preview in a new tab" below.

A save acts on the static output in exactly one direction: **removal**. Unpublishing or deleting a record
prunes its page immediately, and re-renders whatever links to it (see the table below), because a page
taken offline must not stay live. Every other change to what's on the live site — a fresh render — waits
for an explicit publish. The one exception is the Redirects singleton, whose save writes `redirects.json`
straight to the output on the spot — see [redirects.md](./redirects.md).

## The publish action

`POST /api/publish` looks up the given ids (all-or-nothing: an unknown id 404s before anything is
enqueued), classifies each write, and enqueues an incremental republish of exactly the routes it affects:
the record's own page plus any listing or page that links to it. It also prunes the record's own abandoned
URLs — the file a published rename left behind at the old path. The run is enqueued on the debounced
publish queue and completes after the response returns, so the response reports what was **queued**, not
what already ran; a failing route is isolated later and does not block the rest of the batch.

```ts
// 200 response shape
interface PublishResponse {
  queued: boolean        // true if anything was enqueued
  generates: boolean     // false in dev, or when output.auto is off — nothing will ever render
  routes: string[]       // routes queued for render
  pruned: string[]       // abandoned routes queued for removal
  drafts: number[]       // ids that are still drafts — reported back, never promoted
}
```

A draft id among the ones you asked to publish is reported in `drafts` rather than silently promoted — the
route never touches `status`, so a draft stays a draft with no public output to write. `generates: false`
means this environment produces no files at all (dev, or `output.auto` off); the editor surfaces that as
its own toast rather than claiming success.

## What a save invalidates

A write to a record can affect other pages in three ways, and only some of them run at save time:

| Event on the record | Its own page | Listings of its collection | Pages that link to it | Pages below it in the URL path |
|---|---|---|---|---|
| Content edit | re-render (if published) | re-render | re-render (fresh data/label) | re-render (the crumb label may have moved) |
| Slug / path change | prune old page + render new | re-render | re-render (link path updates) | re-render under both the new and the old path |
| Publish | render | re-render (joins the set) | re-render (a baked placeholder link becomes real) | re-render (the crumb appears) |
| Unpublish | **prune immediately** | **re-render immediately** (leaves the set) | **re-render immediately** (link falls back to a placeholder) + editor warned | **re-render immediately** (the crumb disappears) |
| Delete | **prune immediately** (+ media derivatives) | **re-render immediately** (leaves the collection) | **re-render immediately** (link falls back to a placeholder) + editor warned | **re-render immediately** (the crumb disappears) |
| Create (published) | render | re-render (joins the set) | — (nothing could point at it yet) | re-render — a page can be created below an already-published page |
| `seo.noindex` flip | re-render | re-render | re-render | re-render (a noindexed page is nobody's crumb) |

Only **Unpublish** and **Delete** run immediately, on the save itself — a page taken offline, and
everything that pointed at it, must not stay stale. "+ editor warned" means Kestrel additionally tells the
editor that a referrer now points at a dead target — see
[references.md § Dead-reference warnings](./references.md#dead-reference-warnings). Every other row waits for an explicit publish of the
affected record — unless `output.publishOnSave` is on (below), which runs every row on the write itself.
The "pages below it in the URL path" column exists because a page's breadcrumb trail bakes its ancestors'
labels: publishing a section index re-renders every page beneath it, and the home page is an ancestor of
the whole site, so publishing `/` re-renders everything. See
[internals/publishing.md](../internals/publishing.md) for how this is derived and kept correct as records
move.

## Opting out: `publishOnSave`

```ts
// kestrel.config.ts
export default {
  output: {
    publishOnSave: true, // env: KESTREL_OUTPUT_PUBLISH_ON_SAVE=1
  },
} satisfies KestrelConfig
```

With `publishOnSave` on, every content write republishes the pages it affects, exactly as the table above
describes, with no separate publish step. The editor then hides its Publish button and never reports
"Outdated" (below), a full publish holds nothing back, and `POST /api/publish` keeps working as a manual
"republish this now". It's a per-environment choice like every other `output` key; the default (`false`)
is the save/publish split.

## The incremental publisher

```ts
// kestrel.config.ts
export default {
  output: {
    auto: true,             // publish on content writes (default)
    dir: '.data/published', // local target (or driver: 's3' + an s3 block)
    reconcileMinutes: 0,    // optional periodic full reconcile, 0 = off
    verbose: false,         // log a timestamped per-route line (rendered/pruned) per run
  },
} satisfies KestrelConfig
```

- **`auto`** (default `true`) is the switch for whether the running server publishes at all. With it off
  (or in dev, where it's always off), content writes enqueue nothing and the editor reports
  `generates: false`; a deploy then needs `nuxt generate` (or a CI step) to produce the static output
  ahead of time instead.
- **`dir`** (or an S3 target via `driver: 's3'`) is where the runtime publisher writes — a local
  `nuxt generate` deploy writes `.output/public` instead, see [deploying.md](./deploying.md).
- **`reconcileMinutes`** (default `0`, off) runs an optional periodic *full* publish — every route
  re-rendered, everything that left the published set pruned — that self-heals any missed invalidation
  and picks up a template or component deploy that no content write would invalidate. A full republish is otherwise reserved
  for server boot; a normal content write never triggers one.
- **`verbose`** adds a timestamped per-route line (`[kestrel] <ts> rendered <path>` / `pruned <path>`) on
  top of the one-line run summary, for traceability while editing. A boot or reconciler full publish stays
  a count summary regardless.

These non-auth `output.*` values (and their `KESTREL_OUTPUT_*` env equivalents) are read at **module
setup**, so a prebuilt server needs the runtimeConfig names (`NUXT_KESTREL_OUTPUT_DIR`, `NUXT_KESTREL_OUTPUT_DRIVER`, …) instead — see
[configuration.md § Precedence](./configuration.md#precedence).

**Boot publish.** On startup the server runs a full publish, detached so it never blocks boot: it resyncs
this build's hashed client bundle and re-records every route's dependencies, so a route unpublished or
deleted while the server was down is still pruned once it comes back.

**Held-back routes.** A route whose record was saved again after its last publish keeps serving the file
that publish wrote — neither a restart, a reconcile, nor someone else's Publish action puts
work-in-progress on the live site. This is keyed to the record, not the route string, so a
saved-but-unpublished rename keeps serving its old URL rather than publishing the new one; a route that
has never been published under any URL is not held back — otherwise a first deploy would produce an empty
site. The cost is deliberate: a withheld route keeps the baked links and hreflang of its last publish, so
a link to a record that has since been unpublished stays stale until the referrer itself is published —
the same staleness the withheld route's own body already carries.

**Per-route status.** Each publish attempt records its outcome in a durable per-route table: `success`
once the file is written, or `error` with the failure message (render, write, or S3) when an attempt
throws. A failing route is isolated — it's recorded and logged, and the rest of the run continues. A
prune (unpublish, delete, slug change) clears the route's row. The editor reads this through the
admin-only `GET /api/publishStatus?collection=&id=` to drive the right-hand status dot below.

## Pruning is always on

A record's own static file always matches its DB state — published → rendered, unpublished or deleted →
pruned — on every target, local or S3, with no toggle: output tracks the database, not the other way
round. The publisher tracks every route it wrote in a durable index, and on every FULL publish removes the
ones that have left the published set; an incremental publish prunes only the routes its own write
abandoned. A media delete additionally removes the original and every generated derivative.

## Preview in a new tab

- The editor toolbar's **"open in new tab"** button opens the record's real public URL when there are no
  unsaved changes. With unsaved changes it instead posts the current form body to
  `POST /api/createPreview` (admin-only, in-memory, ~10 minute TTL) and opens
  `<url>?kestrel-preview-token=…`, which lays those values over the stored record without writing to the
  DB or publishing anything. The tab carries a "Preview — unsaved changes" badge and `noindex`. A record
  with no public URL yet (never saved, blank slug, or not page-like) previews the same way on
  `/__kestrel/preview`.
- An authenticated admin can also preview an **unpublished** page at its real URL: `GET /api/route` is
  readable by anyone but scoped per principal — anonymous requests and the static render stay
  published-only, while an admin session resolves drafts. A "Draft preview" badge marks the page so it's
  never mistaken for live.
- A two-dot status indicator in the toolbar shows the record's state. The **left** dot is the save
  lifecycle: amber (unsaved/saving), blue (saved Draft), green (saved and published, or just saved for a
  statusless collection). The **right** dot (page-like collections only) is the page's live/generated
  state, read from `GET /api/publishStatus`: green (published, last publish succeeded — the tooltip names
  where the file landed, local or S3), red (last publish errored — the tooltip shows the message and
  when), amber **"Outdated"** (published, but saved again since — the live page is an older version, the
  normal state while editing), amber "Generating…" (published, no success row yet — a republish is in
  flight), blue "Not live" (a saved Draft — intentionally not generated), blue "Not published" (never
  published, and nothing is queued until someone presses Publish), and neutral "Not built" — this
  environment never produces the file at all (dev, or `output.auto` off), shown instead of an "Outdated"
  that no action here could fix. It refreshes on load and after each save.

In **dev** the publisher never runs (a dev render would ship un-hashed Vite HTML), so `generates` is
always `false` there and the right dot reads neutral "Not built" for anything that would otherwise report
a generated state; run a production build to see real publish state.

## Delivery: static vs. live

`delivery: 'static' | 'live'` (env `KESTREL_DELIVERY`) picks which port serves published content. Default
`'static'` — publish writes pre-rendered files, exactly as described above. `'live'` serves each request
straight from the publish history the incremental publisher already writes, instead of from a file on
disk. It's read once at boot; flipping it needs a restart, not a per-request override. Static file
generation keeps running under `'live'` too, so the two stay byte-comparable — but only when the publisher
is actually running: `delivery: 'live'` still requires `output.auto: true` on a production server, or
nothing is ever recorded to serve.

```ts
// kestrel.config.ts
export default {
  delivery: 'live',
  deliveryExempt: ['/health'], // paths the live catch-all must never answer
} satisfies KestrelConfig
```

`deliveryExempt` (env `KESTREL_DELIVERY_EXEMPT`, comma-separated) reserves extra paths on top of the
built-in exemptions (`/api/`, `/admin/`, `/_nuxt/`, `/__kestrel/`, Nitro internals, the meta routes) — use it for a
runtime route mounted at the app origin, such as a health check, that would otherwise be shadowed by the
`'live'` catch-all. Matching is at a path-segment boundary: `'/health'` exempts `/health` and everything
under it, but not a sibling like `/health-check` that merely shares the prefix.

## See also

- [configuration.md](./configuration.md) — the `output.*` config surface, precedence and env var names in full.
- [internals/publishing.md](../internals/publishing.md) — how the invalidation model is derived and stays correct as pages move.
- [multilingual.md](./multilingual.md) — how locale prefixes affect published paths and hreflang.
- [deploying.md](./deploying.md) — running the incremental publisher against S3 vs. a local target in production.
- [redirects.md](./redirects.md) — the redirects singleton's own write-on-save path.
- [references.md](./references.md) — dead-reference warnings in full.
- [blocks.md](./blocks.md) — the in-editor live preview (the page builder iframe), a different mechanism from the new-tab preview on this page.
