import { fieldIs } from '../../../core/server/utils/defineCollection'
import type { FieldPopulator } from '../../../core/server/utils/populate'
import { memoDuringPrerender } from '../../../core/server/utils/prerender-memo'
import { memoResolver } from '../../../core/server/utils/resolve-scope'
import { captureRead } from '../../../core/server/utils/read-capture'
import type { ResolvedMedia } from './resolve'

export type ResolveById = (id: number, locale: string) => ResolvedMedia | null

function attach(target: Record<string, unknown>, key: string, value: unknown): void {
  // Clone the existing $media bag rather than mutate it in place: if `target` is a shallow clone that
  // happens to share a pre-existing $media sidecar with the stored row, in-place mutation would leak into
  // the original. No current caller feeds a $media-bearing bag into the walker, but this keeps the
  // populator unconditionally non-destructive (future-proof against a double-populate / pre-seeded bag).
  target.$media = { ...((target.$media as Record<string, unknown> | undefined) ?? {}), [key]: value }
}

/**
 * The `media` field populator: resolves a media id (single, key `${name}Id` in columns / bare `name` in
 * props) or id array (multiple, always bare) to a `ResolvedMedia` under the row/entry's `$media` bag,
 * leaving the raw id column untouched. Registered per-type via `registerFieldPopulator('media', …)`; the
 * shared field-tree walker drives it over top-level fields, block props, and (now) repeater entries.
 */
export function buildMediaFieldPopulator(resolveById: ResolveById): FieldPopulator {
  // The same media id+locale is resolved once — build-wide during a generate run, request-/publish-run-
  // wide via the resolve scope (which also budgets one live request's distinct fan-out).
  // memoResolver OUTERMOST so a per-scope budget-skip null is never cached build-wide by the prerender memo.
  const key = (id: number, locale: string) => `media:${id}:${locale}`
  const resolve = memoResolver(memoDuringPrerender(resolveById, key), key)
  return (bag, key, field, ctx, keyMode) => {
    if (!fieldIs(field, 'media')) return
    // captureRead runs even on a memo hit (each embedding page must record the dep), so it sits here, not
    // inside `resolve`: it durably ties this render's route to `media:<id>`, so a later media change
    // (rename/move/alt-edit) re-renders the page instead of leaving a stale/broken image in the static output.
    if (!field.options?.multiple) {
      const id = bag[keyMode === 'columns' ? `${key}Id` : key]
      if (typeof id === 'number') { captureRead('media', id); attach(bag, key, resolve(id, ctx.locale)) }
    } else {
      const ids = bag[key]
      if (Array.isArray(ids)) {
        const nums = ids.filter((x): x is number => typeof x === 'number')
        for (const id of nums) captureRead('media', id)
        attach(bag, key, nums.map((id) => resolve(id, ctx.locale)))
      }
    }
  }
}
