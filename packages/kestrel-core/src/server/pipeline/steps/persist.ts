import { eq, inArray } from 'drizzle-orm'
import { Effect } from 'effect'
import { NotFound, type ValidatedInput } from '@kestrel/contracts'
import { sanitizeRichtext } from '@kestrel/core'
import type { BuiltCollection } from '@kestrel/core'
import { sqliteClientOf } from '../../db/outbox.js'
import { insertRevisionRow, nextRevisionNumber, schemaVersionOf } from '../../db/revisions.js'
import { emitOutboxForUnit } from './emit-events.js'
import { collectionOf, columns, dbOf, isSingletonWrite, runCatchingUnique, table, unitsOf, type Row, type WriteUnit } from './shared.js'
import { syncStep, type PipelineContext, type StepDef } from '../types.js'

/** Content is the only module `persist` writes for today — every collection reaching this step comes
 *  through `registerCollection`/`buildCollection`, which is content's own domain. */
const OUTBOX_MODULE = 'content'

/** The record write and its outbox envelope land or roll back together — the atomicity the outbox
 *  contract requires. `db.transaction()` is synchronous (better-sqlite3), so this stays legal inside the
 *  critical section (`assertCriticalSection` rejects anything that could suspend here); the callback and
 *  everything it calls (`emitOutboxForUnit`, which reads/writes on the same connection via `$client`) run
 *  on the one sqlite connection this process holds, so the whole block is one BEGIN/COMMIT. */
function emitOutbox(ctx: PipelineContext, c: BuiltCollection, unit: WriteUnit): void {
  emitOutboxForUnit(sqliteClientOf(dbOf(ctx)), OUTBOX_MODULE, ctx, c, unit)
}

/** Appends one revision row for `unit`'s just-persisted result, in the same transaction as the record
 *  write (mirrors `emitOutbox`'s atomicity). `created_at` is the row's own timestamp for this version —
 *  `createdAt` on a create, `updatedAt` on an update — both of which already trace back to `ctx.facts.now`
 *  (directly for an update's `updatedAt`, via the DB default for a create's `createdAt`), never a fresh
 *  `Date.now()` read of this function's own.
 *  `snapshot` is `unit.row` as-is, which for every shape but `updateMany` is the real, re-read stored row —
 *  `updateMany` has no `RETURNING`, so its `unit.row` (and so this snapshot) is the client-side synthesis
 *  `{...before, ...patchValues}` this same step already builds for the outbox payload, not a re-read; see
 *  `revisions.ts`'s header for the caveat this implies.
 *  `createdAtOverride` lets a caller stamp this revision's own timestamp directly instead of deriving it
 *  from the row: the derivation is only valid because a create/update's own `createdAt`/`updatedAt` column
 *  already equals "now" by construction — a rollback restoring a deleted record deliberately preserves the
 *  ORIGINAL `createdAt`, so it cannot double as this revision's timestamp the way it can for a real create. */
function appendRevision(ctx: PipelineContext, c: BuiltCollection, unit: WriteUnit, createdAtOverride?: string): void {
  const row = unit.row!
  const recordId = row.id as number
  const client = sqliteClientOf(dbOf(ctx))
  const createdAt = createdAtOverride ?? new Date((unit.before === null ? row.createdAt : row.updatedAt) as string | number | Date).toISOString()
  insertRevisionRow(client, c.name, {
    recordId,
    revision: nextRevisionNumber(client, c.name, recordId),
    snapshot: row,
    schemaVersion: schemaVersionOf(c.def),
    correlationId: ctx.facts.correlationId,
    createdAt,
  })
}

/** Appends one TOMBSTONE revision for a just-deleted unit — same transaction as the delete statement, same
 *  MAX+1 sequencing as `appendRevision`, no row left to snapshot. `created_at` is `ctx.facts.now`: unlike a
 *  create/update, the deleted row carries no timestamp of its own for this version. */
