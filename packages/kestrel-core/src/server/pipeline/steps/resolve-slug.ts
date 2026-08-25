import { Effect } from 'effect'
import type { Conflict, ValidationFailed } from '@kestrel/contracts'
import { prefixPrimaryLocale, primaryLocale } from '../../utils/locale.js'
import { allCollections } from '../../utils/registry.js'
import { findRouteConflict, routeOf } from '../../utils/page-route.js'
import { dedupeAgainstConflicts, slugSourceValue } from '../../utils/page-slug.js'
import { decideAutoSlugBase, decideExplicitSlug, normalizeSlugPath, slugLocale } from '../core/slug.js'
import { collectionOf, dbOf, isSingletonWrite, unitsOf, type DB, type Row, type WriteUnit } from './shared.js'
import type { BuiltCollection } from '@kestrel/core'
import { syncStep, type PipelineContext, type StepDef } from '../types.js'

/** An update re-resolves the route when it changes it — either `path` directly, OR the `locale` (the route
 *  is localePath(path, locale, …), so a locale-only change re-routes the row). */
function routeChanged(c: BuiltCollection, unit: WriteUnit): boolean {
  const localeChanged = !!c.def.translatable && 'locale' in unit.values && unit.values.locale !== unit.before?.locale
  return 'path' in unit.values || localeChanged
}

interface Scope { collections: BuiltCollection[], primary: string, prefixPrimary: boolean }

/** Resolve one write unit's `values.path` — read the ctx-derived facts, probe route conflicts (DB, the
 *  shell's job), and hand the REAL probe result to the pure slug decision, whose `Conflict`/
 *  `ValidationFailed` failure flows straight through the step's own Effect channel — the edge maps it; a
 *  direct caller, like `crud.ts`'s tests, sees the same tagged value every other step fails with. */
function resolveOneSlug(db: DB, c: BuiltCollection, values: Row, existing: Row | null, id: number | null, scope: Scope): Effect.Effect<void, Conflict | ValidationFailed> {
  return Effect.gen(function* () {
    const locale = slugLocale({
      translatable: !!c.def.translatable,
      explicitLocale: typeof values.locale === 'string' ? values.locale : undefined,
      existingLocale: existing?.locale as string | undefined,
      primary: scope.primary,
    })
    const exclude = { collection: c.name, id }
    const routeFor = (p: string) => routeOf({ path: p, locale }, !!c.def.translatable, scope.primary, scope.prefixPrimary)!
    const hasConflict = (candidate: string) => !!findRouteConflict(db, routeFor(candidate), scope.primary, scope.collections, exclude, scope.prefixPrimary)

    const raw = values.path
    if (typeof raw === 'string' && raw.trim() !== '') {
      const path = normalizeSlugPath(raw)
      const conflict = findRouteConflict(db, routeFor(path), scope.primary, scope.collections, exclude, scope.prefixPrimary)
      values.path = yield* decideExplicitSlug({ path, conflict })
      return
    }

    values.path = dedupeAgainstConflicts(yield* decideAutoSlugBase(slugSourceValue(c.def, { ...(existing ?? {}), ...values })), hasConflict)
  })
}

/** @public */
export function resolveSlugStep(kind: 'create' | 'update'): StepDef {
  const scope = (): Scope => ({ collections: allCollections(), primary: primaryLocale(), prefixPrimary: prefixPrimaryLocale() })

  if (kind === 'create') {
    return syncStep('resolveSlug', (ctx) => Effect.gen(function* () {
      const c = collectionOf(ctx)
      const db = dbOf(ctx)
      const s = scope()
      for (const unit of unitsOf(ctx)) yield* resolveOneSlug(db, c, unit.values, null, null, s)
    }), {
      when: (ctx) => !!collectionOf(ctx).def.pageLike,
      whenLabel: 'collection is pageLike',
    })
  }

  return syncStep('resolveSlug', (ctx) => Effect.gen(function* () {
    const c = collectionOf(ctx)
    const db = dbOf(ctx)
    const unit = unitsOf(ctx)[0]!
    // For a locale-only change, seed the existing path so resolveOneSlug re-checks it as an explicit
    // path under the new locale (rejects a cross-collection conflict).
    if (!('path' in unit.values) && typeof unit.before!.path === 'string') unit.values.path = unit.before!.path
    if ('path' in unit.values) yield* resolveOneSlug(db, c, unit.values, unit.before, ctx.id!, scope())
  }), {
    when: (ctx: PipelineContext) => {
      const c = collectionOf(ctx)
      if (isSingletonWrite(ctx) || !c.def.pageLike) return false
      const unit = unitsOf(ctx)[0]
      return !!unit?.before && routeChanged(c, unit)
    },
    whenLabel: 'collection is pageLike and the update changes the resolved route',
  })
}
