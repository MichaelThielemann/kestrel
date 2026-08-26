/**
 * Append-only revisions: one `<collection>_revisions` table per registered collection, holding a
 * full snapshot of the persisted row after every create/update. The current row (the collection's own
 * table) stays the read model — untouched, no new columns — and is materialized eagerly on every write;
 * revisions exist purely as an append-only history alongside it, written in the SAME transaction as the
 * record write (see `persist.ts`'s `appendRevision`).
 *
 * `snapshot` is the FULL persisted row (id, timestamps included), JSON-encoded — not a subset of the
 * pre-persist validated input. Rebuild-equal ("restore the current row from the last revision") is only a
 * meaningful claim against what was actually stored; the write's `ValidatedInput` names a trust level, not
 * a field subset for this column. One caveat, same shape as the outbox envelope's own: for `updateMany`
 * (the one batch UPDATE with no `RETURNING`), `snapshot` is the client-side synthesis `persist.ts` already
 * builds for its outbox payload (`{...before, ...patchValues}`), not a re-read of the stored row — accurate
 * only as long as every written column is one `patchValues` already carries; a DB-side computed column
 * would silently diverge. Every other write shape snapshots the real, re-read row.
 *
 * DELETE appends a TOMBSTONE revision: a marker row with no row left to snapshot. `tombstone` is an
 * additive `INTEGER NOT NULL DEFAULT 0` column (existing tables upgrade through the ordinary add_column
 * path, not a rebuild); the `snapshot` column itself stays `NOT NULL` at the DB level, so a tombstone
 * writes the JSON literal `"null"` there (`JSON.stringify(null)`) rather than a SQL NULL — decoded back to
 * `null` on read. See `layers/core/server/pipeline/steps/persist.ts` for where deletes append one and
 * `rollback.ts`/`defaults.ts` for the pipeline that reverses one.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto'
import { getTableColumns } from 'drizzle-orm'
import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Quarantined } from '@michaelthielemann/kestrel-contracts'
import type { BuiltCollection, CollectionDef } from '@michaelthielemann/kestrel-core'
import { allCollections } from '../utils/registry.js'
import { revisionRetentionPolicy } from '../utils/revision-retention.js'
import { sqliteClientOf } from './outbox.js'

/** @public */
export type Row = Record<string, unknown>

/** One revision row, `snapshot` already JSON-decoded. `snapshot` is `null` exactly when `tombstone` is
 * @public
 *  `true` — a delete marker has no row to snapshot. */
export interface RevisionRow {
  recordId: number
  revision: number
  snapshot: Row | null
  schemaVersion: number
  correlationId: string
  createdAt: string
  tombstone: boolean
}

interface RawRevisionRow {
  record_id: number
  revision: number
  snapshot: string
  schema_version: number
  correlation_id: string
  created_at: string
  tombstone: number
}

/** `<collection>_revisions` — one revisions table per collection, joining that collection's own content
 * @public
 *  ownership manifest (see `content-manifest.ts`). */
export function revisionsTableName(collection: string): string {
  return `${collection}_revisions`
}

/** The drizzle table shape for `<collection>_revisions`, built at runtime — collections are dynamic
 *  (registered by consumer code at boot, not known statically), so this mirrors `buildTable`'s own
 *  approach of compiling a table object per collection rather than declaring one statically. Consumed by
 *  the schema layer (`desiredFromCollections`), which provisions it exactly like a content table — the
 *  static 4-place migration parity does not apply to a dynamic table; the desired-schema mechanism IS its
 * @public
 *  parity (schema-sync in dev, `db:migrate` in prod, both driven off this same definition). */
