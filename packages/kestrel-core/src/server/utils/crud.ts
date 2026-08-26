import { createError } from 'h3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { BuiltCollection } from '@michaelthielemann/kestrel-core'
import { buildDuplicateBody } from './duplicate.js'
import { runRead, runWrite, runWriteAsync } from '../pipeline/defaults.js'
import type { BatchResult } from '../pipeline/steps/persist.js'
import { FILTER_RE, isFilterOp } from '../../app/utils/filter-ops.js'
import type { FilterClause, ListQuery, ListResult } from '../pipeline/steps/read-shared.js'

type DB = BetterSQLite3Database
type Row = Record<string, unknown>

// Re-exported here because both are part of this module's published surface (the media upload maps the
// unique violation, the transform test drives it directly).
export { isUniqueViolation } from '../pipeline/steps/shared.js'
export { applyFieldTransforms } from '../pipeline/steps/transform.js'

// Re-exported here as this module's public read-query types (callers construct a `ListQuery` for `list()`
// without reaching into `pipeline/`).
export type { FilterClause, ListQuery }

/** Parse the `filter[...]` query keys into clauses. A bare key means `eq`. ufo turns a repeated key into an
 *  array, so one clause is emitted per value (repeated same-op AND). An unknown operator TOKEN is a clean
 * @public
 *  400 here; an operator that is merely disallowed FOR THE FIELD's kind is caught by the `parseQuery` step. */
export function parseFilter(query: Record<string, unknown>): FilterClause[] {
  const out: FilterClause[] = []
  for (const [key, value] of Object.entries(query)) {
    const m = FILTER_RE.exec(key)
    if (!m) continue
    const op = m[2] ?? 'eq'
    if (!isFilterOp(op)) throw createError({ statusCode: 400, statusMessage: `Unknown filter operator: ${op}` })
    for (const v of Array.isArray(value) ? value : [value]) out.push({ field: m[1]!, op, value: String(v) })
  }
  return out
}

/** @public */
export function list(db: DB, c: BuiltCollection, q: ListQuery, publishedOnly = false, publicOnly = false): ListResult {
  return runRead<ListResult>('readMany', { collection: c, db, input: q, work: { publishedOnly, publicOnly } })
}

/** @public */
export function getOne(db: DB, c: BuiltCollection, id: number, depth = 0, locale?: string, publishedOnly = false, publicOnly = false): Row {
  return runRead<Row>('readOne', { collection: c, db, id, locale, input: { depth }, work: { publishedOnly, publicOnly } })
}

/** @public */
export function create(db: DB, c: BuiltCollection, body: unknown): Row {
  return runWrite<Row>('createOne', { collection: c, db, input: body })
}

/** @public */
export interface UpdateOptions {
  /** Optimistic-concurrency precondition: the `updatedAt` (epoch ms) the caller last read. When given and
   *  it no longer matches the stored row, the update is refused with 409 — so a stale editor tab can't
   *  silently revert a newer save (and propagate that revert into the static output). Omitted → unconditional. */
  expectedUpdatedAt?: number
}

/** @public */
export function update(db: DB, c: BuiltCollection, id: number, body: unknown, opts: UpdateOptions = {}): Row {
  return runWrite<Row>('updateOne', { collection: c, db, id, input: body, work: { expectedUpdatedAt: opts.expectedUpdatedAt } })
}

/** Single-record delete — runs `deleteMany`'s step list over `[id]` so there is ONE delete implementation.
 * @public
 *  The `[id].delete.ts` route and its `{ deleted, id }` contract are unchanged. */
export function remove(db: DB, c: BuiltCollection, id: number): { deleted: true, id: number } {
  runWrite<BatchResult>('deleteOne', { collection: c, db, id, input: [id] })
  return { deleted: true, id }
}

/**
 * Delete a batch of rows by id — the single implementation behind both the single-record delete and the
 * bulk `delete` action (a row action IS a bulk action with one id). ALL-OR-NOTHING: a pre-flight existence
 * check aborts the whole delete with a clean 404 if ANY id is absent from THIS collection (a foreign or a
 * stale id), so a partial silent success is impossible. The delete is one atomic multi-row statement; the
 * per-row write events fire strictly AFTER it (never inside a rollback-able transaction) so a failed delete
 * can never leave a stray publish-prune enqueued for an un-deleted row.
 * @public
 */
export function removeMany(db: DB, c: BuiltCollection, ids: number[]): BatchResult {
  return runWrite<BatchResult>('deleteMany', { collection: c, db, input: ids })
}

/**
 * Publish / unpublish a batch of rows by persisting their `status` — the record's public INTENT, not the
 * static file. Since ADR-0008 those are two steps: this write emits the same event an editor save emits,
 * and the public layer's listener acts on the removal half only (UNPUBLISH prunes the route at once, so a
 * page taken offline can never stay live). Making a page appear is the explicit publish action
 * (`POST /api/publish`). Runs `updateMany` with a `{ status }` patch: ALL-OR-NOTHING like `removeMany` (a
 * missing id 404s before any write), validation on PUBLISH ONLY — unpublishing must never be blockable
 * (you must always be able to take a broken page offline) — and none of `updateOne`'s slug/transform
 * branches, which are provably inert for a status-only change.
 * @public
 */
export function setStatusMany(db: DB, c: BuiltCollection, ids: number[], status: 'draft' | 'published'): BatchResult {
  return runWrite<BatchResult>('updateMany', { collection: c, db, input: { ids, patch: { status } } })
}

/** Duplicate one record into a new draft copy: the derived body runs through the `createOne` chain, so
 *  validation, the fresh translationGroup, transforms, the unique-slug check, the insert and the write
 * @public
 *  event all come from the one create implementation. */
export function duplicateRecord(db: DB, c: BuiltCollection, id: number): Row {
  return create(db, c, buildDuplicateBody(db, c, id))
}

/**
 * Duplicate a batch of rows — sequential and best-effort (a duplicate is a row action, not an all-or-nothing
 * transaction): each id becomes a new draft copy and the first failing id throws its own status.
 * @public
 */
export async function duplicateMany(db: DB, c: BuiltCollection, ids: number[]): Promise<Row[]> {
  return runWrite<Row[]>('duplicate', { collection: c, db, input: ids })
}

/** A GET on a singleton is `readOne` without an id, mirroring how `putSingleton` runs `updateOne` without
 * @public
 *  one — `fetchOneStep`/`populateOneStep` branch on `ctx.id === undefined` to run the singleton lookup. */
export function getSingleton(db: DB, c: BuiltCollection, locale?: string, publishedOnly = false, depth = 0, publicOnly = false): Row | null {
  return runRead<Row | null>('readOne', { collection: c, db, locale, input: { depth }, work: { publishedOnly, publicOnly } })
}

/** Async, unlike every other write export here: the only pipeline that can reach a critical async
 *  after-step is `updateOne` on the redirects singleton (`writeRedirects` — see `03.redirects.ts`), and
 *  that after-step must be awaited so its failure becomes the save's response, with the row already
 * @public
 *  committed. */
export async function putSingleton(db: DB, c: BuiltCollection, locale: string | undefined, body: unknown, opts: UpdateOptions = {}): Promise<Row> {
  return runWriteAsync<Row>('updateOne', { collection: c, db, input: body, locale, work: { expectedUpdatedAt: opts.expectedUpdatedAt } })
}
