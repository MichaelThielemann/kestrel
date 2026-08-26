import { eq, getTableColumns } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { EventEnvelope } from '@michaelthielemann/kestrel-contracts'
import { useContentDb } from '../db/content-db.js'
import { getCollection } from '../utils/registry.js'
import { maintainRecordRefs } from '../utils/record-ref-index.js'
import { registerOutboxHandler } from '../db/outbox-worker.js'

/**
 * Outbox handler for `record_refs`. Registered (via {@link registerReindexRefs}) against the
 * `*.created` / `*.updated` / `*.deleted` collection wildcards, so every content write drives the index
 * without enumerating collections at import time.
 *
 * Idempotency: the envelope carries only IDENTITY (`aggregate.collection`/`recordId`), never the
 * source of truth for what gets indexed. Every delivery re-derives the aggregate's refs from the CURRENT
 * row in the table — present, its refs are extracted fresh (replace-on-write, via `maintainRecordRefs`);
 * gone, its edges are cleared. Redelivering the same envelope twice reruns the same read, so it lands on
 * the same end state both times; an envelope that has gone stale under at-least-once redelivery (e.g. a
 * `created` envelope redelivered after a later `updated` already landed) still converges correctly,
 * because the row read is always the latest, never the envelope's own payload.
 *
 * A throw here fails the whole dispatch for this row (see `dispatchRow` in `outbox-worker.ts`), which
 * retries up to `RETRY_ATTEMPTS` times and then dead-letters — visibly, in the dead-letter table an admin
 * can inspect. Errors staying loud (retried, then dead-lettered) rather than silently swallowed is
 * deliberate.
 */
async function reindexRefs(envelope: EventEnvelope): Promise<void> {
  const { collection, recordId } = envelope.aggregate
  const c = getCollection(collection)
  if (!c) return // an event for a collection no longer registered — nothing to index against.

  const db = useContentDb().db
  const cols = getTableColumns(c.table) as Record<string, AnySQLiteColumn>
  const row = db.select().from(c.table as never).where(eq(cols.id, recordId)).get() as Record<string, unknown> | undefined

  // `maintainRecordRefs` derives the source id from `after ?? before`; a deleted row has no `after`, so
  // `before` carries the id alone — enough identity to clear that source's edges without a real "before" row.
  maintainRecordRefs(db, { def: c.def, before: { id: recordId }, after: row ?? null })
}

/** Registers `reindexRefs` against every content write verb. Called once, from the
 *  `05.reindex-refs.ts` plugin's body — not a module-import side effect, so a test can import this module
 * @public
 *  without registering anything, and control exactly when (and whether) it does. */
export function registerReindexRefs(): void {
  for (const verb of ['created', 'updated', 'deleted']) {
    registerOutboxHandler('reindexRefs', { event: `*.${verb}` }, reindexRefs)
  }
}
