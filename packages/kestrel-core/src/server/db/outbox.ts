/**
 * The transactional outbox: one `outbox_<module>` table per writing module, holding `EventEnvelope`
 * rows written in the SAME transaction as the record they describe (see `persist.ts`). A consumer reads
 * and marks rows processed later — this module only owns the table shape and the write/read primitives,
 * not delivery.
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Schema } from 'effect'
import { EventEnvelope } from '@kestrel/contracts'

/** One outbox row, `envelope` already decoded against `EventEnvelope` — a malformed stored row
 * @public
 *  throws instead of surfacing raw JSON to a caller. */
export interface OutboxRow {
  id: number
  envelope: EventEnvelope
  aggregateKey: string
  sequence: number
  processedAt: string | null
  attempts: number
  dead: boolean
}

interface RawOutboxRow {
  id: number
  envelope: string
  aggregate_key: string
  sequence: number
  processed_at: string | null
  attempts: number
  dead: number
}

const decodeEnvelope = Schema.decodeUnknownSync(EventEnvelope)
const encodeEnvelope = Schema.encodeSync(EventEnvelope)

/** `outbox_<module>` — one table per writing module, joining that module's own ownership manifest (the
 * @public
 *  outbox is content the module writes, not a shared system table). */
export function outboxTableName(module: string): string {
  return `outbox_${module}`
}

/** Idempotent DDL (`CREATE TABLE IF NOT EXISTS`) — content's own `outbox_content` exists via migration
 *  (`0015_outbox_content.sql`), so the write path never calls this; it exists for a module with no
 * @public
 *  migration of its own (a test's synthetic `outbox_media`, a future non-content module). */
export function ensureOutboxTable(sqlite: Database.Database, module: string): void {
  const name = outboxTableName(module)
  sqlite.exec(`CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    envelope TEXT NOT NULL,
    aggregate_key TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    processed_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    dead INTEGER NOT NULL DEFAULT 0
  )`)
  // Mirrors `outbox-content.ts`'s indexes — `nextSequence` scans by `aggregate_key` on every write; the
  // poller's poll query is `WHERE processed_at IS NULL AND dead = 0 ORDER BY id ASC`.
  sqlite.exec(`CREATE INDEX IF NOT EXISTS ${name}_aggregate ON ${name} (aggregate_key, sequence)`)
  sqlite.exec(`CREATE INDEX IF NOT EXISTS ${name}_pending ON ${name} (processed_at, dead, id)`)
}

/** The raw `better-sqlite3.Database` handle behind a Drizzle instance — same escape hatch `content-db.ts`/
 * @public
 *  `media-db.ts` use, needed here since the outbox is written and read via raw SQL, not a Drizzle table. */
export function sqliteClientOf(db: BetterSQLite3Database): Database.Database {
  return (db as unknown as { $client: Database.Database }).$client
}

function decodeRow(row: RawOutboxRow): OutboxRow {
  return {
    id: row.id,
    envelope: decodeEnvelope(JSON.parse(row.envelope)),
    aggregateKey: row.aggregate_key,
    sequence: row.sequence,
    processedAt: row.processed_at,
    attempts: row.attempts,
    dead: row.dead === 1,
  }
}

/** Ordered by `id` ascending (insertion order) — the delivery order a consumer replays in.
 * @public
 */
export function readOutbox(db: BetterSQLite3Database, module: string): OutboxRow[] {
  const rows = sqliteClientOf(db).prepare(`SELECT * FROM ${outboxTableName(module)} ORDER BY id ASC`).all() as RawOutboxRow[]
  return rows.map(decodeRow)
}

/** The poller's own query — not yet processed and not dead-lettered, in delivery order. Served by the
 *  `(processed_at, dead, id)` index (see `outbox-content.ts`), so both the filter and the `ORDER BY` come
 *  straight off the index, no separate sort step. `limit` bounds a single poll: a backlog built up while
 * @public
 *  the worker was down must drain over several ticks, not get dispatched all at once. */
