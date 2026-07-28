import { eq, getTableColumns } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

// The sibling map keyed by translation GROUP — the twin of `/:id/translations` for the editor of a record
// that does not exist yet (`/admin/pages/new?locale=de&group=…`), which knows its group but has no id. It
// resolves one member of the group and hands off to the per-id map builder, so both entry points can never
// answer differently. The literal `translations` segment beats the dynamic `[id]` route (as `options.get.ts`
// already relies on). Admin-only: `resourceForPath` maps it to the `<collection>/translations` resource, the
// same gate as the per-record route (the map enumerates draft ids).
export default defineEventHandler((event) => {
  const collection = requireCollection(event)
  // Checked here, not left to resolveTranslations: a collection without translations has no
  // translationGroup column, so the member lookup below would blow up on an undefined column.
  if (collection.def.mode === 'single' || !collection.def.translatable) {
    throw createError({ statusCode: 400, statusMessage: 'Translations are not enabled for this collection' })
  }
  const group = String(getQuery(event).group ?? '').trim()
  if (!group) throw createError({ statusCode: 400, statusMessage: 'A translation group is required' })

  const db = useDb()
  const cols = getTableColumns(collection.table) as Record<string, AnySQLiteColumn>
  const member = db.select({ id: cols.id }).from(collection.table).where(eq(cols.translationGroup, group)).get() as { id: number } | undefined
  if (!member) throw createError({ statusCode: 404, statusMessage: `Unknown translation group: ${group}` })
  return resolveTranslations(db, collection, member.id)
})
