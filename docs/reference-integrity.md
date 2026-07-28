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

A write to record *A* can affect other pages in two ways:

- **Listings** — a page that QUERIES *A*'s collection (an overview rendering `list(posts)`). It depends on
  the collection, not a specific row → captured as the tag `<collection>`.
- **Explicit referrers** — a page that LINKS to *A*, embeds *A*'s data, or has a relation/media field to
  *A* → captured as the tag `<collection>:<id>` (resolving/embedding *A* reads it by id).

The publisher records, per published route, the tags it read while rendering — a durable `route → tags`
index (`publish_deps`) that **survives restarts**, so a page unpublished/deleted while the server was down
is still pruned on the next boot. A write maps its changed tags back to exactly the routes they affect.

What a write does, per event (the agreed model — `layers/public/server/utils/publish/invalidation.ts`):

| Event on record A | A's own static file | Listings (`<coll>`) | Explicit referrers (`<coll>:<id>`) |
|---|---|---|---|
| Content edit | re-render (if published) | re-render | **re-render** (fresh data/label) |
| Slug / path change | prune old route + render new | re-render | **re-render** (link path updates) |
| Publish | render route | re-render (joins the set) | **re-render** (the baked `#` becomes the real path) |
| Unpublish | **prune route file** | re-render (leaves the set) | **re-render** (link falls back to `#`) + warned |
| Delete | prune route file (+ media derivatives) | re-render (leaves the collection) | **re-render** (link falls back to `#`) + warned |

Two principles drive it:

- **Freshening → re-render.** A change to *A*'s **content** or **path** re-renders its dependents (listings
  *and* explicit referrers) so their output stays fresh.
- **Availability → re-render both; still warn.** Publishing/unpublishing/deleting *A* re-renders listings
  (collection membership changed) **and** explicit referrers, because a referrer's *baked* output encodes
  *A*'s availability: link resolution is status-gated (a draft/missing target bakes `href="#"`) and a page's
  hreflang set lists only its published translation siblings. Only a re-render can move those. The editor is
  warned on top (next section), because a link that now renders `#` is correct output for a broken
  reference, not a fixed reference.

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
