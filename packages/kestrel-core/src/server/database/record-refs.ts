import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core'

// Durable reference index: one row per `(source record) → (target record)` edge, over ALL reference
// types (relation / media / internal link / richtext links / link fields). Maintained on every content
// write (see `maintainRecordRefs`) and queried on read to DERIVE stale-reference warnings — never stores
// a warning message (a stored "X deleted" goes stale when X is restored). A non-collection system table,
// so it lives here (not `server/collections`, which would wire it into the CRUD API/admin). Indexed both
// forward (what a record references) and reverse (what references a record). `createdAt` via `$defaultFn`
// (no SQL default → it won't perpetually diff as a rebuild).
/** @public */
export const recordRefs = sqliteTable('record_refs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceColl: text('source_coll').notNull(),
  sourceId: integer('source_id').notNull(),
  targetColl: text('target_coll').notNull(),
  targetId: integer('target_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index('record_refs_source').on(t.sourceColl, t.sourceId),
  index('record_refs_target').on(t.targetColl, t.targetId),
])
