import { pageRowHref } from '../../../../core/server/utils/page-route'

/** The shape of the collection a write targets (the subset invalidation needs). */
export interface WriteCollection {
  name: string
  pageLike?: boolean
  /** Whether the collection has a draft/published `status` column. */
  status?: boolean
}

type Row = Record<string, unknown> | null

/** A content write reduced to what invalidation needs (computed by `classifyWrite`). */
export interface WriteClassification {
  collection: string
  pageLike: boolean
  status: 'created' | 'updated' | 'deleted'
  id: number | null
  /** pageLike `path` changed (the old static file must be pruned, the new one written). */
  pathChanged: boolean
  /** published-ness changed (publish or unpublish — adds/removes the page + sitemap entry). */
  statusChanged: boolean
  isPublished: boolean
  wasPublished: boolean
  /** The page's own public route from the NEW row (pageLike + has a path), else null. */
  selfRoute: string | null
  /** The page's own public route from the OLD row (pageLike + had a path), else null — the route whose
   *  static file must be pruned on a slug change / unpublish / delete (symmetric to `selfRoute`). */
  oldRoute: string | null
  groupTag: string | null
  /** Page-path tags for the breadcrumb edge — this record's own path before and/or after the write (both,
   *  on a rename); empty when it is nobody's crumb step on either side. See `pagePathTag`. */
  crumbTags: string[]
}

/** The data tag naming a translation group. `#` keeps it clear of the `<coll>:<id>` record namespace. */
export function translationGroupTag(coll: string, group: string): string {
  return `${coll}#group:${group}`
}

/**
 * The data tag naming a page-like PATH rather than a record — the edge a DESCENDANT's breadcrumb hangs on.
 *
 * It has to be the path, because Kestrel has no parent/child relation between pages: `path` is a plain
 * column, a slug is flat unless an editor types slashes into it, and "descendant" is nothing but a
 * path-prefix match. So the case that matters most — a page CREATED at `/blog` after `/blog/hello` was
 * already published — has no record id that anything could have captured beforehand. A path, by contrast,
 * is knowable before its page exists, so a descendant subscribes to the path it looked in.
 *
 * Deliberately locale-LESS: a non-translatable record has no locale to name, and a descendant looking up
 * `/blog` in its own locale must still be reached when the page that appears there is a locale-less one.
 * It therefore over-approximates across locales (an `en` `/blog` write also re-renders a `de` descendant
 * of the same spelling) — extra renders, never a stale page.
 *
 * The leading `#` keeps it clear of the `<coll>` and `<coll>:<id>` namespaces (a collection name never
 * starts with one).
 */
export function pagePathTag(path: string): string {
  return `#path:${path}`
}

/** What to republish for a write. Routes are resolved from `tags` against the captured deps index. */
export type Invalidation =
  | { type: 'full' }
  | { type: 'tags'; tags: string[]; render: string[]; prune: string[] }
  | { type: 'noop' }

/**
 * The routes to actually delete from a coalesced invalidation: `prune` minus anything we just wrote live.
 * A render and a prune for the SAME route can coalesce into one window (e.g. a new page created at /x while
 * another page vacates /x) — pruning a freshly-rendered route would delete the live page, so render wins.
 * Filtered against the ACTUALLY-rendered set (not the render candidates), so a route whose record is now a
 * draft — skipped by the renderer — is still pruned.
 */
export function routesToPrune(prune: string[], rendered: string[]): string[] {
  const live = new Set(rendered)
  return prune.filter((r) => !live.has(r))
}

/** A collection with no `status` column is always public; otherwise public ⇔ status === 'published'. */
function isPublic(def: WriteCollection, row: Row): boolean {
  if (!def.status) return true
  return !!row && row.status === 'published'
}

/**
 * The path this record contributes as a breadcrumb step, or null when it contributes none. Mirrors
 * `publishedAncestors` exactly — that lookup skips anything unpublished, `noindex`ed or path-less, so a
 * record in one of those states is in nobody's trail and its writes owe nobody a re-render.
 */
