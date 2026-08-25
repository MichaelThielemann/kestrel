import { and, eq, ne } from 'drizzle-orm'
import { Effect } from 'effect'
import { ValidationFailed } from '@kestrel/contracts'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { resolveColumnName } from '@kestrel/core'
import type { BuiltCollection } from '@kestrel/core'
import { collectionOf, columns, dbOf, table, unitsOf, type DB, type Row } from './shared.js'
import { syncStep, type StepDef } from '../types.js'

/** Reject (hard, NO silent dedup) a `unique` slug that already exists — so the editor gets a clear
 *  field-scoped "already exists" error and the photographer must choose a different slug (Pruvious-style).
 *  Runs AFTER transforms (sees the generated value), BEFORE insert/update. Throws a 400 keyed to the field
 *  (`path: [key]` → the slug widget shows it inline). `excludeId` skips the row's own row on update so
 *  re-saving an unchanged slug isn't a false collision. Scope = the whole table (a plain `unique` column is
 *  global). The DB UNIQUE index stays as the integrity backstop against a race. */
function assertUniqueSlugs(db: DB, c: BuiltCollection, values: Row, excludeId: number | null): Effect.Effect<void, ValidationFailed> {
  let cols: Record<string, AnySQLiteColumn> | undefined
  const issues: { path: (string | number)[], message: string }[] = []
  for (const [key, fieldDef] of Object.entries(c.def.fields)) {
    if (fieldDef.type !== 'slug' || !fieldDef.unique) continue
    const { jsKey } = resolveColumnName(key, fieldDef)
    const slug = values[jsKey]
    if (typeof slug !== 'string' || !slug) continue
    cols ??= columns(c)
    const where = excludeId == null ? eq(cols[jsKey]!, slug) : and(eq(cols[jsKey]!, slug), ne(cols.id, excludeId))
    if (db.select({ id: cols.id }).from(table(c)).where(where).get()) {
      issues.push({ path: [key], message: `The slug “${slug}” already exists — choose a different one.` })
    }
  }
  return issues.length ? Effect.fail(new ValidationFailed({ issues })) : Effect.void
}

/** @public */
export function assertUniqueStep(): StepDef {
  return syncStep('assertUnique', (ctx) => Effect.gen(function* () {
    const c = collectionOf(ctx)
    const db = dbOf(ctx)
    for (const unit of unitsOf(ctx)) {
      yield* assertUniqueSlugs(db, c, unit.values, (unit.before?.id as number | undefined) ?? null)
    }
  }), { sealed: true })
}
