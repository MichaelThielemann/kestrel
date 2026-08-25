import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core'

// The content module's transactional outbox: one row per committed write, inserted in the same
// `better-sqlite3` transaction as the record it describes (see `pipeline/steps/persist.ts`). A dedicated
// migrated table, not runtime DDL — `layers/core/server/db/outbox.ts`'s `ensureOutboxTable` stays
// available for a module that has no migration of its own (tests, a future non-content module), but
// content's own outbox must exist before any write can reach it, so it is provisioned like any other
// system table instead of lazily on first touch.
/** @public */
export const outboxContent = sqliteTable('outbox_content', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  envelope: text('envelope').notNull(),
  aggregateKey: text('aggregate_key').notNull(),
  sequence: integer('sequence').notNull(),
  processedAt: text('processed_at'),
  attempts: integer('attempts').notNull().default(0),
  dead: integer('dead').notNull().default(0),
}, (t) => [
  // `nextSequence` runs this on every write against an append-only table — must stay an index scan, not
  // a full table scan, regardless of how large the outbox grows.
  index('outbox_content_aggregate').on(t.aggregateKey, t.sequence),
  // The poller's actual query: `WHERE processed_at IS NULL AND dead = 0 ORDER BY id ASC` — trailing `id`
  // lets SQLite satisfy the ORDER BY from the index itself instead of a separate sort step.
  index('outbox_content_pending').on(t.processedAt, t.dead, t.id),
])
