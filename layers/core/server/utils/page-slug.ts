import { createError } from 'h3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { CollectionDef } from './defineCollection'
import type { BuiltCollection } from './collection-types'
import { slugify } from '../../app/utils/slugify'
import { routeOf, findRouteConflict } from './page-route'

/**
 * The KEY of the text field Kestrel derives an auto-slug from: the `title` field if present, else the
 * first text field (or `undefined` when the collection has no text field). Text fields keep their key as
 * their column key (no `Id` suffix), so both the record value and a write target read directly by this key
 * — which keeps this in `core` without importing the `fields` naming layer. Exported so the duplicate
 * operation appends its `(copy)` suffix to the SAME field the slug derives from.
 */
export function slugSourceKey(def: CollectionDef): string | undefined {
  const fields = Object.entries(def.fields)
  const pick = fields.find(([k, f]) => k === 'title' && f.type === 'text') ?? fields.find(([, f]) => f.type === 'text')
  return pick?.[0]
}

/** The trimmed string value of that slug-source field on a record (empty when absent / non-string). */
export function slugSourceValue(def: CollectionDef, record: Record<string, unknown>): string {
  const key = slugSourceKey(def)
  if (!key) return ''
  const v = record[key]
  return typeof v === 'string' ? v.trim() : ''
}

// Canonicalise to exactly what the render-side resolver (resolvePublicRoute + the [...slug] segment
// filter) looks up: lowercase, drop empty segments (leading/trailing/duplicate slashes). Otherwise a slug
// typed with a trailing slash stores as `/blog/` but resolves as `/blog` → the page 404s and the sitemap
// advertises a dead URL.
const normalizePath = (p: string): string => `/${p.trim().toLowerCase().split('/').filter(Boolean).join('/')}`

export interface SlugCtx {
  /** The id of the record being saved (null on create), excluded from the uniqueness scan. */
  id: number | null
  /** The existing row (on update) — supplies the title for auto-gen + the locale when the body omits it. */
  existing?: Record<string, unknown> | null
  /** Every collection to scan for a route collision (the caller passes the registry). */
  collections: BuiltCollection[]
  primary: string
  /** Whether the primary locale is prefixed in routes too — folded into the resolved route. */
  prefixPrimary: boolean
}

/**
 * Resolve and validate a pageLike record's slug, mutating `values.path` in place (no-op for non-pageLike):
 *  - blank slug → auto-generate from the title field (slugify), de-duped (`-2`, `-3`, …) against the
 *    GLOBAL resolved-route set; reject 400 only when there's no title to derive one from.
 *  - explicit slug → normalize (single leading slash + lowercase) and reject 409 when its resolved route
 *    is already taken by another pageLike record.
 * Uniqueness is on the resolved route (`localePath`), GLOBAL across all pageLike collections — one route =
 * one output file — so `/de/x` ≠ `/en/x` (different locale) but a bare `/x` in `pages` and `posts` collide.
 */
export function resolvePageSlug(db: BetterSQLite3Database, c: BuiltCollection, values: Record<string, unknown>, ctx: SlugCtx): void {
  if (!c.def.pageLike) return
  const raw = values.path
  const explicit = typeof raw === 'string' && raw.trim() !== ''
  const translatable = !!c.def.translatable
  const locale = translatable
    ? (typeof values.locale === 'string' && values.locale ? values.locale : (ctx.existing?.locale as string) ?? ctx.primary)
    : ctx.primary
  const exclude = { collection: c.name, id: ctx.id }
  const routeFor = (p: string) => routeOf({ path: p, locale }, translatable, ctx.primary, ctx.prefixPrimary)!

  if (explicit) {
    const path = normalizePath(raw as string)
    const conflict = findRouteConflict(db, routeFor(path), ctx.primary, ctx.collections, exclude, ctx.prefixPrimary)
    if (conflict) throw createError({ statusCode: 409, statusMessage: 'Path already in use', data: { path, conflict } })
    values.path = path
    return
  }

  const slug = slugify(slugSourceValue(c.def, { ...(ctx.existing ?? {}), ...values }))
  if (!slug) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Validation failed',
      data: [{ path: ['path'], message: 'A slug is required (no title to derive one from).' }],
    })
  }
  values.path = dedupeRoute(db, `/${slug}`, routeFor, ctx.primary, ctx.collections, exclude, ctx.prefixPrimary)
}

/**
 * The ONE `-N` de-dup loop: return `base` when its resolved route is free, else `base-2`, `base-3`, … the
 * first candidate not already claimed by another pageLike record. Extracted so BOTH the auto-generated-slug
 * branch above AND the duplicate op (`dedupeSourcePath`) share a single route-uniqueness implementation.
 */
function dedupeRoute(
  db: BetterSQLite3Database,
  base: string,
  routeFor: (path: string) => string,
  primary: string,
  collections: BuiltCollection[],
  exclude: { collection: string; id: number | null },
  prefixPrimary: boolean,
): string {
  let candidate = base
  for (let n = 2; n < 1000 && findRouteConflict(db, routeFor(candidate), primary, collections, exclude, prefixPrimary); n++) {
    candidate = `${base}-${n}`
  }
  return candidate
}

/**
 * The free route a pageLike COPY should claim when its collection has NO slug-source text field for the
 * auto-gen branch to derive from: the SOURCE row's own explicit `path`, de-duped (`-2`, `-3`, …) to the
 * first free global route via the same `dedupeRoute` loop. Seeding this (instead of leaving `path` blank →
 * a 400, or re-using the source's colliding path → a 409) lets `create()`'s explicit branch accept it.
 * Mirrors resolvePageSlug's own locale/route derivation so a copy resolves under the source's locale.
 * Returns null when the source has no usable path (the caller lets create()'s own 400 surface).
 */
export function dedupeSourcePath(
  db: BetterSQLite3Database,
  c: BuiltCollection,
  sourceRow: Record<string, unknown>,
  ctx: Pick<SlugCtx, 'collections' | 'primary' | 'prefixPrimary'>,
): string | null {
  const raw = sourceRow.path
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const translatable = !!c.def.translatable
  const locale = translatable && typeof sourceRow.locale === 'string' && sourceRow.locale ? sourceRow.locale : ctx.primary
  const routeFor = (p: string) => routeOf({ path: p, locale }, translatable, ctx.primary, ctx.prefixPrimary)!
  return dedupeRoute(db, normalizePath(raw), routeFor, ctx.primary, ctx.collections, { collection: c.name, id: null }, ctx.prefixPrimary)
}
