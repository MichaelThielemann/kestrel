import type Database from 'better-sqlite3'
import { Effect } from 'effect'
import { buildEnvelope, insertOutboxRow, nextSequence } from '../../db/outbox.js'
import { collectionOf, eventsOf, unitsOf, type Row, type WriteUnit } from './shared.js'
import { syncStep, type PipelineContext, type StepDef } from '../types.js'
import type { BuiltCollection } from '@michaelthielemann/kestrel-core'

/** `<collection>.created` (no prior row), `<collection>.updated` (both present), `<collection>.deleted`
 *  (no surviving row) — the only taxonomy this codebase has ever needed a write event to carry. */
function eventNameFor(collection: string, before: Row | null, after: Row | null): string {
  if (before === null) return `${collection}.created`
  if (after === null) return `${collection}.deleted`
  return `${collection}.updated`
}

/** Inserts one `EventEnvelope` row for `unit` into `module`'s outbox — MUST run inside the same
 *  `better-sqlite3` transaction as the record write `unit` describes (see `persist.ts`), so the record and
 *  its envelope land or roll back together. `sequence` is `MAX(sequence) + 1` per aggregate, read and
 *  written inside that same transaction — race-free under the engine's single-writer sync guarantee.
 *
 *  An `updated` envelope's payload is `{ before, after }` — both full rows — so a before-dependent consumer
 *  (planPublish's path/status-change classification) can read the prior state straight off the envelope
 *  instead of a DB re-query, which only ever has the CURRENT row. `created`/`deleted` stay a single row
 *  (`after`/`before` respectively): there is no "other side" to carry. This is an in-place shape change at
 *  version 1, not a version bump — pre-release, outbox rows are transient operational data, not a published
 * @public
 *  wire contract; see ADR-0024 for the reasoning. */
export function emitOutboxForUnit(sqlite: Database.Database, module: string, ctx: PipelineContext, c: BuiltCollection, unit: WriteUnit): void {
  const before = unit.before
  const after = unit.row ?? null
  const row = after ?? before
  const recordId = (row!.id) as number
  const aggregate = { collection: c.name, recordId }
  const aggregateKey = `${c.name}:${recordId}`
  const payload = before === null || after === null ? row : { before, after }
  const envelope = buildEnvelope({
    name: eventNameFor(c.name, before, after),
    version: 1,
    aggregate,
    sequence: nextSequence(sqlite, module, aggregateKey),
    correlationId: ctx.facts.correlationId,
    causation: ctx.facts.causation,
    occurredAt: ctx.facts.now,
    payload,
  })
  insertOutboxRow(sqlite, module, envelope)
}

/** Snapshots one write event per touched row onto `ctx.work.events`, strictly AFTER the statement that
 *  persisted them (never inside a rollback-able transaction) — a failed batch can never leave a stray
 *  after-step reacting to a row that was not written. After-steps read the snapshot; none of them run
 *  before this step. Stays sync (built via `syncStep`) so nothing can await between the write and its events.
 *  The outbox row itself is written earlier, by `persist.ts`, inside the write's own transaction — this step
 * @public
 *  only builds the in-memory snapshot after-steps read, it performs no DB write of its own. */
export function emitEventsStep(): StepDef {
  return syncStep('emitEvents', (ctx) => Effect.sync(() => {
    const c = collectionOf(ctx)
    const events = eventsOf(ctx)
    for (const unit of unitsOf(ctx)) events.push({ def: c.def, before: unit.before, after: unit.row ?? null })
  }), { sealed: true })
}
