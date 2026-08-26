import { eq } from 'drizzle-orm'
import { publishRuns, PUBLISH_RUNS_RETENTION } from '../../database/publish-runs.js'
import { usePublishingDb, type PublishingDb } from '../../db/publishing-db.js'
import { OwnershipViolation, type ModuleDbBrand } from '@michaelthielemann/kestrel-core'

/** A `publish_runs` row as the orchestrator's Promise-facing consumers see it — plain data, no Effect
 *  type. `error` is set only on a `failed` row.
 * @public
 */
export interface PublishRunRecord {
  id: number
  step: 'command' | 'snapshot' | 'delivery' | 'done'
  status: 'running' | 'done' | 'failed'
  error: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * The injectable seam that actually moves bytes: production wiring drives it through the real publish
 * flow (`publishInvalidation`/the queue's driver+deps), tests drive it with a stub. Takes the run so a
 * delivery can log/tag against its id; the orchestrator does not interpret anything `deliver` returns —
 * only whether it resolves or throws.
 * @public
 */
export interface PublishDelivery {
  deliver: (run: PublishRunRecord) => Promise<void>
}

/** `Pick<T, K>` drops every key outside `K`, including the brand — re-intersected explicitly (mirrors
 *  `record-ref-index.ts`'s own `DB`/`WriteDB`/`RebuildDB`), so a raw `BetterSQLite3Database`/drizzle
 *  instance still fails to structurally satisfy this narrowed type; only a real, ownership-checked
 *  `PublishingDb` does. `db()` below is fed exclusively by `usePublishingDb()` (never a caller-supplied
 *  value — this module exposes no function that takes a db parameter), so this re-intersection is
 *  defense-in-depth against a future call site rather than a currently reachable bypass; verified by
 *  `grep -n 'db: OrchestratorDb\|function db(' packages/kestrel-publishing/src/server/utils/publish/orchestrator.ts`
 *  — `db()` is the type's only producer, and it is 0-arity.
 * @public
 */
export type OrchestratorDb = Pick<PublishingDb, 'select' | 'insert' | 'update' | 'prepare'> & { readonly [ModuleDbBrand]: true }

function db(): OrchestratorDb {
  return usePublishingDb().db
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** SQLite's own wording for "the table isn't there" — the one shape a not-yet-migrated deploy actually
 *  throws (never confused with {@link OwnershipViolation}, which is always checked and rethrown first). */
function isMissingTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message)
}

function insertRun(): PublishRunRecord {
  const row = db().insert(publishRuns).values({ step: 'command', status: 'running' }).returning().get()
  if (row == null) throw new Error('publish_runs insert returned no row')
  return row as PublishRunRecord
}

/** Update-in-place, never append: every step transition writes the SAME row (by id), which is what makes
 *  the sequence durable across a crash instead of just an in-memory object the caller happens to hold. */
function advance(id: number, patch: { step: PublishRunRecord['step']; status: PublishRunRecord['status']; error?: string | null }): PublishRunRecord {
  const row = db().update(publishRuns)
    .set({ step: patch.step, status: patch.status, error: patch.error ?? null, updatedAt: new Date() })
    .where(eq(publishRuns.id, id))
    .returning().get()
  if (row == null) throw new Error(`publish_runs update returned no row for id=${id}`)
  return row as PublishRunRecord
}

/** Same missing-table resilience as `publish-status.ts`'s readers: an unmigrated deploy (or a bare test
 *  db that never provisioned `publish_runs`) has no rows to resume, not an error worth crashing boot
 *  over — `resumePublishRuns` runs at plugin init, before anything has had a chance to report the gap. */
function stuckRuns(): PublishRunRecord[] {
  try {
    return db().select().from(publishRuns).where(eq(publishRuns.status, 'running')).all() as PublishRunRecord[]
  } catch (error) {
    if (error instanceof OwnershipViolation) throw error
    if (!isMissingTableError(error)) throw error
    console.warn('[kestrel] could not read publish_runs (is it migrated? run `db:migrate`):', messageOf(error))
    return []
  }
}

/** Keeps `publish_runs` bounded (see `PUBLISH_RUNS_RETENTION`'s own TSDoc): drop non-`running` rows beyond
 *  the newest N, cheap enough to run on every `startPublishRun` call since the table is small by design.
 *  A `running` row is never a deletion candidate, so a crashed run stays visible however old it gets. */
function pruneOldRuns(): void {
  db().prepare(
    `DELETE FROM publish_runs WHERE status != 'running' AND id NOT IN (SELECT id FROM publish_runs ORDER BY id DESC LIMIT ?)`,
  ).run(PUBLISH_RUNS_RETENTION)
}

/** The result of a delivery that ran WITHOUT a `publish_runs` row backing it (the `publish_runs` table
 *  itself is missing — see `startPublishRun`'s missing-table fallback). `id: 0` marks it as synthetic;
 *  never a real row's id (`AUTOINCREMENT` starts at 1). */
async function untrackedDelivery(delivery: PublishDelivery): Promise<PublishRunRecord> {
  const now = new Date()
  const placeholder: PublishRunRecord = { id: 0, step: 'delivery', status: 'running', error: null, createdAt: now, updatedAt: now }
  try {
    await delivery.deliver(placeholder)
    return { ...placeholder, step: 'done', status: 'done', updatedAt: new Date() }
  } catch (error) {
    return { ...placeholder, status: 'failed', error: messageOf(error), updatedAt: new Date() }
  }
}

/**
 * Run one publish as an owned, persisted sequence (ADR-0025):
 *
 *  1. `command`  — the run is accepted: a row is inserted (`status: running`). This is the durable
 *     acknowledgment that a publish was requested, before any work happens.
 *  2. `snapshot` — a checkpoint between acceptance and delivery. The transition itself stays a fast,
 *     synchronous row update (this function has no per-route knowledge — `delivery` decides what "the"
 *     publish covers), but the work it demarcates is real: `publisher.ts`'s `publishRoutesInScope` calls
 *     `recordSnapshot` for every successfully rendered route, BEFORE that route's static file is written —
 *     the snapshot is the source `delivery-static` reads from, so it must exist first. That render
 *     loop runs inside the `delivery` step below (production wiring's `deliver` closures call straight
 *     into `publishInvalidation`/`publishFull`), so a crash between accepting the run and the first
 *     snapshot write still reads as distinct from a crash mid-delivery.
 *  3. `delivery` — `delivery.deliver(run)` actually runs (the real renderer in production, a stub in
 *     tests). The row is persisted at `step: delivery, status: running` BEFORE `deliver` is invoked, so a
 *     reader mid-delivery (including `deliver` itself, via its own read) observes durable state, not a
 *     caller-held in-memory object.
 *  4. `done` — `deliver` resolved. A throw instead lands the row at `status: failed` with the message
 *     recorded (never swallowed) and returns rather than rethrowing, so the caller gets the outcome as
 *     data, not a rejected Promise — a subsequent `startPublishRun` call is unaffected (no permanent lock).
 *     Production wiring (`zz.publish.ts`) is what turns a `failed` result back into a thrown error, so the
 *     publish queue's own retry-on-failure still fires; that rethrow does NOT happen in here, since the
 *     tests drive this function directly and pin a resolved (not rejected) outcome on delivery failure.
 *
 * Missing-table fallback: a `publish_runs` table that does not exist yet (a not-yet-migrated consumer
 * deploy — production never auto-DDLs) is NOT treated as a delivery failure. Retrying `insertRun` forever
 * would busy-loop the publish queue without ever rendering anything; instead this degrades to an UNTRACKED
 * direct delivery (a warning names the table and `db:migrate`) — publishing keeps working, only the
 * progress bookkeeping is unavailable until the deploy is migrated. `OwnershipViolation` is never treated
 * as "missing table" — it is a programmer-guard error, always rethrown.
 * @public
 */
export async function startPublishRun(delivery: PublishDelivery): Promise<PublishRunRecord> {
  let run: PublishRunRecord
  try {
    run = insertRun()
    pruneOldRuns()
  } catch (error) {
    if (error instanceof OwnershipViolation) throw error
    if (!isMissingTableError(error)) throw error
    console.warn('[kestrel] publish_runs is not migrated (run `db:migrate`) — publishing proceeds untracked:', messageOf(error))
    return untrackedDelivery(delivery)
  }
  run = advance(run.id, { step: 'snapshot', status: 'running' })
  run = advance(run.id, { step: 'delivery', status: 'running' })
  try {
    await delivery.deliver(run)
    return advance(run.id, { step: 'done', status: 'done' })
  } catch (error) {
    return advance(run.id, { step: run.step, status: 'failed', error: messageOf(error) })
  }
}

/**
 * Resolves every run a crash left at `status: running` (a killed process leaves exactly one such row,
 * never zero and never a growing set, since `startPublishRun` updates one row in place) — run at plugin
 * init, before the boot run is enqueued.
 *
 * Resume policy (ADR-0025): SUPERSEDE, not redeliver. `zz.publish.ts`'s boot sequence always enqueues an
 * unconditional full publish right after this call — a crashed run's work is redone regardless, so
 * redelivering it here would only duplicate that upcoming render for no benefit. Each stuck row is instead
 * marked `status: failed` with a distinct recorded reason, directly, with no delivery invocation:
 *  - it keeps this call a plain, fast DB update that cannot itself crash the process again (a redelivery
 *    that crashed the same way it crashed originally would leave the row `running` forever and the boot
 *    run's `finally` would never fire — an infinite boot loop that never makes progress);
 *  - it removes the only other caller besides the queue that ever invoked delivery directly, so the
 *    queue's single-flight guard is never bypassed by anything running concurrently with it.
 * A row marked `failed` here is terminal, so the next `resumePublishRuns` (the next boot) leaves it alone.
 * @public
 */
export async function resumePublishRuns(): Promise<void> {
  for (const run of stuckRuns()) {
    advance(run.id, { step: run.step, status: 'failed', error: 'process died mid-run; superseded by the boot publish' })
  }
}
