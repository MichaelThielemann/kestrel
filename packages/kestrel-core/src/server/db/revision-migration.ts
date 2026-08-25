/**
 * Data migration for existing installs upgrading into append-only revisions: seeds revision `1` for every
 * row that predates append-only history (written before `persist.ts` started appending revisions itself)
 * and so has none. A dangerous-operation module — explicit opt-in only, never run implicitly; same
 * `{"force":true}` flag name/value convention `db:migrate`'s own destructive-op opt-in uses (not the same
 * BEHAVIOR: `db:migrate` withholds-and-reports a destructive op when not opted in, this module refuses the
 * whole run outright — see {@link migrateRevisions}'s own TSDoc for why).
 *
 * ASSUMES the `<collection>_revisions` tables already exist — provisioned by `db:migrate`/
 * `db:migrate-module`/dev's additive schema-sync, same as every other revisions-table consumer
 * (`revisions.ts`'s own TSDoc on why `ensureRevisionsTable` is never called lazily off a write path). This
 * module seeds ROWS, it does not create tables; a missing table surfaces as a clear, named error rather
 * than a raw `no such table`.
 *
 * @packageDocumentation
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import { allCollections } from '../utils/registry.js'
import { insertRevisionRow, revisionsTableName, schemaVersionOf, type Row } from './revisions.js'
import { sqliteClientOf } from './outbox.js'

const MIGRATION_CORRELATION_ID = 'db:migrate-revisions'

/** @public */
export interface MigrateRevisionsResult {
  collection: string
  /** Rows that got a freshly seeded revision 1. */
  seeded: number
  /** Rows already carrying at least one revision — from the ordinary write path, or a previous run of
   *  this same migration — left untouched (this is what makes a rerun a no-op). */
  skipped: number
}

function revisionsTableExists(sqlite: import('better-sqlite3').Database, name: string): boolean {
  return sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined
}

/**
 * Seeds revision `1` for every existing row across every registered collection that has no revision yet.
 * Refuses to run at all without `{ force: true }` — a plain thrown `Error` naming the flag. Unlike
 * `db:migrate`'s per-op withhold-and-report, this is all-or-nothing: there is no meaningful partial "skip
 * just this collection" shape for a data-seeding run the way there is for a schema diff, so an
 * unauthorized call does nothing at all rather than reporting what it would have done.
 *
 * Every collection's `<collection>_revisions` table is checked to exist BEFORE any seeding starts — one
 * sweep over `allCollections()`, throwing the first missing table's name and pointing at `db:migrate`/
 * `db:migrate-module` as the remedy. This is deliberately hoisted above the seeding loop below: the
 * pre-check's whole purpose is failing loud up front, before committing anything — a missing table
 * discovered mid-run (after an earlier collection's transaction already committed) would still leave that
 * earlier collection seeded, but only by accident of iteration order, not by the check's own design.
 *
 * Only iterates `allCollections()` — the currently REGISTERED set. A collection disabled by config toggle
 * at the time this runs is absent from the registry, so its rows are silently NOT seeded; re-running this
 * migration after enabling that collection is safe and picks it up (the per-row idempotence below makes
 * every rerun a no-op for what's already seeded).
 *
 * One `db.transaction()` per COLLECTION during seeding, never one spanning every collection: a failure
 * partway through a collection's rows (once past the up-front table-existence sweep, e.g. a mid-transaction
 * constraint violation) rolls back only that collection's attempted inserts, while an earlier collection's
 * already-committed seeds survive regardless. On failure this function PROPAGATES the error (never
 * continues to the next collection) — a re-run is how an operator resumes, and the per-row idempotence
 * below (skip a record that already has a revision) is what makes that re-run safe.
 *
 * Snapshot = the row exactly as currently stored; `schema_version` = the CURRENT collection def's version
 * (there is no earlier version to preserve — this row predates versioning entirely); `tombstone` = false;
 * `created_at` = the row's own `updatedAt`. A seeded revision describes "the write that produced this
 * row's current state" standing in after the fact, so the row's own timestamp is the honest source — not
 * the migration's wall-clock run time. Note the retention interplay this implies: a seeded revision can be
 * older than a configured `maxAgeDays` immediately, on the very run that creates it — the absolute "never
 * prune the newest/only revision" protection (`pruneRevisions`) is what keeps it alive regardless.
 *
 * A row with no live current-table entry (deleted long before this migration ever runs, on an install that
 * predates append-only revisions with no tombstone trail at all) gets no fabricated revision — this only iterates the live table,
 * never invents history for a gap it cannot honestly describe.
 * @public
 */
export function migrateRevisions(db: BetterSQLite3Database, opts: { force: boolean }): MigrateRevisionsResult[] {
  if (opts.force !== true) {
    throw new Error('kestrel: db:migrate-revisions refuses to run without the explicit flag — pass {"force":true}')
  }

  const sqlite = sqliteClientOf(db)
  const collections = allCollections()

  for (const collection of collections) {
    const tableName = revisionsTableName(collection.name)
    if (!revisionsTableExists(sqlite, tableName)) {
      throw new Error(
        `kestrel: db:migrate-revisions: "${tableName}" does not exist for collection "${collection.name}" — `
        + `run db:migrate (or db:migrate-module) first to provision it`,
      )
    }
  }

  const results: MigrateRevisionsResult[] = []

  for (const collection of collections) {
    const tableName = revisionsTableName(collection.name)
    const hasRevision = sqlite.prepare(`SELECT 1 FROM ${tableName} WHERE record_id = ? LIMIT 1`)
    // Full-table walk, same shape as rebuildRecordRefs's collection sweep (record-ref-index.ts) — a
    // one-time migration over a bounded set of pre-existing rows. .iterate() is the upgrade if a
    // collection's row count makes materializing the whole table into memory real.
    const rows = db.select().from(collection.table as AnySQLiteTable).all() as Row[]
    let seeded = 0
    let skipped = 0

    db.transaction(() => {
      for (const row of rows) {
        const recordId = row.id as number
        if (hasRevision.get(recordId) !== undefined) {
          skipped++
          continue
        }
        // Every generated table's created_at/updated_at columns are NOT NULL — updatedAt is always
        // present.
        insertRevisionRow(sqlite, collection.name, {
          recordId,
          revision: 1,
          snapshot: row,
          schemaVersion: schemaVersionOf(collection.def),
          correlationId: MIGRATION_CORRELATION_ID,
          createdAt: new Date(row.updatedAt as string | number | Date).toISOString(),
        })
        seeded++
      }
    })

    results.push({ collection: collection.name, seeded, skipped })
  }

  return results
}