export function revisionsTable(collection: string): AnySQLiteTable {
  const name = revisionsTableName(collection)
  return sqliteTable(name, {
    recordId: integer('record_id').notNull(),
    revision: integer('revision').notNull(),
    snapshot: text('snapshot').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    correlationId: text('correlation_id').notNull(),
    createdAt: text('created_at').notNull(),
    // Additive to the base shape — existing installs upgrade through add_column, never a rebuild. Stays
    // `INTEGER NOT NULL DEFAULT 0` rather than a boolean column type (SQLite has none); `snapshot` keeps
    // its own NOT NULL — a tombstone writes the JSON literal "null" there instead of a SQL NULL.
    tombstone: integer('tombstone').notNull().default(0),
  }, (t) => [
    // `nextRevisionNumber` and `readRevisions` both scan by `record_id`, ordered by `revision` — must stay
    // an index scan on an append-only table that only grows. UNIQUE so the DB itself enforces the
    // append-only invariant: two writers computing the same `MAX(revision) + 1` can never both insert it.
    uniqueIndex(`${name}_record`).on(t.recordId, t.revision),
  ]) as AnySQLiteTable
}

/** Idempotent DDL (`CREATE TABLE IF NOT EXISTS`) — the test/tooling-facing helper. Production provisioning
 *  goes through the schema layer (`desiredFromCollections` + schema-sync/`db:migrate`), never lazily on the
 *  write path: a lazy `ensure` on first write would defeat the atomicity tests (a table created mid-write
 *  is never the thing whose absence a rollback test wants to observe) and hide a missing migration instead
 * @public
 *  of surfacing it at boot. */
export function ensureRevisionsTable(sqlite: Database.Database, collection: string): void {
  const name = revisionsTableName(collection)
  sqlite.exec(`CREATE TABLE IF NOT EXISTS ${name} (
    record_id INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    tombstone INTEGER NOT NULL DEFAULT 0
  )`)
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${name}_record ON ${name} (record_id, revision)`)
  // Additive upgrade for a table created before the tombstone column existed — mirrors the desired-schema
  // engine's own add_column path, but this helper is also called directly by tests/tooling against a table
  // that may already exist without it.
  const hasTombstone = (sqlite.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[])
    .some((col) => col.name === 'tombstone')
  if (!hasTombstone) sqlite.exec(`ALTER TABLE ${name} ADD COLUMN tombstone INTEGER NOT NULL DEFAULT 0`)
}

interface CachedRevisionStatements {
  nextRevision: Database.Statement
  insert: Database.Statement
}

// Same rationale as `outbox.ts`'s `statementCache`: one writing call site (`persist.ts`) prepares these on
// every unit of every write, so cache per `(connection, table)` instead of re-preparing on each call.
const statementCache = new WeakMap<Database.Database, Map<string, CachedRevisionStatements>>()

function statementsFor(sqlite: Database.Database, collection: string): CachedRevisionStatements {
  let byCollection = statementCache.get(sqlite)
  if (!byCollection) {
    byCollection = new Map()
    statementCache.set(sqlite, byCollection)
  }
  let cached = byCollection.get(collection)
  if (!cached) {
    const name = revisionsTableName(collection)
    cached = {
      nextRevision: sqlite.prepare(`SELECT MAX(revision) as maxRev FROM ${name} WHERE record_id = ?`),
      insert: sqlite.prepare(
        `INSERT INTO ${name} (record_id, revision, snapshot, schema_version, correlation_id, created_at, tombstone) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
    }
    byCollection.set(collection, cached)
  }
  return cached
}

/** The next revision number for `recordId` — `MAX(revision) + 1` read and written inside the same
 *  synchronous transaction as the record write, race-free under the same single-writer property
 * @public
 *  `nextSequence` (outbox.ts) relies on. */
export function nextRevisionNumber(sqlite: Database.Database, collection: string, recordId: number): number {
  const row = statementsFor(sqlite, collection).nextRevision.get(recordId) as { maxRev: number | null }
  return (row.maxRev ?? 0) + 1
}

/** Inserts one revision row. Must run inside the same `better-sqlite3` transaction as the record write it
 * @public
 *  snapshots — this function itself does not open one. */
