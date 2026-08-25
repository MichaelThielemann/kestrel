import { Effect } from 'effect'
import { Conflict, ValidationFailed } from '@kestrel/contracts'
import { slugify } from '../../../app/utils/slugify.js'

// Canonicalise to exactly what the render-side resolver looks up: lowercase, drop empty segments
// (leading/trailing/duplicate slashes), trim each segment (not just the whole string's ends — a
// segment-internal space would otherwise survive one pass and get trimmed only on the next, breaking
// idempotence) — otherwise a slug typed with a trailing slash stores as `/blog/` but resolves as `/blog`
// and the sitemap advertises a dead URL. Idempotent: normalizing twice is a no-op.
/** @public */
export function normalizeSlugPath(raw: string): string {
  return `/${raw.toLowerCase().split('/').map((s) => s.trim()).filter(Boolean).join('/')}`
}

/** @public */
export interface SlugLocaleInput {
  translatable: boolean
  explicitLocale?: string
  existingLocale?: string
  primary: string
}

/** The locale a slug's resolved route is computed under: an explicit `values.locale` wins, else the
 *  existing row's locale (an update that doesn't touch locale), else the primary — matching
 * @public
 *  `resolveLocaleStep`'s own precedence so the two never disagree on a row's locale. */
export function slugLocale(input: SlugLocaleInput): string {
  if (!input.translatable) return input.primary
  return input.explicitLocale || input.existingLocale || input.primary
}

/** @public */
export interface ExplicitSlugInput {
  /** Already normalized (`normalizeSlugPath`) — the caller probes route conflicts against this value. */
  path: string
  /** The shell's route-conflict probe, run before calling this decision. */
  conflict: { collection: string, id: number } | null
}

/** An explicit `values.path`: accept it unless the shell's route probe found another pageLike record
 * @public
 *  already resolving there. */
export function decideExplicitSlug(input: ExplicitSlugInput): Effect.Effect<string, Conflict> {
  return input.conflict ? Effect.fail(new Conflict({ field: 'path', value: input.path })) : Effect.succeed(input.path)
}

/** A blank slug: derive the auto-gen BASE route (`/slug`) from the slug-source field value (already
 *  resolved by the shell — `title` or the collection's first text field), failing when there is no text
 * @public
 *  to derive one from. The shell de-dupes the base against the global route set via `nextSlugCandidate`. */
export function decideAutoSlugBase(slugSource: string): Effect.Effect<string, ValidationFailed> {
  const slug = slugify(slugSource)
  if (!slug) {
    return Effect.fail(new ValidationFailed({ issues: [{ path: ['path'], message: 'A slug is required (no title to derive one from).' }] }))
  }
  return Effect.succeed(`/${slug}`)
}

/** The Nth de-dup candidate for an auto-gen base slug: the base itself (`n=1`), then `base-2`, `base-3`,
 *  … — strictly distinct for every `n`, so a caller probing candidates in increasing order is guaranteed
 * @public
 *  to terminate on the first free route without ever repeating one it already rejected. */
export function nextSlugCandidate(base: string, n: number): string {
  return n <= 1 ? base : `${base}-${n}`
}