export function readPendingOutbox(db: BetterSQLite3Database, module: string, limit: number): OutboxRow[] {
  const rows = sqliteClientOf(db)
    .prepare(`SELECT * FROM ${outboxTableName(module)} WHERE processed_at IS NULL AND dead = 0 ORDER BY id ASC LIMIT ?`)
    .all(limit) as RawOutboxRow[]
  return rows.map(decodeRow)
}

/** The admin dead-letter list — everything the worker gave up on, in the order it originally arrived. Not
 *  index-served (a full scan of `dead = 1` rows): dead-lettered rows are expected to stay rare, and this
 * @public
 *  is an admin-only, rarely-called read — not worth a dedicated index for. */
export function readDeadLetters(db: BetterSQLite3Database, module: string): OutboxRow[] {
  const rows = sqliteClientOf(db)
    .prepare(`SELECT * FROM ${outboxTableName(module)} WHERE dead = 1 ORDER BY id ASC`)
    .all() as RawOutboxRow[]
  return rows.map(decodeRow)
}

/** An optimistic-concurrency `UPDATE` on `attempts` — `expectedAttempts` must be the value the caller read
 *  the row at (from {@link readPendingOutbox}) — that atomically increments `attempts` (this IS the row's
 *  first recorded attempt for this dispatch) and returns `true` only if `attempts` still matched.
 *  `processed_at IS NULL AND dead = 0` alone is NOT a sufficient guard: neither changes when a claim
 *  succeeds, so two claims reading the SAME row snapshot would otherwise both pass it. This CAS protects
 *  exactly that — two reads of the same `attempts` value racing to increment it, only one of which can win.
 *
 *  It is NOT general cross-dispatch exclusivity, and does not claim to be: a SECOND, staggered read that
 *  happens after this claim has already landed sees the new `attempts` value and CASes against THAT,
 *  succeeding too — see `outbox-worker.ts`'s `dispatchRow`/`pollOnce` TSDoc for what actually keeps
 *  `pollOnce` calls from overlapping (an in-process guard, nothing here). Multi-process outbox workers are
 *  UNSUPPORTED: this function provides no exclusivity across two Node processes polling the same db.
 *
 *  From the first successful claim on, `attempts` is a real, persisted lifetime counter: a crash
 *  mid-retry-ladder leaves whatever count was reached, not a reset budget — see `dispatchRow`'s own
 * @public
 *  restart-budget check, which is what actually consults it. */
export function claimOutboxRow(sqlite: Database.Database, module: string, id: number, expectedAttempts: number): boolean {
  const info = sqlite
    .prepare(`UPDATE ${outboxTableName(module)} SET attempts = attempts + 1 WHERE id = ? AND processed_at IS NULL AND dead = 0 AND attempts = ?`)
    .run(id, expectedAttempts)
  return info.changes === 1
}

/** Records one more dispatch attempt against an already-claimed row (a retry after the claim's own first
 *  attempt). No `WHERE processed_at IS NULL AND dead = 0` guard, and no CAS: the caller is the single
 *  in-process fiber that won {@link claimOutboxRow} for this row and is not re-checking eligibility, only
 *  recording that another attempt ran. Safe only under the same single-process scoping `claimOutboxRow`
 * @public
 *  documents — there is no protection here against a second process also believing it owns this row. */
export function incrementOutboxAttempts(sqlite: Database.Database, module: string, id: number): void {
  sqlite.prepare(`UPDATE ${outboxTableName(module)} SET attempts = attempts + 1 WHERE id = ?`).run(id)
}

/** Marks one row successfully delivered — never re-selected by {@link readPendingOutbox} again.
 * @public
 */