function crumbPath(def: WriteCollection, row: Row): string | null {
  if (!def.pageLike || !row) return null
  if (!isPublic(def, row)) return null
  if ((row.seo as { noindex?: boolean } | null | undefined)?.noindex) return null
  return typeof row.path === 'string' && row.path ? row.path : null
}

/** Reduce a before/after row pair (either may be null) to a `WriteClassification`. Pure (routes via the shared `pageRowHref`). */
export function classifyWrite(def: WriteCollection, before: Row, after: Row, primaryLocale: string, prefixPrimary = false): WriteClassification {
  const status: WriteClassification['status'] = before === null ? 'created' : after === null ? 'deleted' : 'updated'
  const row = after ?? before
  const id = typeof row?.id === 'number' ? row.id : null
  const pageLike = !!def.pageLike

  const isPublished = isPublic(def, after)
  const wasPublished = isPublic(def, before)
  const statusChanged = status === 'updated' && !!def.status && isPublished !== wasPublished

  const routeFrom = (r: Row): string | null => (pageLike ? pageRowHref(r, primaryLocale, prefixPrimary) : null)
  const selfRoute = routeFrom(after)
  const oldRoute = routeFrom(before)
  // Compare the RESOLVED routes, not raw `path`: the route is localePath(path, locale), so a locale-only
  // change (path unchanged) still moves the route — the old-locale file must be pruned.
  const pathChanged = pageLike && status === 'updated' && oldRoute !== selfRoute

  // `update` refuses to move a row between groups, so the surviving row's group is the group either way.
  const group = row?.translationGroup
  const groupTag = typeof group === 'string' && group ? translationGroupTag(def.name, group) : null

  // Both sides, so a rename repairs the descendants of the OLD path as well as the new one. Deliberately
  // NOT narrowed to "did the crumb's label actually change": the explicit publish action classifies its
  // write as before === after (`publish.post.ts` — a re-render of the record's current state), so a diff
  // would see nothing on the very publish that makes the crumb appear.
  const crumbTags = [...new Set([crumbPath(def, before), crumbPath(def, after)].filter((p): p is string => p !== null))]
    .map(pagePathTag)

  return { collection: def.name, pageLike, status, id, pathChanged, statusChanged, isPublished, wasPublished, selfRoute, oldRoute, groupTag, crumbTags }
}

/**
 * What the write listener enqueues for a content write. `publishOnSave` (`output.publishOnSave`) is the
 * documented way back to the pre-2.0 model where a save WAS a publish: with it on, a write plans exactly
 * what it always did. Off (the default), only removals pass — see `planSaveInvalidation`.
 */
export function planWrite(ev: WriteClassification, publishOnSave: boolean): Invalidation {
  return publishOnSave ? planInvalidation(ev) : planSaveInvalidation(ev)
}

/**
 * What a plain SAVE may do to the static output. Saving persists to the DB; writing a page's file is the
 * explicit publish action's job (`planInvalidation`, driven by `POST /api/publish`), so a save renders
 * nothing — the live site keeps serving the last published version while the editor works on the next one.
 *
 * REMOVAL is the asymmetry, and it is deliberate: an unpublished or deleted record must not keep a live
 * page, so those two branches act immediately. Their referrer/listing re-renders come along, because a
 * baked link to a page that just went offline is stale the moment it goes — the same "availability" rule
 * `planInvalidation` documents, minus everything that would put NEW content on the live site.
 */
export function planSaveInvalidation(ev: WriteClassification): Invalidation {
  const removal = ev.status === 'deleted' || (ev.statusChanged && !ev.isPublished)
  return removal ? planInvalidation(ev) : { type: 'noop' }
}

