import { getResolvedKestrelConfig, type ResolvedKestrel } from '@kestrel/core'

type RawPolicy = { keep?: unknown; maxAgeDays?: unknown } | undefined

/** `runtimeConfig.kestrel.revisions` reaches this UNVALIDATED (unlike the `resolveKestrel()` fallback
 *  path, which already sanitizes it) — a consumer's own runtime config could set `keep: -5` or
 *  `keep: 'yes'`. Fail-safe to `'all'` (nothing pruned) rather than let a garbage value reach
 *  `pruneRevisions`'s arithmetic; a real misconfiguration is at least visible as a warning instead of
 *  silently mispruning. */
function normalizePolicy(raw: RawPolicy): ResolvedKestrel['revisions'] {
  const keep = raw?.keep
  const validKeep = keep === 'all' || (typeof keep === 'number' && Number.isInteger(keep) && keep >= 0)
  if (keep !== undefined && !validKeep) {
    console.warn(`[kestrel] revisions.keep must be a non-negative integer or "all" — got ${JSON.stringify(keep)}, defaulting to "all"`)
  }
  const policy: ResolvedKestrel['revisions'] = { keep: validKeep ? (keep as number | 'all') : 'all' }

  const maxAgeDays = raw?.maxAgeDays
  if (maxAgeDays !== undefined) {
    const validAge = typeof maxAgeDays === 'number' && Number.isFinite(maxAgeDays) && maxAgeDays > 0
    if (validAge) policy.maxAgeDays = maxAgeDays
    else console.warn(`[kestrel] revisions.maxAgeDays must be a positive number — got ${JSON.stringify(maxAgeDays)}, ignoring`)
  }
  return policy
}

/**
 * The resolved revision retention policy, read from the config the boot-time wiring plugin resolved once
 * (same `runtimeConfig.kestrel.revisions ?? resolveServerKestrel()` precedence `media-enabled.ts`'s
 * `mediaCollectionEnabled` uses, now centralized in `resolveServerKestrelConfig`), normalized/validated
 * (see `normalizePolicy` — the provider's value can still be the UNVALIDATED runtimeConfig one).
 * `collection` is accepted (not yet used to differentiate) so a future per-collection override doesn't
 * change every call site's signature.
 * @public
 */
export function revisionRetentionPolicy(_collection: string): ResolvedKestrel['revisions'] {
  const raw = getResolvedKestrelConfig().revisions as RawPolicy
  return normalizePolicy(raw)
}
