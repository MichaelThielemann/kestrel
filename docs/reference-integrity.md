# Reference integrity

Kestrel keeps the cross-references between content records valid as records change. Three mechanisms work
together, all **derived from the live DB on the fly** — nothing is stored as a "message" that could itself
go stale:

1. **Precise invalidation** — a content write re-publishes exactly the pages it affects, no more.
2. **Dead-reference warnings** — when a referrer points at a deleted/unpublished target, the editor is
   warned. The output is rebuilt (the link degrades to `#`); nothing auto-*repoints* the reference.
3. **Slug integrity** — every routable record has a required, globally-unique slug, so one URL maps to one
   record.

## The invalidation model

A write to record *A* can affect other pages in three ways:

- **Listings** — a page that QUERIES *A*'s collection (an overview rendering `list(posts)`). It depends on
  the collection, not a specific row → captured as the tag `<collection>`.
- **Explicit referrers** — a page that LINKS to *A*, embeds *A*'s data, or has a relation/media field to
  *A* → captured as the tag `<collection>:<id>` (resolving/embedding *A* reads it by id).
- **Descendants** — a page whose path sits BELOW *A*'s and therefore bakes *A* as a breadcrumb step. It
  captures **two** tags per ancestor: `#path:<path>` *and* the `<collection>:<id>` of whatever record sits
  there, invisible ones included.

The third one needs both edges, and neither covers the other.

`#path:` exists because Kestrel has **no parent/child relation** between pages: `path` is a plain column,
an auto-generated slug is always flat, and nesting exists only because an editor typed slashes into one —
so "descendant" *is* a path-prefix match. A page **created** at `/blog` after `/blog/hello` was published
has no id anything could have captured beforehand; a path is knowable before its page exists. So a page
subscribes to every ancestor path it *looked in*, including the ones with no page and the ones whose
lookup failed.

