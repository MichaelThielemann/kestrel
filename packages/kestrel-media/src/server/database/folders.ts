import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

// Path-based folder registry: persists folders (incl. empty ones) and is the authoritative
// tree for media navigation. `path` is the normalized folder path (root '' is never a row).
/** The `folders` Drizzle table.
 * @public
 */
export const folders = sqliteTable('folders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  path: text('path').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})