export function insertRevisionRow(sqlite: Database.Database, collection: string, input: {
  recordId: number
  revision: number
  snapshot: Row | null
  schemaVersion: number
  correlationId: string
  createdAt: string
  /** A delete marker: `snapshot` must be `null` when this is `true`. Defaults to `false`. */
  tombstone?: boolean
}): void {
  statementsFor(sqlite, collection).insert.run(
    input.recordId,
    input.revision,
    JSON.stringify(input.snapshot),
    input.schemaVersion,
    input.correlationId,
    input.createdAt,
    input.tombstone ? 1 : 0,
  )
}

/** `created_at`/`updated_at` round-trip through `JSON.stringify` as ISO strings — reviving them back into
 *  `Date` instances is what makes a decoded snapshot deep-equal the original persisted row (which drizzle
 *  hands back as `Date` for a `timestamp_ms` column), not just structurally similar to it. */
function reviveTimestamps(row: Row): Row {
  const revived: Row = { ...row }
  if (typeof revived.createdAt === 'string') revived.createdAt = new Date(revived.createdAt)
  if (typeof revived.updatedAt === 'string') revived.updatedAt = new Date(revived.updatedAt)
  return revived
}

function decodeRevisionRow(row: RawRevisionRow): RevisionRow {
  const decoded = JSON.parse(row.snapshot) as Row | null
  return {
    recordId: row.record_id,
    revision: row.revision,
    snapshot: decoded === null ? null : reviveTimestamps(decoded),
    schemaVersion: row.schema_version,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    tombstone: row.tombstone !== 0,
  }
}

/** Every revision recorded for `recordId`, ordered by `revision` ascending (oldest first).
 * @public
 */
export function readRevisions(db: BetterSQLite3Database, collection: string, recordId: number): RevisionRow[] {
  const rows = sqliteClientOf(db)
    .prepare(`SELECT * FROM ${revisionsTableName(collection)} WHERE record_id = ? ORDER BY revision ASC`)
    .all(recordId) as RawRevisionRow[]
  return rows.map(decodeRevisionRow)
}

/** Restores (or returns, if already present) the current row from the last revision's snapshot — an
 *  upsert keyed by `id` so this is safe whether or not a row currently exists. Not itself transactional
 *  with anything else: a caller needing that composes its own `db.transaction`. Returns `null`, a no-op,
 *  when the last revision is a tombstone — a genuinely deleted record must not be resurrected by a rebuild;
 *  use the `rollback` pipeline for a sanctioned undo-delete, which appends a fresh revision instead of
 *  silently rewinding one.
 *
 *  Applies {@link applyRevisionUpcast} STRICTLY, same as `rollback` (`rollback.ts`) — a rebuild is a
 *  recovery tool, and recovery must never resurrect a stale-shaped row raw. A snapshot whose `schemaVersion`
 *  has no walkable chain to the collection's current def-hash version throws the tagged `Quarantined`
 * @public
 *  rather than writing it. */
export function rebuildFromRevisions(db: BetterSQLite3Database, collection: BuiltCollection, recordId: number): Row | null {
  const revisions = readRevisions(db, collection.def.name, recordId)
  const last = revisions[revisions.length - 1]
  if (!last) throw new Error(`[kestrel] rebuildFromRevisions: no revisions for "${collection.def.name}#${recordId}"`)
  if (last.tombstone) return null
  // readRevisions already revived created_at/updated_at into Date instances (see decodeRevisionRow).
  const outcome = applyRevisionUpcast(collection.def, last)
  if (!outcome.resolved) throw new Quarantined({ id: recordId })
  const values = outcome.snapshot
  const table = collection.table as AnySQLiteTable
  const cols = getTableColumns(table) as Record<string, AnySQLiteColumn>
  return db.insert(table).values(values).onConflictDoUpdate({ target: cols.id!, set: values }).returning().get() as Row
}

// -------------------------------------------------------------------------------------------------------
// Schema versioning: `schema_version` is a deterministic hash of the collection def's structural shape.
// -------------------------------------------------------------------------------------------------------

/** Drops functions and `undefined`, sorts object keys — the canonical, order-independent form
 *  {@link schemaVersionOf} hashes. Arrays keep their order (a field's position can be structurally
 *  meaningful, e.g. `formats`/`variants`); only object KEYS are order-independent. */