`<collection>:<id>` exists because a write's tags name where the record is **now**, not where it was. The
explicit publish action classifies its write as `before === after` (`publish.post.ts` — a re-render of the
record's current state), so a rename, a `noindex` or an unpublish is simply not visible in it: publishing
`/blog` after renaming it to `/news` emits `#path:/news`, which no descendant of `/blog` ever captured. The
record tag is in that write's tag list whatever the row looks like, so it is what repairs the trail — which
is why it is captured *before* the published/`noindex` filters, so a draft or shadowing row that is
currently no crumb still carries the edge that fires when it goes away. (`publishedAlternates` pairs a
group tag with a record tag for exactly the same reason.)

Two more properties worth knowing. `#path:` is deliberately **locale-less** (a non-translatable record has
no locale to name, and a descendant must still be reached when a locale-less page appears above it), so it
over-approximates across locales — extra re-renders, never a stale page. And it is emitted whenever the
record is a visible crumb on either side of the write, without asking whether the *label* changed, for the
same `before === after` reason.

Publishing a section index therefore re-renders the pages under it — the honest cost of a baked breadcrumb,
and, since a save renders nothing by default (ADR-0008), a cost paid only on an explicit publish. The
extreme of that is the **home page**, which is an ancestor of every page: publishing `/` re-renders the
whole site.

The publisher records, per published route, the tags it read while rendering — a durable `route → tags`
index (`publish_deps`) that **survives restarts**, so a page unpublished/deleted while the server was down
is still pruned on the next boot. A write maps its changed tags back to exactly the routes they affect.

What each event invalidates (the agreed model — `layers/public/server/utils/publish/invalidation.ts`):

| Event on record A | A's own static file | Listings (`<coll>`) | Explicit referrers (`<coll>:<id>`) | Descendants |
|---|---|---|---|---|
| Content edit | re-render (if published) | re-render | **re-render** (fresh data/label) | re-render (the crumb label may have moved) |
| Slug / path change | prune old route + render new | re-render | **re-render** (link path updates) | re-render under **both** paths — the new one via `#path:`, the old one via `<coll>:<id>` |
| Publish | render route | re-render (joins the set) | **re-render** (the baked `#` becomes the real path) | re-render (the crumb appears) |
| Unpublish | **prune route file** | re-render (leaves the set) | **re-render** (link falls back to `#`) + warned | re-render (the crumb disappears) |
| Delete | prune route file (+ media derivatives) | re-render (leaves the collection) | **re-render** (link falls back to `#`) + warned | re-render (the crumb disappears) |
| Create (published) | render route | re-render (joins the set) | — (no id can point at it yet) | **re-render** via `#path:` — the edge only a path tag can carry |
| `seo.noindex` flip | re-render | re-render | re-render | re-render via `<coll>:<id>` (a noindexed page is in no trail) |

A record that is unpublished, `noindex`ed or path-less is nobody's crumb, so writes to it emit no `#path:`
tag — the same rule the breadcrumb lookup applies. Its `<coll>:<id>` still reaches the descendants that
captured it, which is what makes those rows' *removal* repair the trail rather than leaving it stale.

**When each row runs is a separate question from what it contains** (ADR-0008). A *save* only executes the
rows that REMOVE output — Unpublish and Delete — and it executes them immediately, because a page taken
offline must not stay live. Every rendering row waits for an explicit **publish** (`POST /api/publish`, the
editor's Publish button, or the `publish:run` task), which plans exactly the same invalidation from the
record's current state. So the table is the model; publishing is when it is applied — unless `output.publishOnSave` is on, which
puts every row back on the write itself (see [static-output.md](./static-output.md)).

Two principles drive it:

- **Freshening → re-render.** A change to *A*'s **content** or **path** re-renders its dependents (listings
  *and* explicit referrers) so their output stays fresh.
- **Availability → re-render both; still warn.** Publishing/unpublishing/deleting *A* re-renders listings
  (collection membership changed) **and** explicit referrers, because a referrer's *baked* output encodes
  *A*'s availability: link resolution is status-gated (a draft/missing target bakes `href="#"`) and a page's
  hreflang set lists only its published translation siblings. Only a re-render can move those. The editor is
  warned on top (next section), because a link that now renders `#` is correct output for a broken
  reference, not a fixed reference.

Descendants follow the same two principles — a crumb bakes an ancestor's label (freshening) and whether it
is a crumb at all (availability) — with one extra: a page can depend on an ancestor that **does not exist
yet**, which is why that edge is the only one keyed on something other than a record.

A `full` republish (every route + prune of everything that left the published set) is reserved for the boot
publish and the optional reconciler; a normal content write never triggers one.

### Status-gated links

An internal link renders the **target's real path** only when the target is publicly linkable: it exists
and — if its collection has a `status` column — is published. A *missing* **or** *draft* target renders
`#`, so a draft's slug never leaks into published HTML; a target whose collection has no `status` column
resolves unconditionally. (`isPubliclyLinkable` / `resolveInternalHref` in `link-resolve.ts`; richtext
`kestrel:` markers and the editor preview resolve through the same function.)

Because the baked `href` therefore encodes the target's availability, the link populator captures **every**
internal target as a read dep — a draft or dangling one included — so the `<coll>:<id>` tag an availability
change emits reaches the referrers that baked `#` (`captureRead` in `populate-links.ts`).

### Pruning is always-on

A record's own static artifact always matches its DB state — published → rendered, unpublished/deleted →
pruned — on every target (local *and* S3), with no opt-in toggle (**output ≡ DB**); see
[static-output.md](./static-output.md). A media delete additionally removes the original **and every
generated derivative** (the WebP ladder).

## Dead-reference warnings

Re-rendering a referrer only makes its output *honest* (a dead link becomes `#`), so Kestrel additionally
**warns** the editor that a referrer now points at a dead target — across **all** reference types: relation and media fields, the
internal `link` field, richtext internal links, and any of those nested inside block / repeater fields.

- **What is "dead":** a *deleted* target always; an *unpublished* target too **when the target collection
  has a `status` column** (so a consumer's own status field is honoured automatically). A non-status target
  is dead only if deleted. The reasons surface as `missing` / `unpublished`.
- **How it works:** every write maintains a durable `record_refs` index — `(sourceColl, sourceId) →
  (targetColl, targetId)` over every reference the record holds, indexed both forward and reverse. Warnings
  are **derived on read** by checking each target's existence/status — never stored — so a warning
  auto-clears the moment the link is removed/repointed or the target is restored/republished.
- **Where you see it:**
  - **Collection list** — a `$hasDeadRefs` row sidecar shows a warning triangle on any record with a dead
    reference.
  - **Page builder** — a "Broken reference" badge on the offending block (rolled up to its ancestors) plus a
    per-field note.
  - **`/admin/references`** — a global "Broken references" report (every referrer → its dead target + the
    reason), backed by the reverse `(targetColl, targetId)` index. The admin dashboard links here whenever
    the count is non-zero.
  - **Before delete/unpublish** — the editor warns "N records link here" (the reverse lookup) so you can
    fix referrers first.

> One accepted gap: opaque `json` columns are not typed-extracted, so a reference buried in raw JSON is not
> tracked.

## Slug integrity

Every **pageLike** record carries a routable slug (its `path`), and Kestrel enforces two things on save:

- **Required + auto-generated.** A blank slug is generated from the record's title (slugified); you only get
  an error when there is no title to derive one from. The editor previews the slug-to-be as the field's
  placeholder. (`slugify` → `resolvePageSlug`.)
- **Globally unique per resolved route.** Uniqueness is on the **resolved localized route**
  (`localePath(path, locale, …)`), **global across every pageLike collection** — one route = one output
  file. So `/de/about` and `/en/about` coexist (different locale), but a bare `/about` cannot exist in both
  `pages` and `posts`. An explicit slug that collides is rejected (409); an auto-generated one is de-duped
  (`/about`, `/about-2`, …). A `pageLike` collection must be `mode: 'multi'` — a routable singleton is
  refused at definition time.

This keeps one route = one output file: a record's URL is settled at save time, so publishing it only makes
that route live (and re-renders the referrers that were baking `#`).

> The uniqueness check reuses `localePath`, so it stays correct under `prefixPrimaryLocale` (the primary
> locale prefixed `/en/about` too — see [multilingual.md](./multilingual.md) › URL scheme).

## Where it lives

| Concern | Files |
|---|---|
| Invalidation + durable deps | `layers/public/server/utils/publish/{invalidation,deps,deps-persistence,publisher}.ts` |
| Status-gated links | `layers/public/server/utils/{populate-links,link-resolve}.ts`, `layers/fields/app/utils/richtext-links.ts` |
| Dead references | `layers/fields/server/utils/extract-refs.ts`, `layers/core/server/{database/record-refs.ts,utils/record-ref-index.ts}`, `layers/admin/app/{utils/dead-refs.ts,pages/admin/references.vue}` |
| Slugs | `layers/core/{app/utils/slugify.ts,server/utils/page-slug.ts,server/utils/page-route.ts}` |
