import { randomUUID } from 'node:crypto'
import { aggregateKeyOf, buildEnvelope, insertOutboxRow, nextSequence, runWriteAfterStepsSync } from '@kestrel/core'
import mediaCollection from '../collections/media.js'
import { sqliteClientOfMediaDb, type MediaDb } from '../db/media-db.js'

/** Content is the outbox module every media write dispatches through — the same `outbox_content` table
 *  `persist.ts` writes to and `mediaCleanup`/the `*.updated`/`*.deleted` wildcard handlers poll (ADR-0012:
 *  `media` has no outbox table of its own; ADR-0023 records the ownership exemption this implies). */
const OUTBOX_MODULE = 'content'

/** `<collection>.created` (no prior row), `<collection>.deleted` (no surviving row), `<collection>.updated`
 *  otherwise — the same taxonomy `emit-events.ts`'s `eventNameFor` uses for a real CRUD write. `null` on
 *  either side is a real, meaningful state ("no prior row" / "record now gone"); `undefined` is not — it
 *  means a call site never actually checked whether the row existed. Falling through to a verb anyway,
 *  as `== null` did, is fail-DESTRUCTIVE here: an `after` that is `undefined` instead of genuinely `null`
 *  would classify as `media.deleted`, and `mediaCleanup` deletes live storage keys off that verb. Every
 *  current call site already guards this before calling in, so reaching `undefined` is a caller bug —
 *  fail loud instead of guessing. */
function eventNameFor(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined): string {
  if (before === undefined) throw new Error('[kestrel] emitMediaOutbox: "before" is undefined — pass null for "no prior row", not undefined')
  if (after === undefined) throw new Error('[kestrel] emitMediaOutbox: "after" is undefined — pass null for "record now gone", not undefined (undefined here would misclassify as media.deleted and could delete live storage)')
  if (before === null) return 'media.created'
  if (after === null) return 'media.deleted'
  return 'media.updated'
}

/** The envelope metadata a caller running inside a real pipeline already has on its `ctx.facts` — passed
 *  through explicitly (never read off an ambient global) so a ctx-bearing caller (`updateAsset`, the
 *  overwrite upload) contributes the SAME correlation identity and timestamp a normal CRUD write on the
 *  same request would, instead of a synthetic identity of this call's own. */
export interface EmitFacts {
  readonly occurredAt: string
  readonly correlationId: string
  readonly causation: { readonly pipeline: string; readonly op: string }
}

/** The explicit opt-out for a caller with no live pipeline `ctx` to read facts from (`deleteAffected`/
 *  `relocateMedia`/`duplicateMedia`, `backfillRow`) — a brand, not an omitted optional argument, so a
 *  ctx-bearing caller forgetting to pass its `ctx.facts` is a compile error, not a silent fallback to a
 *  synthetic identity. */
export const NO_PIPELINE_CTX = 'no-pipeline-ctx' as const