function canonicalize(value: unknown): unknown {
  if (typeof value === 'function' || value === undefined) return undefined
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = canonicalize((value as Record<string, unknown>)[key])
    if (v !== undefined) out[key] = v
  }
  return out
}

/**
 * A deterministic, def-content-derived `schema_version`: the first 32 bits of the SHA-256 digest of the
 * def's canonicalized field shape (names, types, options — everything but functions, which cannot be
 * serialized and don't affect the stored/decoded row shape a revision snapshot has to match). Same def ⇒
 * same version, in this process or any other (pure function of content, never of registration order or
 * wall-clock time); a structurally different def ⇒ a different version.
 *
 * Stored as a plain `number` in the existing `schema_version INTEGER` column — chosen over a string hash
 * specifically because `registerUpcast`'s `fromVersion` (`@michaelthielemann/kestrel-contracts`) is `number`-typed;
 * keying upcast chains on this value needs no contracts-package change and no separate
 * hash-to-sequence-number registry.
 */
// Cached per `def` OBJECT (not per collection name): a def is immutable once registered, and every write
// against one collection reuses the SAME def instance (`registerCollection` stores it as-is) — hashing on
// every write, on the request path, is the cost this cache avoids. A genuinely different def object
// (re-registration under the same name, as every test that simulates a schema change does) is a cache miss
// by construction, so this never masks a real def change.
const schemaVersionCache = new WeakMap<CollectionDef, number>()

/** @public */
export function schemaVersionOf(def: CollectionDef): number {
  const cached = schemaVersionCache.get(def)
  if (cached !== undefined) return cached
  const shape = canonicalize({
    mode: def.mode,
    translatable: def.translatable,
    status: def.status,
    blocks: def.blocks,
    fields: def.fields,
  })
  const digest = createHash('sha256').update(JSON.stringify(shape)).digest('hex')
  const version = parseInt(digest.slice(0, 8), 16)
  schemaVersionCache.set(def, version)
  return version
}

// -------------------------------------------------------------------------------------------------------
// Revision upcasting: a DEDICATED registry, local to this module — NOT `@michaelthielemann/kestrel-contracts`'
// `registerUpcast`/`upcastToLatest` (retired for this purpose; see the TSDoc on `registerRevisionUpcast`
// for why that reuse doesn't work for a hash-versioned chain).
// -------------------------------------------------------------------------------------------------------

interface RevisionUpcastStep {
  toVersion: number
  fn: (payload: unknown) => unknown
}

const revisionUpcastRegistry = new Map<string, Map<number, RevisionUpcastStep>>()

/**
 * Registers one step of a collection's revision-upcast chain: a snapshot recorded at `fromVersion` (an
 * old `schemaVersion`) is transformed by `fn` into one that's valid at `toVersion`. Multiple steps for the
 * same collection compose into a chain by matching `toVersion` of one step to `fromVersion` of the next —
 * see {@link applyRevisionUpcast} for the walk.
 *
 * Distinct from `@michaelthielemann/kestrel-contracts`' `registerUpcast`/`upcastToLatest`, and NOT built on it,
 * despite the earlier design intending exactly that reuse. The contracts
 * walker assumes AUTHOR-ASSIGNED, sequential versions — it stops at
 * `Math.max(...registeredFromVersions) + 1`, i.e. "the next integer past the highest registered step". A
 * `schema_version` derived from a def hash
 * is an UNORDERED 32-bit value: two real drifts can hash in either order relative to each other, so a
 * sequential "+1" walker can stop after one hop of a two-hop chain, or never even recognize the chain's
 * end, with no way to tell "fully bridged" from "gave up partway" other than by chance (a coincidence with
 * probability ~2^-32). This registry instead walks by EXPLICIT `toVersion` edges: it terminates only when
 * the walk's position lands exactly on `schemaVersionOf(currentDef)`, which is the actual claim
 * `resolved: true` needs to make.
 *
 * Throws if a step for the same `(collection, fromVersion)` pair is already registered — mirrors
 * `registerUpcast`'s own duplicate guard.
 * @public
 */
