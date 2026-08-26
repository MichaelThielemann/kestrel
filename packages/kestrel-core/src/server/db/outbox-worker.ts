/**
 * The outbox worker's dispatch core: handler registration plus one poll tick's Effect logic, kept apart
 * from the Nitro plugin (`plugins/04.outbox-worker.ts`) so a test can drive the retry schedule with
 * `TestClock` instead of a real timer.
 *
 * @packageDocumentation
 */

import { Effect, Schedule } from 'effect'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { type EventEnvelope, upcastToLatest } from '@michaelthielemann/kestrel-contracts'
import {
  claimOutboxRow,
  incrementOutboxAttempts,
  markOutboxDead,
  markOutboxProcessed,
  readPendingOutbox,
  sqliteClientOf,
  type OutboxRow,
} from './outbox.js'
import { pruneAllDueRevisions } from './revisions.js'

/**
 * What `registerOutboxHandler` hands the worker: the decoded, upcast-to-latest envelope. The handler
 * decodes its payload against its own event's schema, builds a command, and runs the normal pipeline.
 *
 * Delivery contract — read this before registering one:
 * - **At-least-once, never exactly-once.** `better-sqlite3` transactions are synchronous and cannot span a
 *   handler's `await`s, so "processed" cannot be recorded in the same transaction as the handler's own
 *   effect. A crash between a handler finishing and the row being marked processed causes a redelivery of
 *   the same envelope on the next poll. Handlers MUST be idempotent — running the same envelope twice must
 *   converge on the same end state, not compound it.
 * - **Retry re-runs every handler registered for the event, including ones that already succeeded** — not
 *   just the one that failed. A batch of handlers for one event either all succeed or the whole batch
 *   retries together; idempotency is a per-handler property, not a per-event one.
 * - **An event with no registered handler is marked processed anyway** — every write emits its event
 *   regardless of whether anything subscribes to it, so leaving unsubscribed events pending would grow the
 *   table without bound.
 * @public
 */
export type OutboxHandler = (envelope: EventEnvelope) => Promise<void>

interface Registration {
  name: string
  event: string
  handler: OutboxHandler
}

const registry = new Map<string, Registration[]>()

/** A handler name is unique per VERB across all collections — deliberately stricter than strictly
 *  necessary. The co-fire case that must be caught is exact + wildcard on the same verb (`pages.created`
 *  and `*.created` both dispatch for `pages.created`); keying by verb also forbids reusing one name for
 *  two different collections' exact events, which keeps every dead-letter/failure log line unambiguous
 *  about which registration ran. */
const namesByVerb = new Map<string, Set<string>>()

/** Event grammar: `<collection>.<verb>` (e.g. `pages.created`). `collection` may be the literal `*`,
 *  matching every collection for that verb — `*` is not permitted anywhere else (not in `verb`, not as
 *  part of a segment). Anything else is rejected at registration time so a typo'd pattern fails loud
 *  instead of silently never matching. */
function assertValidEventPattern(event: string): void {
  const parts = event.split('.')
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new Error(`[kestrel] invalid outbox event pattern "${event}" — expected "<collection>.<verb>"`)
  }
  const [collection, verb] = parts
  if (verb.includes('*')) {
    throw new Error(`[kestrel] invalid outbox event pattern "${event}" — "*" is not allowed in the verb position`)
  }
  if (collection.includes('*') && collection !== '*') {
    throw new Error(`[kestrel] invalid outbox event pattern "${event}" — "*" must be the entire collection segment`)
  }
}

/** Registers `handler` to run whenever an event named `on.event` is dispatched. `name` must be unique per
 *  VERB, not merely per exact event pattern — an exact registration (`pages.created`) and a collection
 *  wildcard (`*.created`) both dispatch on `pages.created`, so the same name on both would be exactly the
 *  duplicate-registration mistake this guard exists to catch (see `namesByVerb`).
 *
 *  `on.event` may name a collection wildcard in the collection position only — `*.created` fires for
 *  every collection's `created` event. This is the only extension the grammar allows: no regex, no
 * @public
 *  predicate callbacks. */
export function registerOutboxHandler(name: string, on: { event: string }, handler: OutboxHandler): void {
  assertValidEventPattern(on.event)
  const verb = on.event.slice(on.event.lastIndexOf('.') + 1)
  const names = namesByVerb.get(verb) ?? new Set<string>()
  if (names.has(name)) {
    throw new Error(`[kestrel] outbox handler "${name}" is already registered for an event matching "${on.event}"`)
  }
  names.add(name)
  namesByVerb.set(verb, names)
  const list = registry.get(on.event) ?? []
  list.push({ name, event: on.event, handler })
  registry.set(on.event, list)
}

