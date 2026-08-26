import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type Database from 'better-sqlite3'
import { Schema } from 'effect'
import { PublishedSnapshot } from '@michaelthielemann/kestrel-contracts'
import { rawSqliteClientOf, type ModuleDbService, type ModuleDbBrand } from '@michaelthielemann/kestrel-core'

/**
 * The publishing module's per-route publish history: one row per published state of a route. UPDATE-proof
 * on `route`/`payload`/`fingerprint`/`publishedAt` (enforced by DB triggers — see {@link TRIGGER_DDL}), and
 * `supersededBy` may only move NULL → a real id, exactly once. This does NOT make the table immutable in
 * general: DELETE and `INSERT OR REPLACE` (which is a DELETE + INSERT under the hood — `BEFORE UPDATE OF`
 * never fires for it) are both left open on purpose, the same way `publish_runs` leaves DELETE open for its
 * own retention pruning — a future retention pass over old, already-superseded snapshots is expected to use
 * it. `payload` holds the content fields `PublishedSnapshot` does not already get from this table's
 * own columns (`route`, `fingerprint`, `publishedAt`) — as JSON text.
 *
 * The triggers/partial-unique-index reach the table two ways, which must stay in step (see {@link TRIGGER_DDL}'s
 * own comment): `0017_published_snapshots.sql`, for a boot inside Kestrel's own repo (`00.migrate`'s
 * committed-migrations path), and {@link ensureSnapshotTriggers}, for a consumer layer whose
 * `published_snapshots` table only ever gets created by the schema engine (`#kestrel/schema-tables` +
 * `02.schema-sync`/`db:migrate`), which has no trigger concept and never reaches that migration file at
 * all. The partial unique index IS expressible through the schema engine (`IndexShape.where` is already
 * diffed/rendered) and is declared on the table itself below, so both provisioning paths get it identically
 * with no separate enforcement needed.
 * @public
 */
export const publishedSnapshots = sqliteTable('published_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  route: text('route').notNull(),
  payload: text('payload').notNull(),
  fingerprint: text('fingerprint').notNull(),
  // `timestamp_ms`, not `timestamp` (UNIX seconds): a route republished within the same second as its
  // last publish still needs a distinct `publishedAt` — `republishSnapshot`'s own contract pins this.
  publishedAt: integer('published_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  supersededBy: integer('superseded_by'),
  // Retraction (unpublish): set-once from NULL, like `supersededBy` — see TRIGGER_DDL. Does NOT set
  // `supersededBy` (the supersede chain is untouched, history stays immutable); it only hides the row
  // from the delivery-facing "current" read (`currentSnapshot`/`currentRoutes`, both narrowed to
  // `retractedAt IS NULL`). The chain-head lookup `currentRowFor` used internally for supersede/rollback
  // ignores it on purpose — a retracted route republished later resumes the SAME chain.
  retractedAt: integer('retracted_at', { mode: 'timestamp_ms' }),
}, (t) => [
  // `currentSnapshot`/`currentRoutes`'s own query shape: route lookups, filtered to the non-superseded,
  // non-retracted row.
  index('published_snapshots_route').on(t.route, t.supersededBy, t.retractedAt),
  // The current-pointer invariant at the DB level: at most one non-superseded row per route. Deliberately
  // NOT narrowed to `retractedAt IS NULL` — a retracted row is still the chain head until superseded.
  uniqueIndex('published_snapshots_route_current_unique').on(t.route).where(sql`superseded_by IS NULL`),
])

/**
 * The insert-only/supersede-once triggers, as plain DDL strings — the single source of truth both
 * provisioning paths execute. `0017_published_snapshots.sql` carries the SAME statements (identifier
 * quoting aside) for a committed-migration boot; keep the two in step by hand when either changes — the
 * schema-render engine cannot generate triggers, so there is no way to derive one from the other.
 *
 * Each protected column gets its own `BEFORE UPDATE OF <col>` trigger, which fires only when an UPDATE
 * statement names that column in its SET list — a statement that never touches the column (including a
 * `DELETE` or an `INSERT OR REPLACE`, which SQLite implements as DELETE + INSERT, never an UPDATE) does
 * not trip it. `supersededBy` additionally rejects a second UPDATE (already non-NULL) and a self-pointer
 * (`NEW.superseded_by = NEW.id`) — cheap to add to the same WHEN clause, and a row can never legitimately
 * supersede itself.
 * @public
 */