function appendTombstone(ctx: PipelineContext, c: BuiltCollection, unit: WriteUnit): void {
  const recordId = unit.before!.id as number
  const client = sqliteClientOf(dbOf(ctx))
  insertRevisionRow(client, c.name, {
    recordId,
    revision: nextRevisionNumber(client, c.name, recordId),
    snapshot: null,
    schemaVersion: schemaVersionOf(c.def),
    correlationId: ctx.facts.correlationId,
    createdAt: ctx.facts.now,
    tombstone: true,
  })
}

/** @public */
export type PersistKind = 'createOne' | 'createMany' | 'updateOne' | 'updateMany' | 'deleteMany'

/** @public */
export interface BatchResult {
  count: number
  ids: number[]
}

/** Re-sanitizes one richtext value immediately before the write — idempotent for input that already went
 *  through the field validator's own `sanitizeRichtext` transform (defense-in-depth, not a guarantee: see
 *  ADR-0018 for why this is not the same claim as compile-level `SanitizedRichtext` enforcement). A
 *  non-string (null/undefined, an unset optional field) passes through untouched, so the return type
 *  stays `unknown` rather than claiming a brand this function cannot enforce on its caller. */
function writeRichtextColumn(raw: unknown): unknown {
  return typeof raw === 'string' ? sanitizeRichtext(raw) : raw
}

/** Re-sanitizes every `richtext`-typed top-level column `values` carries (mutates in place) — block/
 *  repeater richtext lives inside a JSON column and is out of scope here; a JSON blob has no single
 *  column value to brand, only the field values the tree walker already sanitized during validation. Logs
 *  when a value actually changes: on the normal validate → persist path this seam is a no-op (idempotent),
 *  so a change here means something upstream produced richtext that was NOT already sanitized — worth
 *  knowing about even though this function silently closes the gap rather than failing the write. */
function brandRichtextColumns(c: BuiltCollection, values: Row): void {
  for (const [key, field] of Object.entries(c.def.fields)) {
    if (field.type !== 'richtext' || !(key in values)) continue
    const before = values[key]
    const after = writeRichtextColumn(before)
    if (after !== before) {
      console.warn(`[kestrel] persist: richtext column "${key}" on "${c.name}" was not already sanitized — re-sanitized at write time`)
    }
    values[key] = after
  }
}

/** The `rollback` pipeline's own persist step — reuses `emitOutbox`/`appendRevision`/`runCatchingUnique`/
 *  `brandRichtextColumns` rather than a parallel write implementation, the same seams every other kind runs
 *  through. Rollback is itself APPEND-ONLY: it upserts the current row to the target revision's snapshot
 *  and appends a brand-new revision describing that write — never a rewind that deletes or mutates history.
 *  `unit.before` (loaded by `loadRollbackTargetStep`) decides the outbox event name for free: `null` (the
 *  record was deleted) reads as `<collection>.created` — honest, since the record REAPPEARS for any
 *  consumer watching the outbox — a non-null `before` reads as the ordinary `<collection>.updated`.
 *
 *  A rollback is a NEW write, not a time machine: `updatedAt` is stamped to `ctx.facts.now` (mirrors
 *  `updateOne`), and the appended revision's own timestamp is stamped the same way (via `appendRevision`'s
 *  override) — so the revision log and `If-Unmodified-Since` both see this as the newest write, never as a
 *  reappearance of the target revision's own original moment. `createdAt` stays whatever the snapshot
 *  carried: a restore does not reset a record's birth date. A colliding restore (the target revision's
 *  unique column value was reused by a different row while this one was gone) surfaces as the same tagged
 *  `Conflict` every other write maps a UNIQUE violation to, via `runCatchingUnique` — never a raw driver
 * @public
 *  error. */
export function persistRollbackStep(): StepDef {
  return syncStep('persist', (ctx) => Effect.sync(() => {
    const c = collectionOf(ctx)
    const db = dbOf(ctx)
    const cols = columns(c)
    const unit = unitsOf(ctx)[0]!
    const values = { ...(ctx.work.rollbackSnapshot as Row) }
    values.updatedAt = new Date(ctx.facts.now)
    brandRichtextColumns(c, values)
    db.transaction(() => {
      unit.row = runCatchingUnique(
        () => db.insert(table(c)).values(values).onConflictDoUpdate({ target: cols.id!, set: values }).returning().get() as Row,
        values,
      )
      emitOutbox(ctx, c, unit)
      appendRevision(ctx, c, unit, ctx.facts.now)
    })
    ctx.output = unit.row
  }), { sealed: true })
}