export function markOutboxProcessed(sqlite: Database.Database, module: string, id: number, processedAt: string): void {
  sqlite.prepare(`UPDATE ${outboxTableName(module)} SET processed_at = ? WHERE id = ?`).run(processedAt, id)
}

/** Marks one row dead-lettered — after its retry budget is exhausted, or immediately on a strict-upcast
 *  failure (no retries for a structural gap). `attempts` is left as whatever {@link claimOutboxRow}/
 * @public
 *  {@link incrementOutboxAttempts} already recorded; this only flips the `dead` flag. */
export function markOutboxDead(sqlite: Database.Database, module: string, id: number): void {
  sqlite.prepare(`UPDATE ${outboxTableName(module)} SET dead = 1 WHERE id = ?`).run(id)
}

/** `<collection>:<recordId>` — one aggregate stream per record, gapless per stream (see `nextSequence`).
 * @public
 */
export function aggregateKeyOf(aggregate: { collection: string, recordId: number }): string {
  return `${aggregate.collection}:${aggregate.recordId}`
}

interface CachedStatements {
  nextSequence: Database.Statement
  insert: Database.Statement
}

// One writing call site (`persist.ts`) prepares these on every unit of every write — a 5-row `updateMany`
// would otherwise compile ten statements inside the critical section. `better-sqlite3` `Statement`s are
// reusable and connection-scoped, so cache them per `(connection, module)` instead of re-preparing.
const statementCache = new WeakMap<Database.Database, Map<string, CachedStatements>>()

function statementsFor(sqlite: Database.Database, module: string): CachedStatements {
  let byModule = statementCache.get(sqlite)
  if (!byModule) {
    byModule = new Map()
    statementCache.set(sqlite, byModule)
  }
  let cached = byModule.get(module)
  if (!cached) {
    const name = outboxTableName(module)
    cached = {
      nextSequence: sqlite.prepare(`SELECT MAX(sequence) as maxSeq FROM ${name} WHERE aggregate_key = ?`),
      insert: sqlite.prepare(`INSERT INTO ${name} (envelope, aggregate_key, sequence) VALUES (?, ?, ?)`),
    }
    byModule.set(module, cached)
  }
  return cached
}

/** The next sequence number for `aggregateKey` — `MAX(sequence) + 1` read and written inside the same
 *  synchronous transaction as the record write, so the single-writer property (no concurrent sqlite
 *  connection can interleave) makes this race-free without a separate counter table. Depends on retention:
 *  this reads `MAX(sequence)` off the outbox table itself, so a future purge of processed rows must not
 *  delete the highest-sequence row of a still-live aggregate, or that aggregate's next write would restart
 * @public
 *  its sequence from a lower number instead of continuing gaplessly. */
export function nextSequence(sqlite: Database.Database, module: string, aggregateKey: string): number {
  const row = statementsFor(sqlite, module).nextSequence.get(aggregateKey) as { maxSeq: number | null }
  return (row.maxSeq ?? 0) + 1
}

/** Builds a decoded `EventEnvelope` — `id` is a fresh UUID, everything else comes from the caller
 * @public
 *  (the pipeline's `RequestFacts` for timing/correlation/causation, the write unit for aggregate/payload). */
export function buildEnvelope(input: {
  name: string
  version: number
  aggregate: { collection: string, recordId: number }
  sequence: number
  correlationId: string
  causation: { pipeline: string, op: string }
  occurredAt: string
  payload: unknown
}): EventEnvelope {
  return decodeEnvelope({ id: randomUUID(), ...input })
}

/** Inserts one envelope row. Must run inside the same `better-sqlite3` transaction as the record write it
 * @public
 *  describes — this function itself does not open one. */
export function insertOutboxRow(sqlite: Database.Database, module: string, envelope: EventEnvelope): void {
  statementsFor(sqlite, module).insert.run(
    JSON.stringify(encodeEnvelope(envelope)),
    aggregateKeyOf(envelope.aggregate),
    envelope.sequence,
  )
}