export const TRIGGER_DDL: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS published_snapshots_no_update_route
   BEFORE UPDATE OF route ON published_snapshots
   BEGIN
     SELECT RAISE(ABORT, 'published_snapshots.route cannot be UPDATEd (DELETE/INSERT OR REPLACE are unaffected)');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS published_snapshots_no_update_payload
   BEFORE UPDATE OF payload ON published_snapshots
   BEGIN
     SELECT RAISE(ABORT, 'published_snapshots.payload cannot be UPDATEd (DELETE/INSERT OR REPLACE are unaffected)');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS published_snapshots_no_update_fingerprint
   BEFORE UPDATE OF fingerprint ON published_snapshots
   BEGIN
     SELECT RAISE(ABORT, 'published_snapshots.fingerprint cannot be UPDATEd (DELETE/INSERT OR REPLACE are unaffected)');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS published_snapshots_no_update_published_at
   BEFORE UPDATE OF published_at ON published_snapshots
   BEGIN
     SELECT RAISE(ABORT, 'published_snapshots.published_at cannot be UPDATEd (DELETE/INSERT OR REPLACE are unaffected)');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS published_snapshots_supersede_once
   BEFORE UPDATE OF superseded_by ON published_snapshots
   WHEN OLD.superseded_by IS NOT NULL OR NEW.superseded_by = NEW.id
   BEGIN
     SELECT RAISE(ABORT, 'published_snapshots.superseded_by can only be set once, from NULL, and never to its own id');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS published_snapshots_retract_once
   BEFORE UPDATE OF retracted_at ON published_snapshots
   WHEN OLD.retracted_at IS NOT NULL
   BEGIN
     SELECT RAISE(ABORT, 'published_snapshots.retracted_at can only be set once, from NULL');
   END;`,
]

/** Idempotent (`CREATE TRIGGER IF NOT EXISTS`): safe to call on every boot. Provisions {@link TRIGGER_DDL}
 *  for a consumer layer whose `published_snapshots` table came from the schema engine, not the committed
 *  0017 migration (see the table's own TSDoc) — called from the publishing plugin, after schema-sync/
 *  migrate has had a chance to create the table. Tolerates the table not existing yet (a boot before either
 *  provisioning path has run): warns like the schema-drift check does, rather than crashing boot. Any
 *  OTHER failure (a genuine syntax error, a locked db) is not swallowed.
 * @public
 */
export function ensureSnapshotTriggers(sqlite: Database.Database): void {
  try {
    for (const stmt of TRIGGER_DDL) sqlite.exec(stmt)
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) {
      console.warn('[kestrel] could not ensure published_snapshots triggers (is it migrated/provisioned? run `db:migrate`):', error.message)
      return
    }
    throw error
  }
}

/** `ModuleDbService['db']` (not `BetterSQLite3Database` directly) — its `transaction` callback types the
 *  `tx` parameter as the checked `ModuleTxHandle`. `Pick<T, K>` drops every key outside `K`, including the
 *  brand — re-intersected explicitly (mirrors `record-ref-index.ts`'s own `DB`/`WriteDB`/`RebuildDB`), so
 *  a raw `BetterSQLite3Database`/drizzle instance still fails to structurally satisfy this narrowed type;
 *  only a real, ownership-checked `PublishingDb` does. This module's own unit tests deliberately exercise
 *  the pure logic against a raw migrated drizzle instance (unchecked, on purpose — this file's suite is
 *  not the ownership suite; see `test/architecture/ownership.publishing.test.ts` for that), so they cast
 *  it at the crossing (`as unknown as SnapshotsDb`), mirroring `record-ref-index.test.ts`'s own
 *  `asContentDb` helper.
 * @public
 */
export type SnapshotsDb = Pick<ModuleDbService['db'], 'select' | 'insert' | 'update' | 'transaction'> & { readonly [ModuleDbBrand]: true }

/** One row of {@link publishedSnapshots}, as read back through this module's own query helpers.
 * @public
 */
export interface SnapshotRow {
  id: number
  route: string
  payload: string
  fingerprint: string
  publishedAt: Date
  supersededBy: number | null
  retractedAt: Date | null
}

/** The content fields `PublishedSnapshot` does not already get from its own table column
 *  (`route`/`fingerprint`/`publishedAt`) — what a publish actually computes per route and hands to
 *  {@link recordSnapshot}. `locale` is optional: a non-translatable route has none. */
const decodeSnapshotPayload = Schema.decodeUnknownSync(Schema.Struct({
  html: Schema.String,
  media: Schema.Array(Schema.String),
  locale: Schema.optional(Schema.NullOr(Schema.String)),
}))

/** The input shape {@link recordSnapshot} accepts for a route's content.
 * @public
 */
export interface SnapshotPayload {
  html: string
  media: readonly string[]
  locale?: string | null
}

function currentRowFor(db: SnapshotsDb, route: string): SnapshotRow | undefined {
  return db.select().from(publishedSnapshots)
    .where(and(eq(publishedSnapshots.route, route), isNull(publishedSnapshots.supersededBy)))
    .get() as SnapshotRow | undefined
}

/** The row id the NEXT insert into `published_snapshots` will get. Needed because the current-pointer
 *  invariant is an immediate (non-deferrable — SQLite has no deferred UNIQUE) partial unique index: the
 *  old current row must already point at the new one's id by the time the new row is inserted, or the two
 *  rows briefly coexist with `superseded_by IS NULL` and the index rejects the insert. Reading
 *  `sqlite_sequence` (the same escape hatch `render-sqlite.ts`'s rebuild uses to preserve AUTOINCREMENT
 *  high-water marks) predicts it; called from inside the same transaction the demote+insert run in below,
 *  on the SAME underlying connection (`rawSqliteClientOf`/`$client` — a `ModuleTxHandle` does not expose
 *  it, so this always goes through the OUTER `db`, never `tx`), so it sees that transaction's own
 *  in-progress state and rolls back together with it on failure — not a separate, racing read. */
function nextRowId(db: SnapshotsDb): number {
  const client = (rawSqliteClientOf(db) ?? (db as unknown as { $client: Database.Database }).$client)
  const row = client.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'published_snapshots'").get() as { seq: number } | undefined
  return (row?.seq ?? 0) + 1
}

/** Demote `current` (if any) to the predicted next id, then insert `values` — as ONE transaction. Without
 *  this, an insert that fails AFTER the demote (disk full, SQLITE_BUSY, a killed process) leaves the route
 *  with no current row at all, the demoted row pointing at an id some OTHER route's next publish will claim
 *  next, and the supersede-once trigger makes that permanent — silent corruption the per-route `catch` in
 *  `publisher.ts` would otherwise swallow. Either both writes land or neither does.
 *
 *  `publishedAt` is computed here, never left to the column's `$defaultFn`: two rows in the same supersede
 *  chain landing in the same millisecond is a REAL possibility (`Date.now()` has millisecond resolution, a
 *  demote+insert pair is microseconds apart), not a rare edge case to shrug off with a `>=` assertion
 *  elsewhere — the history must stay strictly time-orderable (a future consumer sorts publish history on
 *  it). `max(now, current.publishedAt + 1)` guarantees strict monotonicity across a chain even when the
 *  clock doesn't visibly advance between two writes, without ever moving a timestamp backwards relative to
 *  the wall clock. */
function supersedeAndInsert(
  db: SnapshotsDb,
  current: SnapshotRow | undefined,
  values: { route: string; payload: string; fingerprint: string },
): SnapshotRow {
  return db.transaction((tx) => {
    const predicted = current ? nextRowId(db) : undefined
    if (current && predicted !== undefined) {
      tx.update(publishedSnapshots).set({ supersededBy: predicted }).where(eq(publishedSnapshots.id, current.id)).run()
    }
    const publishedAt = new Date(current ? Math.max(Date.now(), current.publishedAt.getTime() + 1) : Date.now())
    const inserted = tx.insert(publishedSnapshots).values({ ...values, publishedAt }).returning().get() as SnapshotRow | undefined
    if (!inserted) throw new Error('published_snapshots insert returned no row')
    // Loud failure instead of a silently wrong pointer — aborts (and rolls back) this same transaction.
    if (predicted !== undefined && inserted.id !== predicted) {
      throw new Error(`published_snapshots: predicted next insert id ${predicted}, got ${inserted.id}`)
    }
    return inserted
  })
}

/** Insert one snapshot for `route`, deduplicating on `fingerprint`: an unchanged fingerprint against the
 *  route's current row is a no-op (the existing row comes back, nothing is written); a changed fingerprint
 *  inserts a new current row and flips the previous current row's `supersededBy` to it, transactionally
 *  (see `supersedeAndInsert`, this module's own internal implementation) — never mutates the old row's own content columns (the triggers enforce
 *  this even against a bug here). Validates `payload` against the store's content schema before it is ever
 *  written.
 * @public
 */
export function recordSnapshot(db: SnapshotsDb, input: { route: string; payload: SnapshotPayload; fingerprint: string }): SnapshotRow {
  const validated = decodeSnapshotPayload(input.payload)
  const current = currentRowFor(db, input.route)
  if (current && current.fingerprint === input.fingerprint) return current

  return supersedeAndInsert(db, current, { route: input.route, payload: JSON.stringify(validated), fingerprint: input.fingerprint })
}

/** Rollback by pointer: read the (current or already-superseded) row at `fromId` and publish its content
 *  again as a brand-new current row — a fresh id and `publishedAt`, content-equal to the source. A no-op
 *  (mirroring `recordSnapshot`'s fingerprint dedupe) when `fromId` already IS the route's current row —
 *  nothing to roll back to a copy of itself. Otherwise transactional (see `supersedeAndInsert`, this
 *  module's own internal implementation). The
 *  source row is only ever READ here; if it happened to be the route's current row (the no-op case above
 *  aside), superseding it is the ordinary pointer flip owed to whichever row was current at the time, not a
 *  mutation of the source row itself.
 * @public
 */
export function republishSnapshot(db: SnapshotsDb, input: { fromId: number }): SnapshotRow {
  const source = db.select().from(publishedSnapshots).where(eq(publishedSnapshots.id, input.fromId)).get() as SnapshotRow | undefined
  if (!source) throw new Error(`published_snapshots: no row with id=${input.fromId}`)

  const current = currentRowFor(db, source.route)
  if (current && current.id === source.id) return current

  return supersedeAndInsert(db, current, { route: source.route, payload: source.payload, fingerprint: source.fingerprint })
}

function toPublishedSnapshot(row: SnapshotRow): PublishedSnapshot {
  const content = JSON.parse(row.payload) as { html: string; media: string[]; locale?: string | null }
  return Schema.decodeUnknownSync(PublishedSnapshot)({
    route: row.route,
    locale: content.locale ?? null,
    html: content.html,
    media: content.media,
    fingerprint: row.fingerprint,
    publishedAt: row.publishedAt.getTime(),
  })
}

/**
 * The DeliveryPort read surface (ADR-0013 §3.3): `published_snapshots` is read ONLY through these two
 * functions, so every delivery adapter (`delivery-static`, `delivery-live`) sees the same current-state
 * contract instead of querying the table shape directly. Enforced two ways, neither of them a true
 * repo-wide scan: `test/architecture/published-snapshots.test.ts` §F scans everywhere EXCEPT this
 * module's own code (`packages/kestrel-publishing/src/**` — this file included — and the remaining
 * `layers/public/server/**` wiring are both the carved-out publishing module, where a direct reference is
 * expected), every other `test/architecture/**` suite (a wholesale, documented carve-out — those suites
 * legitimately build their own raw-SQL fixtures), and one named exempt file (`server/database/schema.ts`,
 * drizzle-kit's schema-discovery barrel); inside `delivery-live/`, it's
 * `test/architecture/delivery-live-module.test.ts`'s B3 that pins the same rule by scanning that module's
 * own files for a raw reference instead of an import from here. Both are narrowed to `retractedAt IS NULL`
 * — a retracted route (unpublish) is invisible here even though its row is still the chain head
 * (see `retractSnapshot`). `currentSnapshot`'s route lookup is exact-match only, with no trailing-slash
 * normalization — that normalization, where it applies, happens at the HTTP-serving layer, not here.
 * @public
 */