export function registerRevisionUpcast(collection: string, fromVersion: number, step: RevisionUpcastStep): void {
  let chain = revisionUpcastRegistry.get(collection)
  if (chain === undefined) {
    chain = new Map()
    revisionUpcastRegistry.set(collection, chain)
  }
  if (chain.has(fromVersion)) {
    throw new Error(`[kestrel] revision upcast for "${collection}" already registered from schema_version ${fromVersion}`)
  }
  chain.set(fromVersion, step)
}

/** Test-only reset — mirrors `clearRegistry`/`clearPipelines`/`clearUpcasts`.
 * @public
 */
export function clearRevisionUpcasts(): void {
  revisionUpcastRegistry.clear()
}

/** {@link applyRevisionUpcast}'s result: `resolved` is `false` exactly when a `schemaVersion` mismatch
 *  existed and the registered chain (if any) did not land exactly on the current version — `snapshot` is
 *  still the (unmodified) raw one in that case, since the caller decides what an unresolved mismatch means
 * @public
 *  for its own recovery path (see below). */
export interface RevisionUpcastOutcome {
  snapshot: Row
  resolved: boolean
}

/**
 * Bridges a revision snapshot recorded under an older `schemaVersion` up to `def`'s CURRENT def-hash
 * version, walking {@link registerRevisionUpcast}'s per-collection chain by explicit `toVersion` edges
 * (never by incrementing the version number — a def-hash carries no ordering).
 *
 * `target.schemaVersion` already equal to `def`'s current version is the common case — no version drift,
 * `resolved: true`, snapshot unchanged, no registry lookup at all. Otherwise the walk starts at
 * `target.schemaVersion` and repeatedly follows the registered step for the current position, applying its
 * `fn` and moving to its `toVersion`, until either:
 * - the position equals `schemaVersionOf(def)` (the chain fully bridged the gap) — `resolved: true`, the
 *   accumulated payload as `snapshot`;
 * - no step is registered for the current position (a dead end — nothing left to try), or the walk has
 *   taken more hops than the collection has registered steps (a CYCLE guard: a chain can revisit an
 *   already-hashed intermediate version at most zero extra times before this trips) — `resolved: false`,
 *   the ORIGINAL raw `snapshot` (any partial transformation is discarded, never a half-upcast value).
 *
 * `resolved: false` is NEVER a silent identity claim and NEVER a crash — a registered step whose `fn`
 * itself throws is caught and treated as an unresolved chain, same as a dead end or a cycle; the original
 * raw snapshot is returned. What `resolved: false` means beyond that is the caller's call, since the two
 * callers need different strictness:
 * - `rebuildFromRevisions` has no structural check of its own downstream (a bare `INSERT`), so it treats
 *   `resolved: false` as an immediate `Quarantined` — a recovery tool must never write a stale shape.
 * - `rollback` (`pipeline/steps/rollback.ts`) still runs the restored snapshot through `decodeInput`
 *   right after this call — a mismatch whose raw (unbridged) snapshot happens to decode fine anyway is let
 *   through unescalated; only a `ValidationFailed` from THAT decode, combined with `resolved: false`,
 *   becomes the caller's signal to report `Quarantined` instead of the raw validation error. NOTE: "decodes
 *   fine" is a column-shape check only (see `rollback.ts`'s TSDoc) — a def change that alters MEANING
 *   without altering column shape (e.g. a field's semantics change but its type doesn't) restores stale
 *   semantics unescalated. `rollback.ts` warns when this path is taken, so it stays observable even though
 *   it isn't rejected.
 *
 * **Collision caveat.** `schemaVersionOf` is a 32-bit hash: two genuinely different defs collide with
 * probability ~2^-32 per pair. A collision makes `target.schemaVersion === current` true when the defs
 * actually differ — the EARLY-RETURN path above, which runs before any registry lookup, so a colliding
 * drift is invisible to this function entirely. For `rollback` that's not the last word: `decodeInput`
 * still runs right after and is a real (if column-shape-only) backstop. `rebuildFromRevisions` has no such
 * backstop — a colliding drift there writes the raw snapshot with no check at all. This is the accepted
 * residual risk of a 32-bit hash, not a bug; documented here and in ADR-0026.
 * @public
 */