/**
 * Decide what a write invalidates, per the maintainer-agreed model. Three notions of "dependent":
 *  - LISTINGS — pages that QUERY the collection (overviews) → captured as the `<coll>` tag.
 *  - EXPLICIT REFERRERS — pages that LINK/EMBED/relate-to a specific record → captured as `<coll>:<id>`.
 *  - TRANSLATION SIBLINGS — every member of a group bakes the group's hreflang set → captured as the
 *    group tag, the only edge that reaches members which rendered before this row existed.
 *
 * Two principles drive the split:
 *  1. FRESHENING (content or path changed) re-renders BOTH listings and explicit referrers (`[coll, coll:id]`)
 *     so their output stays fresh.
 *  2. AVAILABILITY (publish / unpublish / delete) re-renders listings (membership changed) AND the explicit
 *     referrers (`[coll, coll:id]`), because a referrer's BAKED output encodes the target's availability:
 *     link resolution is status-gated (a draft target bakes `href="#"`) and a page's hreflang set lists only
 *     its published translation siblings — both go dead/stale the moment availability flips, and only a
 *     re-render can fix them. A record's OWN artifact always matches its DB state (render on publish, prune
 *     on unpublish/delete). A draft that stays a draft is a no-op.
 *
 * `full` is reserved for the boot publish + the reconciler (enqueued directly), never produced here.
 */
export function planInvalidation(ev: WriteClassification): Invalidation {
  const coll = ev.collection
  const recordTag = ev.id != null ? `${coll}:${ev.id}` : null
  // Unlike recordTag (dropped on create — no referrer can target a brand-new id), groupTag is included even
  // there: a new sibling still changes every existing member's hreflang set.
  const groupTags = ev.groupTag ? [ev.groupTag] : []
  // Like groupTag, the crumb tags ride EVERY branch including create — a page appearing at an ancestor
  // path is exactly what a descendant's breadcrumb was waiting for.
  const tags = recordTag ? [coll, recordTag, ...groupTags, ...ev.crumbTags] : [coll, ...groupTags, ...ev.crumbTags]
  const selfRender = ev.pageLike && ev.selfRoute ? [ev.selfRoute] : []

  // DELETE — leaves the collection. Listings re-render, referrers too (their baked link/hreflang now points
  // at a route that is about to disappear); the own (pageLike) route is pruned.
  if (ev.status === 'deleted') {
    const prune = ev.pageLike && ev.oldRoute ? [ev.oldRoute] : []
    return { type: 'tags', tags, render: [], prune }
  }

  // CREATE — joins the collection. A created draft produces no public output (noop); a created published
  // record re-renders listings + its own route. No referrer can point at a brand-new id, so no `coll:id`.
  if (ev.status === 'created') {
    if (!ev.isPublished) return { type: 'noop' }
    return { type: 'tags', tags: [coll, ...groupTags, ...ev.crumbTags], render: selfRender, prune: [] }
  }

  // UNPUBLISH — leaves the published set. Listings re-render; referrers re-render so their link falls back to
  // '#' and their hreflang drops this sibling; the own route is pruned (the live file sits at the OLD path if
  // this save also renamed).
  if (ev.statusChanged && !ev.isPublished) {
    const route = ev.oldRoute ?? ev.selfRoute
    const prune = ev.pageLike && route ? [route] : []
    return { type: 'tags', tags, render: [], prune }
  }

  // PUBLISH — joins the published set. Listings re-render; referrers re-render because a link to a draft
  // resolves to '#' — their baked href only becomes the real path on a re-render; the own route renders.
  if (ev.statusChanged && ev.isPublished) {
    return { type: 'tags', tags, render: selfRender, prune: [] }
  }

  // Below: a plain update, no availability change. A draft that stays a draft touches no public output.
  if (!ev.isPublished) return { type: 'noop' }

  // SLUG / PATH CHANGE — path freshening: listings + referrers re-render (their link path updates); the new
  // route renders, the old route is pruned.
  if (ev.pathChanged) {
    const prune = ev.oldRoute ? [ev.oldRoute] : []
    return { type: 'tags', tags, render: selfRender, prune }
  }

  // CONTENT EDIT — content freshening: listings + explicit referrers re-render; the own route re-renders.
  return { type: 'tags', tags, render: selfRender, prune: [] }
}