/** Handlers that fire for a concrete dispatched event name: an exact match on `event` plus any collection
 *  wildcard registered for the same verb (`*.<verb>`) — the wildcard is additive, it never shadows or
 * @public
 *  replaces the exact registration. */
export function outboxHandlersFor(event: string): readonly Registration[] {
  const exact = registry.get(event) ?? []
  const verb = event.slice(event.lastIndexOf('.') + 1)
  const wildcardEvent = `*.${verb}`
  const wildcard = event === wildcardEvent ? [] : (registry.get(wildcardEvent) ?? [])
  return wildcard.length === 0 ? exact : [...exact, ...wildcard]
}

/** Test-only reset — mirrors `clearRegistry`/`clearPipelines`/`clearUpcasts`.
 * @public
 */
export function clearOutboxHandlers(): void {
  registry.clear()
  namesByVerb.clear()
}

/** @public */
export interface PollResult {
  processed: number
  deadLettered: number
  /** Rows a claim lost (see `claimOutboxRow`'s TSDoc) — the only observability into claiming; an
   *  empty queue and a queue that was entirely claim-rejected both otherwise look identical (0 processed,
   *  0 dead-lettered). Non-zero here, in single-process operation, means overlapping `pollOnce` calls. */
  skipped: number
}

/** A backlog built up while the worker was down (or a burst of writes) drains over several ticks instead
 *  of dispatching unbounded in one go. */
const POLL_BATCH_LIMIT = 200

/** Total dispatch attempts before a row is dead-lettered: 1 (the claim) + 5 retries. The single source
 *  the retry schedule below and the reader deriving "was this attempt budget exhausted" both come from. */
const RETRY_ATTEMPTS = 6

/** Bounded exponential backoff: 200ms, 400ms, 800ms, 1.6s, 3.2s — `RETRY_ATTEMPTS - 1` retries. Runs
 *  against the ambient `Clock`, so a test can drive it with `TestClock` instead of actually waiting. */
const RETRY_SCHEDULE = Schedule.exponential('200 millis').pipe(Schedule.compose(Schedule.recurs(RETRY_ATTEMPTS - 1)))

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** Wraps a synchronous DB write so a driver-level failure (e.g. `SQLITE_BUSY`) becomes a logged, typed
 *  failure on this Effect's error channel instead of an uncaught defect that would tear down sibling
 *  fibers dispatching other rows in the same poll tick. */
function tryDb<A>(action: () => A): Effect.Effect<A, string> {
  return Effect.try({ try: action, catch: describeError })
}

function logDbFailure(label: string): (error: string) => Effect.Effect<void> {
  return (error) => Effect.logError(`[kestrel] outbox: ${label} — ${error}`)
}

/** Runs every handler registered for `envelope.name`. A handler failure fails the whole dispatch (and so
 *  the retry schedule below) — partial delivery to only some of an event's handlers is not a state the
 *  worker tries to represent; see {@link OutboxHandler}'s TSDoc for the resulting at-least-once contract. */
function runHandlers(envelope: EventEnvelope): Effect.Effect<void, string> {
  const handlers = outboxHandlersFor(envelope.name)
  if (handlers.length === 0) {
    return Effect.logDebug(`[kestrel] outbox: no handler registered for "${envelope.name}" — marking processed anyway`)
  }
  return Effect.forEach(
    handlers,
    (registration) => Effect.tryPromise({
      try: () => registration.handler(envelope),
      catch: (error) => `handler "${registration.name}" (registered on "${registration.event}") failed: ${describeError(error)}`,
    }),
    { discard: true },
  )
}

type DispatchOutcome = 'processed' | 'deadLettered' | 'skipped'

/** One row's dispatch. `upcastToLatest` runs in STRICT mode on this path: a `name`/`version` with no
 *  walkable chain to the latest registered version is a hard, visible failure — dead-lettered with the
 *  reason, never silently passed through as if it were already at the latest version. */