export function applyRevisionUpcast(def: CollectionDef, target: RevisionRow): RevisionUpcastOutcome {
  const snapshot = target.snapshot!
  const current = schemaVersionOf(def)
  if (target.schemaVersion === current) return { snapshot, resolved: true }

  const chain = revisionUpcastRegistry.get(def.name)
  if (chain === undefined) return { snapshot, resolved: false }

  let position = target.schemaVersion
  let payload: unknown = snapshot
  const maxHops = chain.size
  for (let hops = 0; hops < maxHops && position !== current; hops++) {
    const step = chain.get(position)
    if (step === undefined) break
    // A consumer-supplied fn can throw (bad data, a bug in the step itself) — never let that escape
    // untagged; a failed step is just another unresolved chain, same as a dead end or a cycle.
    try {
      payload = step.fn(payload)
    } catch {
      return { snapshot, resolved: false }
    }
    position = step.toVersion
  }
  return position === current ? { snapshot: payload as Row, resolved: true } : { snapshot, resolved: false }
}

// -------------------------------------------------------------------------------------------------------
// Retention: pruning old revisions, called only off the request path (the outbox worker's idle tick).
// -------------------------------------------------------------------------------------------------------

/** @public */
export interface RevisionRetentionPolicy {
  keep: number | 'all'
  maxAgeDays?: number
}

interface PrunableRow {
  revision: number
  created_at: string
}

/**
 * Deletes prunable revisions for one `(collection, recordId)` under `policy`, returning the count deleted.
 * `keep` and `maxAgeDays` combine as a UNION of prunability — a revision beyond the newest `keep` OR older
 * than `maxAgeDays` is prunable — with two protections that are ABSOLUTE over both: the newest revision is
 * never pruned, and a tombstone in that newest slot is never pruned either (both fall out of the same
 * rule: the last row is always excluded from consideration). Sequence numbers of surviving revisions are
 * never renumbered — gaps in `revision` are legal and `readRevisions`/rollback both tolerate them.
 * @public
 */
export function pruneRevisions(sqlite: Database.Database, collection: string, recordId: number, policy: RevisionRetentionPolicy, now: Date): number {
  const name = revisionsTableName(collection)
  const rows = sqlite.prepare(`SELECT revision, created_at FROM ${name} WHERE record_id = ? ORDER BY revision ASC`).all(recordId) as PrunableRow[]
  if (rows.length <= 1) return 0

  const lastRevision = rows[rows.length - 1]!.revision
  const keepCount = policy.keep === 'all' ? Infinity : policy.keep
  const cutoffMs = policy.maxAgeDays !== undefined ? now.getTime() - policy.maxAgeDays * 24 * 60 * 60 * 1000 : undefined

  const prunable: number[] = []
  rows.forEach((row, index) => {
    if (row.revision === lastRevision) return
    const distanceFromNewest = rows.length - 1 - index
    const beyondKeep = distanceFromNewest >= keepCount
    const olderThanCutoff = cutoffMs !== undefined && new Date(row.created_at).getTime() < cutoffMs
    if (beyondKeep || olderThanCutoff) prunable.push(row.revision)
  })
  if (prunable.length === 0) return 0

  const placeholders = prunable.map(() => '?').join(', ')
  const result = sqlite.prepare(`DELETE FROM ${name} WHERE record_id = ? AND revision IN (${placeholders})`).run(recordId, ...prunable)
  return result.changes
}

