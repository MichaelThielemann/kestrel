import { eq } from 'drizzle-orm'
import { getCollection, useDb } from '@kestrel/core'
import { compilePublishableRedirects, matchRedirect, REDIRECTS_COLLECTION, REDIRECTS_FIELD } from '@kestrel/publishing'
import type { RedirectRule } from '@kestrel/publishing'

/** In-memory compiled cache — `null` means "not compiled yet / invalidated", not "zero redirects" (an
 *  empty list is `[]`, a valid cached value). `invalidateLiveRedirects` drops it back to `null`. Per
 *  PROCESS: a multi-process deployment only invalidates the process that handled the save, so the others
 *  keep serving the stale compiled rules until their own next invalidation or restart. */
let cached: RedirectRule[] | null = null

/** Drop the cached compiled rules — called on every save of the redirects singleton (see
 *  `plugins/03.redirects.ts`), the same trigger that refreshes the `redirects.json` artifact, so live
 *  mode's own redirect handling never lags a save any more than the static edge's artifact does.
 * @public */
export function invalidateLiveRedirects(): void {
  cached = null
}

function compileFromDb(): RedirectRule[] {
  const collection = getCollection(REDIRECTS_COLLECTION)
  if (!collection) return []
  const cols = collection.table as unknown as Record<string, never>
  const row = useDb().select().from(collection.table).where(eq(cols.singletonKey, REDIRECTS_COLLECTION)).get() as
    | Record<string, unknown>
    | undefined
  return compilePublishableRedirects(row?.[REDIRECTS_FIELD]).rules
}

/**
 * The redirect the live catch-all must honour for `path`, or `null`. Under `delivery: 'live'` the app IS
 * the edge (there is no separate njs/edge script in front of it, unlike the static topology), so a
 * configured redirect has to work here too — consulted before the 404, from the SAME compiled source
 * `redirects.json` is built from (`redirect-rules.ts`'s `matchRedirect`/`compilePublishableRedirects`).
 * Lazily compiled and cached — cheap on the common case (no redirects, or a cache hit) — a request never
 * re-reads/re-compiles the row unless `invalidateLiveRedirects` dropped the cache since.
 * @public
 */
export function liveRedirectFor(path: string): { target: string; status: number } | null {
  cached ??= compileFromDb()
  return matchRedirect(cached, path)
}