function dispatchRow(db: BetterSQLite3Database, module: string, row: OutboxRow): Effect.Effect<DispatchOutcome> {
  return Effect.gen(function* () {
    const sqlite = sqliteClientOf(db)

    // A restart with the row already at (or past) budget: dead-letter immediately, without another
    // attempt. Without this check `attempts` is persisted but never consulted, so a process-killing
    // handler gets a fresh RETRY_ATTEMPTS-sized ladder every restart and never actually dead-letters.
    if (row.attempts >= RETRY_ATTEMPTS) {
      yield* tryDb(() => markOutboxDead(sqlite, module, row.id)).pipe(Effect.catchAll(logDbFailure(`mark-dead ${module}#${row.id}`)))
      yield* Effect.logError(
        `[kestrel] outbox dead-letter: ${module}#${row.id} (${row.envelope.name}) — attempt budget exhausted across restarts (${row.attempts} >= ${RETRY_ATTEMPTS})`,
      )
      return 'deadLettered' as const
    }

    // Claim: a CAS against `row.attempts` as read by `readPendingOutbox`. This protects against a
    // SAME-SNAPSHOT race — two dispatches that both read this row before either claimed it, where only
    // one's `WHERE attempts = row.attempts` still matches after the other's increment lands first. It does
    // NOT protect against a STAGGERED second read: one that runs after the first claim has already landed
    // reads the NEW `attempts` value and CASes against THAT, so it claims successfully too — see
    // `pollOnce`'s TSDoc and the "staggered second poll" test for this pinned, not hidden. The only thing
    // that actually keeps `pollOnce` calls from overlapping in real operation is `makeTicker`'s in-process
    // in-flight guard; this CAS is not a substitute for it, and there is no cross-process exclusivity here
    // at all — see `claimOutboxRow`'s own TSDoc.
    const claimed = yield* tryDb(() => claimOutboxRow(sqlite, module, row.id, row.attempts)).pipe(
      Effect.catchAll((error) => Effect.as(logDbFailure(`claim ${module}#${row.id}`)(error), false)),
    )
    if (!claimed) return 'skipped' as const

    let envelope: EventEnvelope
    try {
      envelope = upcastToLatest(row.envelope)
    } catch (error) {
      yield* tryDb(() => markOutboxDead(sqlite, module, row.id)).pipe(Effect.catchAll(logDbFailure(`mark-dead ${module}#${row.id}`)))
      yield* Effect.logError(
        `[kestrel] outbox dead-letter: ${module}#${row.id} (${row.envelope.name}@${row.envelope.version}) — strict upcast failed: ${describeError(error)}`,
      )
      return 'deadLettered' as const
    }

    // The claim above already counted as attempt 1; every retry the schedule drives records one more.
    let attemptNumber = 1
    const runOneAttempt = Effect.gen(function* () {
      if (attemptNumber > 1) {
        yield* tryDb(() => incrementOutboxAttempts(sqlite, module, row.id)).pipe(
          Effect.catchAll(logDbFailure(`record attempt ${module}#${row.id}`)),
        )
      }
      attemptNumber++
      yield* runHandlers(envelope)
    })

    const result = yield* Effect.either(runOneAttempt.pipe(Effect.retry(RETRY_SCHEDULE)))
    if (result._tag === 'Left') {
      yield* tryDb(() => markOutboxDead(sqlite, module, row.id)).pipe(Effect.catchAll(logDbFailure(`mark-dead ${module}#${row.id}`)))
      yield* Effect.logError(`[kestrel] outbox dead-letter: ${module}#${row.id} (${envelope.name}) — ${result.left}`)
      return 'deadLettered' as const
    }

    yield* tryDb(() => markOutboxProcessed(sqlite, module, row.id, new Date().toISOString())).pipe(
      Effect.catchAll(logDbFailure(`mark-processed ${module}#${row.id}`)),
    )
    return 'processed' as const
  })
}

/** Groups rows by aggregate, preserving each group's relative `id` order (rows arrive pre-sorted by `id`
 *  ascending from {@link readPendingOutbox}, and `Map` preserves insertion order) — two events for the
 *  SAME aggregate (e.g. a create then a delete of the same record) must dispatch in that order, or a
 *  consumer could observe them backwards. Different aggregates have no ordering relationship to preserve.
 *
 *  The ordering guarantee is deliberately punctured at a dead-letter: `dispatchRow` never fails the Effect
 *  `Effect.forEach` runs this group through (it always resolves to a `DispatchOutcome`, dead-lettered
 *  included), so a row that gets dead-lettered does NOT block the rest of its aggregate's tail — later
 *  events for the same aggregate still dispatch, out of causal order with the one that got stuck. Blocking
 *  an aggregate's whole future forever behind one bad event would be worse. */
function groupByAggregate(rows: readonly OutboxRow[]): OutboxRow[][] {
  const groups = new Map<string, OutboxRow[]>()
  for (const row of rows) {
    const group = groups.get(row.aggregateKey)
    if (group) group.push(row)
    else groups.set(row.aggregateKey, [row])
  }
  return [...groups.values()]
}

