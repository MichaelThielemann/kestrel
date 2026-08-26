import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { BuiltCollection } from '@michaelthielemann/kestrel-core'
import { supportedLocales } from './locale.js'
import { columns, table } from '../pipeline/steps/shared.js'

type Row = Record<string, unknown>

/** A record's locale → sibling id map: every supported locale, with `null` where the group has no row yet
 * @public
 *  (what the editor's "+ create translation" affordance keys off). */
export function resolveTranslations(db: BetterSQLite3Database, c: BuiltCollection, id: number): Record<string, number | null> {
  if (c.def.mode === 'single' || !c.def.translatable) {
    throw createError({ statusCode: 400, statusMessage: 'Translations are not enabled for this collection' })
  }
  const cols = columns(c)
  const base = db.select().from(table(c)).where(eq(cols.id, id)).get() as Row | undefined
  if (!base) throw createError({ statusCode: 404, statusMessage: `${c.name} ${id} not found` })
  const rows = db.select().from(table(c)).where(eq(cols.translationGroup, base.translationGroup)).all() as Row[]

  const result: Record<string, number | null> = {}
  for (const loc of supportedLocales()) result[loc] = null
  for (const row of rows) result[row.locale as string] = row.id as number
  return result
}
