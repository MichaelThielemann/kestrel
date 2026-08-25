// The single source of truth for collection-list page sizes and, derived from them, the bulk-operation id
// cap. Lives in `core/app/utils` (the established server+client shared home — same as `filter-ops.ts`) so
// the admin list UI, the `list()` query engine, and the `bulk` endpoint all agree on ONE set of limits
// instead of each hardcoding its own.

/** The page sizes offered in the list's per-page selector.
 * @public
 */
export const PER_PAGE_OPTIONS = [25, 50, 100, 250, 500] as const

/** The page size a list falls back to when none (or a garbage value) is supplied.
 * @public
 */
export const DEFAULT_PER_PAGE = 25

/** The largest page a single list request may return — also the ceiling `clampPerPage` clamps to.
 * @public
 */
export const MAX_PER_PAGE = 500

/** Coerce an untrusted page size to a sane integer: a non-finite input (undefined / NaN / Infinity / a
 *  non-numeric string) falls back to `DEFAULT_PER_PAGE`; anything else is floored and clamped to
 *  `[1, MAX_PER_PAGE]`. Guards against `LIMIT NaN` (which SQLite binds as "no limit") — an unauthenticated
 * @public
 *  cap-bypass / DoS lever. */
export function clampPerPage(n: unknown): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return DEFAULT_PER_PAGE
  return Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(v)))
}

/** A bulk op can never carry more ids than one page can show (you select what you can see), so the id cap
 * @public
 *  is DERIVED from the max page size, not guessed. */
export const MAX_BULK_IDS = MAX_PER_PAGE
