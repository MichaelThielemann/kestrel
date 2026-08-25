import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Durable `route -> data tags` index backing the runtime publisher's DepsStore. Persists what each
// published route read while rendering (its `<coll>` / `<coll>:<id>` tags) so a write maps back to exactly
// the routes that embed that data, AND so a boot full-publish can prune routes that left the published set
// while the server was down. `route` is the natural primary key; `tags` is the JSON-encoded tag set.
// Hand-authored system table (not a collection) — registered in the desired schema via bootstrap.ts +
// re-exported from collections/schema.ts, mirroring `folders`.
/** The `publish_deps` Drizzle table.
 * @public
 */
export const publishDeps = sqliteTable('publish_deps', {
  route: text('route').primaryKey(),
  tags: text('tags').notNull(),
})
