import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

// Durable per-route record of the LAST static-publish outcome: did this route's file get written to the
// output target (local dir or S3) successfully, or did the last attempt error? `route` is the natural
// primary key (one latest-state row per route — not a history). The runtime publisher upserts a `success`
// row after each render+put and an `error` row (with the failure message, incl. S3) when one throws; a
// prune (unpublish / delete / slug change) clears the row so the route reads as "not live". The admin
// editor's live-ampel reads it through `/api/publish-status` to show whether THIS record's page is live.
// `updatedAt` via `$defaultFn` (no SQL default → it won't perpetually diff as a rebuild; UNIX seconds via
// `mode:'timestamp'`, matching every other table). Hand-authored system table (not a collection) —
// registered in the desired schema via bootstrap.ts + re-exported from collections/schema.ts, mirroring
// `publish_deps` / `record_refs` / `folders`.
export const publishStatus = sqliteTable('publish_status', {
  route: text('route').primaryKey(),
  status: text('status').notNull(), // 'success' | 'error'
  error: text('error'), // nullable — the failure message (render / write / S3) on an 'error' row
  target: text('target').notNull(), // 'local' | 's3' — which output the attempt wrote to
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})