export function currentSnapshot(db: SnapshotsDb, route: string): PublishedSnapshot | null {
  const row = db.select().from(publishedSnapshots)
    .where(and(eq(publishedSnapshots.route, route), isNull(publishedSnapshots.supersededBy), isNull(publishedSnapshots.retractedAt)))
    .get() as SnapshotRow | undefined
  return row ? toPublishedSnapshot(row) : null
}

/** Every route with a current, non-retracted snapshot — the delivery adapter's full route set for a cold
 *  rebuild.
 * @public
 */
export function currentRoutes(db: SnapshotsDb): string[] {
  return db.select({ route: publishedSnapshots.route }).from(publishedSnapshots)
    .where(and(isNull(publishedSnapshots.supersededBy), isNull(publishedSnapshots.retractedAt))).all()
    .map((r) => (r as { route: string }).route)
}

/** Retract (unpublish) a route's current snapshot: marks the chain-head row `retractedAt`, so
 *  `currentSnapshot`/`currentRoutes` stop surfacing it — history stays immutable (`supersededBy` untouched).
 *  A no-op (returns the existing row) when the route has no chain head, or its head is already retracted;
 *  a later `recordSnapshot`/`republishSnapshot` for the same route resumes the SAME chain, superseding the
 *  retracted row exactly like any other content change.
 * @public
 */
export function retractSnapshot(db: SnapshotsDb, route: string): SnapshotRow | null {
  const head = currentRowFor(db, route)
  if (!head) return null
  if (head.retractedAt) return head
  const retractedAt = new Date()
  db.update(publishedSnapshots).set({ retractedAt }).where(eq(publishedSnapshots.id, head.id)).run()
  return { ...head, retractedAt }
}
