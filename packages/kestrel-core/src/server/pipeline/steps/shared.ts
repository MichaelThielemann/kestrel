import { and, eq, getTableColumns } from 'drizzle-orm'
import { createError } from 'h3'
import type { H3Event } from 'h3'
import { Effect, Schema } from 'effect'
import { Conflict, ValidatedInput, ValidationFailed } from '@michaelthielemann/kestrel-contracts'
import type { KestrelError } from '@michaelthielemann/kestrel-contracts'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import { isKestrelError } from '@michaelthielemann/kestrel-core'
import type { BuiltCollection, CollectionDef } from '@michaelthielemann/kestrel-core'
import type { PipelineContext } from '../types.js'

/** @public */
export type DB = BetterSQLite3Database
/** @public */
export type Row = Record<string, unknown>

/** One committed row change, snapshotted by `emitEvents` — the shape every after-step reads off
 * @public
 *  `ctx.work.events` instead of a bus emit. */
export interface WriteEvent {
  def: CollectionDef
  before: Row | null
  after: Row | null
}

/**
 * One record on its way into the database: the values to persist, the row it replaces (null on create)
 * and — after `persist` — the stored result. Every write step reads and writes this list, so a single
 * step implementation serves both the one- and the many-cardinality pipelines.
 * @public
 */
export interface WriteUnit {
  values: ValidatedInput
  before: Row | null
  row?: Row
}

const decodeValidated = Schema.decodeUnknownSync(ValidatedInput)

/** Brand a row that has just come out of `decodeInput` (or is built entirely from its output) as
 *  `ValidatedInput` — the one gate `persist` accepts through. A plain object literal built by hand,
 * @public
 *  never routed through `decodeInput`, does not compile as a `WriteUnit.values` assignment. */
export function asValidated(row: Row): ValidatedInput {
  return decodeValidated(row)
}

/** @public */
export function collectionOf(ctx: PipelineContext): BuiltCollection {
  const c = ctx.exec.collection
  if (!c) throw new Error('[kestrel] a write step ran without a collection in `exec`')
  return c
}

/** The record id a `/<pipeline>/<id>` route carries — a clean 400 for a step that cannot run without one.
 * @public
 */
export function requireRecordId(ctx: PipelineContext): Effect.Effect<number, ValidationFailed> {
  return ctx.id === undefined
    ? Effect.fail(new ValidationFailed({ issues: [{ path: ['id'], message: `${ctx.facts.op} requires a record id` }] }))
    : Effect.succeed(ctx.id)
}

/** The request a step is serving — only a pipeline reached over HTTP has one.
 * @public
 */
export function eventOf(ctx: PipelineContext): H3Event {
  const event = ctx.ports.event
  if (!event) throw new Error(`[kestrel] step of "${ctx.facts.op}" needs the request event, but the pipeline was run programmatically`)
  return event
}

/** @public */
export function dbOf(ctx: PipelineContext): DB {
  const db = ctx.ports.db
  if (!db) throw new Error('[kestrel] a write step ran without a database in `ports`')
  return db
}

/** @public */
export function unitsOf(ctx: PipelineContext): WriteUnit[] {
  return (ctx.work.units ??= [] as WriteUnit[]) as WriteUnit[]
}

/** The events `emitEvents` snapshotted for this run — after-steps read this instead of a bus emit.
 * @public
 */
export function eventsOf(ctx: PipelineContext): WriteEvent[] {
  return (ctx.work.events ??= [] as WriteEvent[]) as WriteEvent[]
}

/** A PUT on a singleton is `updateOne` without an id — the one signal that tells the shared update steps
 * @public
 *  which of the two shapes they are running. */
export function isSingletonWrite(ctx: PipelineContext): boolean {
  return ctx.id === undefined
}

// The table is built at runtime from the collection's fields, so its columns can't be statically typed —
// `Record<string, AnySQLiteColumn>` is the honest shape (keyed by jsKey) every query helper indexes into.
/** @public */
export function columns(c: BuiltCollection): Record<string, AnySQLiteColumn> {
  return getTableColumns(c.table) as Record<string, AnySQLiteColumn>
}

/** @public */
export function table(c: BuiltCollection): AnySQLiteTable {
  return c.table as AnySQLiteTable
}