/**
 * Writes a real {@link EventEnvelope} row for a media-library synthetic write (relocate / duplicate /
 * delete / alt-edit / overwrite-upload / backfill) — the same primitives `persist.ts`'s `emitOutbox` uses
 * (`insertOutboxRow`/`nextSequence`, keyed by `aggregateKeyOf`), so `mediaCleanup` and the `*.updated`/
 * `*.deleted` wildcard handlers (`reindexRefs`) actually get driven by these writes, not just the after-step
 * list `emitMediaWrite` reaches.
 *
 * Stated limit: this writes an outbox envelope only — no `media_revisions` append. A synthetic write never
 * carries `ValidatedInput` through `persist.ts`, so there is no revision history for these operations; they
 * are file operations, not content edits, and their envelopes exist for derived work, not for history.
 *
 * MUST be called from inside the SAME `better-sqlite3` transaction as the row write it describes, so the
 * two land or roll back together — see `persist.ts`'s `emitOutbox` for why this is legal (raw statements
 * issued mid-callback on the same connection stay inside that connection's open `BEGIN`/`COMMIT`).
 *
 * `db` is the caller's OWN `MediaDb` (the exact one its row write runs against), never a separately-fetched
 * global — {@link sqliteClientOfMediaDb} resolves the matching raw connection from `db` itself, structurally,
 * not from a coincidentally-current `useDb()` singleton (see that function's TSDoc for why the distinction
 * matters). This is `media-write.ts`'s one instance of ADR-0023's documented ownership exemption: the raw
 * connection reaches straight into content's `outbox_content` table, past any per-module ownership check —
 * deliberate (a checked media-side `prepare` would just duplicate `outbox.ts`'s own enforcement-free
 * primitives for no gain), and the ONLY foreign-table raw write in the media layer (mirrors
 * `findMediaUsagesForMany`'s read-side exemption in `usages.ts`; see `ownership.media.test.ts`'s pinning test).
 *
 * `facts` is REQUIRED, not optional — either the caller's live pipeline `ctx.facts` (occurredAt, correlationId,
 * and causation read straight off it) or the explicit {@link NO_PIPELINE_CTX} brand for the plain utils with
 * no `ctx` to read (`deleteAffected`/`relocateMedia`/`duplicateMedia`, `backfillRow`), which fall back
 * internally to `new Date().toISOString()` (the same
 * expression `createPipelineContext` uses to fill `RequestFacts.now`) and a fresh `randomUUID()`. Making the
 * opt-out a brand rather than an omitted argument means a ctx-bearing caller that forgets to pass its facts
 * is a compile error, not a silent synthetic identity.
 *
 * The `media.updated` payload is `{ before, after }` (both full rows) — mirrors `emit-events.ts`'s
 * `emitOutboxForUnit`, so planPublish's before-dependent classification works identically for a real CRUD
 * write and a synthetic media write. `created`/`deleted` stay a single row.
 */
export function emitMediaOutbox(
  db: MediaDb,
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  facts: EmitFacts | typeof NO_PIPELINE_CTX,
): void {
  const sqlite = sqliteClientOfMediaDb(db)
  const name = eventNameFor(before, after)
  const row = after ?? before
  const recordId = row!.id as number
  const aggregate = { collection: 'media', recordId }
  const payload = before === null || after === null ? row : { before, after }
  const f: EmitFacts = facts === NO_PIPELINE_CTX
    ? { occurredAt: new Date().toISOString(), correlationId: randomUUID(), causation: { pipeline: 'media', op: 'syntheticWrite' } }
    : facts
  const envelope = buildEnvelope({
    name,
    version: 1,
    aggregate,
    sequence: nextSequence(sqlite, OUTBOX_MODULE, aggregateKeyOf(aggregate)),
    correlationId: f.correlationId,
    causation: f.causation,
    occurredAt: f.occurredAt,
    payload,
  })
  insertOutboxRow(sqlite, OUTBOX_MODULE, envelope)
}

/**
 * Notify the write pipeline's after-steps that a media row changed. The media-library write paths
 * (relocate / duplicate / delete / alt-edit) bypass core CRUD, so — unlike a normal content write — they
 * never run `emitEvents`/`persist` on their own.
 *
 * No IN-TREE after-step fires for `media` any more: `writeRedirects` is registered with no
 * `on.collection` restriction at all, but is a no-op here because its OWN `when` guard only matches the
 * redirects singleton (see `03.redirects.ts`); `reindexRefs`, `mediaCleanup`, and `planPublish` have all
 * moved to outbox handlers, driven instead by the real outbox row {@link emitMediaOutbox} writes atomically
 * with the synthetic write's own row change — not by this call at all. This call still composes with every
 * registered after-step, so it remains the seam an EXTENSION registers its own after-step against (e.g.
 * `galleries-secure`'s `galleryCleanup`) — deleting it would silence any extension relying on it, even
 * though nothing in-tree needs it for `media` any more. `before`/`after` need only carry `id` for what
 * still reads them (an extension's own `when` guard, keyed off the collection/id identity).
 */
export function emitMediaWrite(before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
  runWriteAfterStepsSync('updateOne', mediaCollection, { def: mediaCollection.def, before, after })
}
