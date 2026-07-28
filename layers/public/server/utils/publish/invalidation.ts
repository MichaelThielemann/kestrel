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

  return { collection: def.name, pageLike, status, id, pathChanged, statusChanged, isPublished, wasPublished, selfRoute, oldRoute }
}

/**
 * Decide what a write invalidates, per the maintainer-agreed model. Two notions of "dependent":
 *  - LISTINGS — pages that QUERY the collection (overviews) → captured as the `<coll>` tag.
 *  - EXPLICIT REFERRERS — pages that LINK/EMBED/relate-to a specific record → captured as `<coll>:<id>`.
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
  const tags = recordTag ? [coll, recordTag] : [coll]
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
    return { type: 'tags', tags: [coll], render: selfRender, prune: [] }
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