/** Whether a thrown DB error is a SQLite UNIQUE-constraint violation. The single home for this brittle
 * @public
 *  driver-message heuristic, reused by every write path that maps it to a 409 (crud + media upload). */
export function isUniqueViolation(error: unknown): boolean {
  return String((error as Error)?.message).includes('UNIQUE')
}

/** Column names a SQLite UNIQUE-constraint failure lists, e.g. "UNIQUE constraint failed: pages.path,
 *  pages.locale" -\> ['path', 'locale']. */
function uniqueViolationColumns(message: string): string[] {
  return [...message.matchAll(/\.(\w+)/g)].map((m) => m[1]!)
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** Run a DB write, mapping SQLite's UNIQUE-constraint failure to a tagged `Conflict`. A composite index
 *  scoped by locale (translation-group or singleton-key) is reported as the `locale` field, a path index
 *  as `path`, anything else (a field-level `.unique()`) as its own column — `values` supplies the value
 * @public
 *  that was actually being written for whichever field the failure resolves to. */
export function runCatchingUnique<T>(fn: () => T, values: Row): T {
  try {
    return fn()
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const columns = uniqueViolationColumns(String((error as Error).message))
    const field = columns.includes('path') ? 'path' : columns.length === 1 ? snakeToCamel(columns[0]!) : 'locale'
    throw new Conflict({ field, value: String(values[field] ?? ''), details: { kind: 'duplicate' } })
  }
}

/** WHERE matching a collection's singleton row: keyed by name, plus locale for translatable singletons.
 * @public
 */
export function singletonWhere(cols: Record<string, AnySQLiteColumn>, c: BuiltCollection, loc: string | undefined) {
  const key = eq(cols.singletonKey, c.name)
  return c.def.translatable ? and(key, eq(cols.locale, loc)) : key
}

/** Re-enforce `required` for conditional fields whose condition is met (the per-field schema relaxes
 *  them since it can't see siblings). Runs on the EFFECTIVE record — for a partial update/PUT that is
 *  the existing row overlaid with the parsed change, so a patch that merely makes the condition met is
 * @public
 *  validated too. Same 400 shape as a Zod failure, keyed by the field's def name. */
export function assertConditions(c: BuiltCollection, record: Row): Effect.Effect<void, ValidationFailed> {
  const issues = c.applyConditions?.(record).issues
  // Real path segments through, unjoined — the admin editor reads them positionally (see validate.ts).
  return issues?.length ? Effect.fail(new ValidationFailed({ issues })) : Effect.void
}

/** @public */
export function assertNotSingleton(c: BuiltCollection): void {
  if (c.def.mode === 'single') throw createError({ statusCode: 405, statusMessage: 'Use updateOne for singletons' })
}

/**
 * Bridge a plain function that may still throw — a helper nothing has converted, or a nested pipeline run
 * (`runWrite`/`runPipelineSync`, which reduces its own internal Effect back to throw-or-return at that
 * boundary) — into the typed channel: a `KestrelError` becomes a proper `Effect.fail`, anything else (a
 * genuinely transport-level survivor, or a real bug) stays a `throw`, surfacing as a defect exactly as it
 * did before this module used Effect at all. Not for new step-body logic — write that as `Effect.gen` with
 * `Effect.fail` directly; this exists for the few remaining call sites where the failure is produced
 * OUTSIDE the step's own control.
 * @public
 */
export function fromThrowing<T>(fn: () => T): Effect.Effect<T, KestrelError> {
  return Effect.try({ try: fn, catch: (error) => error }).pipe(
    Effect.catchAll((error) => (isKestrelError(error) ? Effect.fail(error) : Effect.die(error))),
  )
}

/** The async counterpart — bridges a Promise-returning function that may reject with a `KestrelError` (an
 *  expected failure) or anything else (a survivor, or a real bug). Same reclassification as `fromThrowing`,
 *  for the handful of call sites where the throwing function is itself async (a locked critical section, a
 * @public
 *  nested pipeline run awaited instead of run sync). */
export function fromThrowingAsync<T>(fn: () => Promise<T>): Effect.Effect<T, KestrelError> {
  return Effect.tryPromise({ try: fn, catch: (error) => error }).pipe(
    Effect.catchAll((error) => (isKestrelError(error) ? Effect.fail(error) : Effect.die(error))),
  )
}