/** @public */
export function persistStep(kind: PersistKind): StepDef {
  return syncStep('persist', (ctx) => Effect.gen(function* () {
      const c = collectionOf(ctx)
      const db = dbOf(ctx)
      const cols = columns(c)
      const units = unitsOf(ctx)

      if (kind === 'createOne' || kind === 'createMany') {
        const insert = (values: Row): Row => {
          delete values.id
          delete values.createdAt
          delete values.updatedAt
          brandRichtextColumns(c, values)
          return db.insert(table(c)).values(values).returning().get() as Row
        }
        // One atomic block, always: record write(s) and their outbox envelope(s) land or roll back
        // together. A failing element rolls the whole insert back, and the write events (emitted by the
        // next step) never describe a row that is not committed. Each insert is still wrapped
        // individually so a UNIQUE violation reports the actual unit that collided.
        db.transaction(() => {
          for (const unit of kind === 'createMany' ? units : [units[0]!]) {
            unit.row = runCatchingUnique(() => insert(unit.values), unit.values)
            emitOutbox(ctx, c, unit)
            appendRevision(ctx, c, unit)
          }
        })
        ctx.output = kind === 'createMany' ? units.map((unit) => unit.row!) : units[0]!.row!
        return
      }

      if (kind === 'updateOne') {
        const unit = units[0]!
        const values = unit.values
        if (isSingletonWrite(ctx)) {
          delete values.id
          delete values.createdAt
          delete values.updatedAt
          brandRichtextColumns(c, values)
          db.transaction(() => {
            unit.row = runCatchingUnique(() => (unit.before
              ? db.update(table(c)).set({ ...values, updatedAt: new Date(ctx.facts.now) }).where(eq(cols.id, unit.before.id)).returning().get()
              : db.insert(table(c)).values(values).returning().get()) as Row, values)
            emitOutbox(ctx, c, unit)
            appendRevision(ctx, c, unit)
          })
          ctx.output = unit.row
          return
        }
        delete values.id
        delete values.createdAt
        delete values.translationGroup
        delete values.singletonKey
        brandRichtextColumns(c, values)
        let row: Row | undefined
        db.transaction(() => {
          row = runCatchingUnique(() => db.update(table(c)).set(values).where(eq(cols.id, ctx.id!)).returning().get() as Row | undefined, values)
          if (row) {
            unit.row = row
            emitOutbox(ctx, c, unit)
            appendRevision(ctx, c, unit)
          }
        })
        if (!row) return yield* Effect.fail(new NotFound({ collection: c.name, id: ctx.id! }))
        ctx.output = row
        return
      }

      const ids = ctx.work.ids as number[]
      db.transaction(() => {
        if (kind === 'updateMany') {
          // Declares the brand `validate.ts`'s `validatePatchStep` actually stored (`asValidated`), rather
          // than casting down to plain `Row` — a downcast here is what let unvalidated input reach the
          // batch write without the type system objecting.
          const values = ctx.work.patchValues as ValidatedInput
          brandRichtextColumns(c, values)
          db.update(table(c)).set(values).where(inArray(cols.id, ids)).run()
          // No RETURNING on a batch statement: `unit.row` (and so the outbox envelope's payload) is a
          // client-side reconstruction, not a re-read of the stored row. Accurate only as long as every
          // written column is one `values` already carries — a DB-side computed column (a trigger, a
          // generated column) would silently diverge from what this reconstructs.
          for (const unit of units) unit.row = { ...unit.before, ...values }
        } else {
          db.delete(table(c)).where(inArray(cols.id, ids)).run()
        }
        for (const unit of units) {
          emitOutbox(ctx, c, unit)
          if (kind === 'updateMany') appendRevision(ctx, c, unit)
          else appendTombstone(ctx, c, unit)
        }
      })
      ctx.output = { count: units.length, ids: units.map((unit) => unit.before!.id as number) } satisfies BatchResult
  }), { sealed: true })
}