/** One poll tick, as an Effect — TestClock-drivable. Groups dispatch with unbounded concurrency (one
 *  poison event's retry ladder never blocks a different aggregate's queue behind it); rows within a group
 *  dispatch strictly in order (`Effect.forEach`'s default sequential concurrency), preserving per-aggregate
 * @public
 *  delivery order. */
export function pollOnceEffect(db: BetterSQLite3Database, module: string): Effect.Effect<PollResult> {
  return Effect.gen(function* () {
    const rows = readPendingOutbox(db, module, POLL_BATCH_LIMIT)
    const groups = groupByAggregate(rows)
    const outcomes = yield* Effect.forEach(
      groups,
      (group) => Effect.forEach(group, (row) => dispatchRow(db, module, row)),
      { concurrency: 'unbounded' },
    )
    let processed = 0
    let deadLettered = 0
    let skipped = 0
    for (const group of outcomes) {
      for (const outcome of group) {
        if (outcome === 'processed') processed++
        else if (outcome === 'deadLettered') deadLettered++
        else skipped++
      }
    }
    return { processed, deadLettered, skipped }
  })
}

/**
 * {@link pollOnceEffect}, run to a `Promise` — the shape the Nitro plugin (and any other non-Effect
 * caller) actually needs; the public consumer API stays Effect-free.
 *
 * In real operation there is exactly one caller: the ticker `makeTicker` builds, which guarantees calls
 * never overlap. `pollOnce`/`pollOnceEffect` themselves enforce nothing of the sort — two overlapping calls
 * against the same db WILL double-dispatch pending rows (see the "staggered second poll" behavior
 * documented on `dispatchRow`'s claim step). A test that wants to call this directly, more than once,
 * against rows it expects to be dispatched exactly once must `await` each call before starting the next.
 * @public
 */
export function pollOnce(db: BetterSQLite3Database, module: string): Promise<PollResult> {
  return Effect.runPromise(pollOnceEffect(db, module))
}

/** Logged, never thrown — a prune failure must not turn an otherwise-successful idle tick into a dead
 *  worker loop (the `setInterval` callback in `plugins/04.outbox-worker.ts` has no other backstop). */
function pruneIdle(db: BetterSQLite3Database): void {
  try {
    pruneAllDueRevisions(db, new Date())
  } catch (error) {
    console.error('[kestrel] revision prune (idle tick) failed', error)
  }
}

/**
 * Builds one tick function for the worker plugin: calls `pollOnce` against `getDb()`'s current db, guarded
 * so overlapping ticks never run concurrently in-process — the retry ladder (up to ~6s) can easily outlast
 * the poll interval, and an overlapping tick would double-dispatch (see `pollOnce`'s TSDoc). Returns `null`
 * without polling when a tick is already in flight.
 *
 * This in-process `inFlight` flag is the WHOLE of the outbox worker's exclusivity guarantee — not
 * `claimOutboxRow`'s CAS, which only protects a same-snapshot race (see `dispatchRow`). Multi-process
 * outbox workers are UNSUPPORTED: nothing here excludes a second Node process polling the same db, and
 * both would happily double-dispatch every row. That is a deliberate scope decision, not an oversight — the
 * whole surrounding architecture already presumes exactly one process (`Effect.runSync`'s critical section,
 * `useDb()`'s single writable connection); a multi-worker deployment would break far more than the outbox
 * before it got here. If multi-worker ever becomes a supported topology, the upgrade path is a lease column
 * (claimed-by/claimed-until) instead of the plain `attempts` CAS.
 *
 * `getDb` is a thunk, not a `db` value, so nothing here reaches for the database until the first actual
 * tick — the plugin stays "nothing touches the db at plugin-init time" even though this factory itself
 * runs at init.
 *
 * An IDLE tick (`processed === 0 && deadLettered === 0` — nothing dispatched, nothing to retry) also runs
 * one bounded revision-prune pass (`pruneAllDueRevisions`) AFTER the poll result is already computed —
 * pruning never delays dispatch, since a busy tick skips it entirely and an idle tick has already returned
 * its `PollResult` in every way that matters by the time pruning starts.
 * @public
 */
export function makeTicker(getDb: () => BetterSQLite3Database, module: string): () => Promise<PollResult | null> {
  let inFlight = false
  return async () => {
    if (inFlight) return null
    inFlight = true
    try {
      const db = getDb()
      const result = await pollOnce(db, module)
      if (result.processed === 0 && result.deadLettered === 0) pruneIdle(db)
      return result
    } finally {
      inFlight = false
    }
  }
}
