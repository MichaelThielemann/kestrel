import { captureRead, memoDuringPrerender, memoResolver } from '@kestrel/core'
import type { FieldPopulator } from '@kestrel/core'
import { collectRichtextRefs, resolveRichtextLinks } from '@kestrel/core/client'

// The localized-href-for-a-page-row rule lives once in core (`pageRowHref`); the link populator/resolver
// use it as the target-row href. The resolver (link-resolve) STATUS-GATES: a missing OR draft target
// renders `'#'` (no draft-slug leak); only a published target gets its real path.

// Resolves an internal link `{collection, id}` to the target's localized path, or null when it has no
// public path (target missing, not page-like, or no path). The locale is the TARGET row's own, so the
// resolver takes no locale argument — mirroring how the media populator injects its by-id resolver.
/** @public */
export type ResolveHref = (collection: string, id: number) => string | null

interface InternalLink { type: 'internal'; collection: string; id: number; href?: string }

function isInternal(value: unknown): value is InternalLink {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.type === 'internal' && typeof v.collection === 'string' && typeof v.id === 'number'
}

// Replace an internal link value in place with a cloned `{...value, href}` (KestrelLink reads value.href).
// external / email / tel and unresolvable internals pass through untouched (the latter render '#').
function resolveLink(value: unknown, resolveHref: ResolveHref): unknown {
  if (!isInternal(value)) return value
  const href = resolveHref(value.collection, value.id)
  return href == null ? value : { ...value, href }
}

/**
 * The `link` + `richtext` field populators. `link` replaces an internal link value with `{...value, href}`;
 * `richtext` rewrites `kestrel:` internal-link markers in the HTML to resolved localized paths. Both are
 * bare-keyed in every key-mode (link/richtext are not single-ref columns), so `keyMode` is irrelevant.
 * Registered per-type via `registerFieldPopulator`; the shared field-tree walker drives them over
 * top-level fields, block props, and (now) repeater entries. Both share one prerender memo so a target is
 * resolved once per generate across links and richtext alike.
 * @public
 */
export function buildLinkFieldPopulators(resolveHref: ResolveHref): { link: FieldPopulator; richtext: FieldPopulator } {
  // Same composition as the relation/media populators: build-wide memo during generate, request-/publish-
  // run-wide via the resolve scope (budgeted per live request, read-tags replayed on hits).
  // memoResolver OUTERMOST so a per-scope budget-skip null is never cached build-wide by the prerender memo.
  const key = (collection: string, id: number) => `link:${collection}:${id}`
  const resolve = memoResolver(memoDuringPrerender(resolveHref, key), key)
  return {
    // captureRead runs even on a memo hit (each embedding page must record the dep), so it sits here, not
    // inside `resolve`: it durably ties this render's route to `<collection>:<id>`, so renaming the target
    // re-renders the referrer instead of leaving a baked href pointing at the pruned old path. A DRAFT
    // target is tagged for the same reason: resolution is status-gated, so the referrer baked '#', and this
    // edge is what lets the availability tag `<collection>:<id>` (planInvalidation's publish/unpublish/
    // delete branches) re-render it into the real path. A dangling target's tag is simply inert — no write
    // ever emits it.
    link: (bag, key) => {
      const value = bag[key]
      if (isInternal(value)) captureRead(value.collection, value.id)
      bag[key] = resolveLink(value, resolve)
    },
    richtext: (bag, key) => {
      const html = bag[key]
      if (typeof html !== 'string') return
      for (const ref of collectRichtextRefs(html)) captureRead(ref.collection, ref.id)
      bag[key] = resolveRichtextLinks(html, resolve)
    },
  }
}