/** Distinct records scanned per {@link pruneAllDueRevisions} call — bounds the SYNCHRONOUS work one idle
 *  tick does on the event loop, mirroring the outbox worker's own `POLL_BATCH_LIMIT`; this work is off the
 *  request path entirely (only `makeTicker`'s idle branch calls this), so the bound is about not
 *  monopolizing the event loop for one tick, not about request latency. A backlog beyond this drains over
 *  several idle ticks via `pruneCursors`' per-collection cursor, never pruning unbounded in one go. */
const PRUNE_RECORD_BATCH_LIMIT = 500

/** Per-collection high-water mark (`record_id`) `pruneAllDueRevisions` resumes from on its NEXT call —
 *  without this, `record_id > 0 ORDER BY ... LIMIT 500` (or an unbounded `DISTINCT`) would rescan the SAME
 *  first batch every idle tick forever once a collection has more records than the batch limit, starving
 *  every record past it permanently. Wraps back to 0 once a collection's scan reaches its end, so the next
 *  tick starts the sweep over rather than sitting stuck at the top forever. Module-level, not per-`db` —
 *  acceptable because, like `useDb()` itself, exactly one process/db is presumed (see `makeTicker`'s TSDoc). */
const pruneCursors = new Map<string, number>()

/** Test-only reset — mirrors `clearRegistry`/`clearPipelines`/`clearRevisionUpcasts`. Without this, a test
 *  that seeds many fake `record_id`s under a collection name another test already pruned (and left a
 * @public
 *  nonzero cursor for) would start its scan mid-table instead of at the beginning. */
export function clearPruneCursors(): void {
  pruneCursors.clear()
}

/** True when `name` exists as a table — a collection whose revisions table hasn't been migrated yet is
 *  skipped rather than crashing an idle tick. */
function tableExists(sqlite: Database.Database, name: string): boolean {
  return sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined
}

/**
 * The entry point an idle outbox tick calls: prunes every REGISTERED collection's revisions per its own
 * resolved {@link revisionRetentionPolicy}, up to `PRUNE_RECORD_BATCH_LIMIT` distinct records total
 * across all collections THIS call. The scan itself is bounded
 * (`record_id > cursor ORDER BY record_id LIMIT remaining`), not an unbounded `DISTINCT` — a backlog
 * bigger than the limit resumes from
 * `pruneCursors`' per-collection high-water mark on the NEXT call, so every record eventually gets a
 * turn instead of the same first batch being rescanned (and everything past it starved) forever.
 * A collection whose policy is `{ keep: 'all' }` with no `maxAgeDays` (the default) is skipped entirely —
 * no table scan for a policy that would delete nothing. Never called from a write pipeline: pruning must
 * stay off the request path, and each record's prune is its own short autocommit statement, never a long
 * transaction spanning many records.
 * @public
 */
export function pruneAllDueRevisions(db: BetterSQLite3Database, now: Date): number {
  const sqlite = sqliteClientOf(db)
  let totalDeleted = 0
  let recordsScanned = 0

  for (const collection of allCollections()) {
    if (recordsScanned >= PRUNE_RECORD_BATCH_LIMIT) break
    const policy = revisionRetentionPolicy(collection.name)
    if (policy.keep === 'all' && policy.maxAgeDays === undefined) continue

    const name = revisionsTableName(collection.name)
    if (!tableExists(sqlite, name)) continue

    const remaining = PRUNE_RECORD_BATCH_LIMIT - recordsScanned
    const cursor = pruneCursors.get(collection.name) ?? 0
    const ids = sqlite
      .prepare(`SELECT DISTINCT record_id FROM ${name} WHERE record_id > ? ORDER BY record_id LIMIT ?`)
      .all(cursor, remaining) as { record_id: number }[]

    for (const { record_id } of ids) {
      totalDeleted += pruneRevisions(sqlite, collection.name, record_id, policy, now)
      recordsScanned++
    }
    // Fewer rows than asked for means this scan hit the end of the table — wrap back to 0 for next time.
    pruneCursors.set(collection.name, ids.length < remaining ? 0 : ids[ids.length - 1]!.record_id)
  }
  return totalDeleted
}
