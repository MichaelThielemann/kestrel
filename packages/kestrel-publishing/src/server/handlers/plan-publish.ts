import { eq, getTableColumns } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { EventEnvelope } from '@kestrel/contracts'
import { getCollection, getResolvedKestrelConfig, prefixPrimaryLocale, primaryLocale, registerOutboxHandler, useContentDb } from '@kestrel/core'
import { usePublishRuntime } from '../utils/publish/publish-runtime.js'
import { classifyWrite, planWrite, type WriteClassification, type WriteCollection } from '../utils/publish/invalidation.js'

type Row = Record<string, unknown>

/** The `updated` envelope shape both emitters (`emit-events.ts`'s `emitOutboxForUnit`,
 *  `media-write.ts`'s `emitMediaOutbox`) now write at version 1 — both full rows, so before-dependent
 *  classification (path/status change) can read the prior state straight off the envelope. The exact-two-key
 *  check (not just "has `before` and `after`") guards against a pre-change row whose payload happened to be
 *  a plain record that itself has fields literally named `before`/`after` — an edge case worth ruling out
 *  cheaply rather than assuming away. */
function isBeforeAfterPayload(payload: unknown): payload is { before: Row | null; after: Row | null } {
  return typeof payload === 'object' && payload !== null && Object.keys(payload).length === 2 && 'before' in payload && 'after' in payload
}

/** Reads `output.publishOnSave` fresh on every dispatch off the config-provider seam — a package cannot
 *  reach `useRuntimeConfig()` directly (see `publisher.ts`'s `outputConfig()` TSDoc for why this seam read
 *  is behavior-identical to the direct read it replaces). No boot-time plugin closure to cache it in
 *  (unlike the old inline after-step), and the seam read is itself a cheap in-memory read. */
function publishOnSave(): boolean {
  return getResolvedKestrelConfig().output?.publishOnSave ?? false
}

/**
 * Outbox handler for publish planning: replaces the old non-critical `planPublishStep` after-step built
 * inside `zz.publish.ts`. Registered (via {@link registerPlanPublish}) against the `*.created`/`*.updated`/
 * `*.deleted` collection wildcards — content AND media writes both feed publish planning (a media write can
 * change a data tag pages depend on, even though media has no route of its own).
 *
 * Classification needs the record's CURRENT state (`after`) and, for `updated`, its PRIOR state (`before`)
 * to detect a path/status change — see `invalidation.ts`'s `classifyWrite`. `after` always comes from a
 * fresh read of the record's table by id, never the envelope's own payload: a redelivered stale envelope
 * (e.g. a `created` envelope replayed after the record was later deleted) must classify against what is
 * actually true NOW, not what was true when the envelope was built (mirrors `reindexRefs`'s same rule).
 * `before` for a `deleted` envelope has no "current" source left (the row is gone), so it comes from the
 * envelope's own payload instead — the only place that state survives.
 *
 * DEFENSIVE FALLBACK: an `updated` envelope whose payload does NOT match the `{ before, after }` shape (a
 * row written under the pre-change wire shape, left pending in a dev database across the shape change) is
 * treated as before-UNKNOWN. Rather than guess, `statusChanged`/`pathChanged` are both forced `true` on the
 * classification built from `{ after, after }` — the conservative assumption that a status/path transition
 * MAY have happened. The case this actually protects is the default (non-`publishOnSave`) plan: a genuine
 * unpublish/delete is the only thing `planSaveInvalidation` ever auto-republishes, gated on
 * `statusChanged && !isPublished` — with `isPublished` read off the real, known current row, forcing
 * `statusChanged` true means a currently-unpublished record is never silently treated as "no change
 * happened" and left un-pruned. A record that is currently still published stays a noop either way, real
 * `before` or not — ADR-0008 already means a plain save (no real availability change) renders nothing under
 * the default mode, so there is nothing this fallback needs to force there. `pathChanged` only matters at
 * all when `output.publishOnSave` is on (then `planWrite` runs the full `planInvalidation` unconditionally);
 * forcing it true there trades a possibly-unneeded render for never missing a real one.
 *
 * `prune` is ALWAYS suppressed for this branch's result, even when the forced flags would otherwise produce
 * one. The real old `path`/`status` are genuinely unrecoverable here, so any prune route this branch could
 * synthesize is a guess — and a wrong prune is not the safe kind of wrong: it can delete a DIFFERENT
 * record's live static file (a route this stale row never actually owned). A missing render is
 * self-healing (the next explicit publish, or a later real write, catches it up); an incorrect deletion is
 * not reversible the same way. Conservative here means non-destructive, not "do the most work" — render and
 * tag-invalidate freely, never prune on a guess.
 *
 * Expected to fire only once per stale row — redelivery always re-reads the current row, and a payload
 * written from here on is always the new shape.
 *
 * ERROR SEMANTICS: like `reindexRefs` before it (ADR-0022), this handler throws normally instead of being
 * bus-isolated — the old `critical: false` after-step swallowed a throw entirely; nothing here does. A
 * throw fails the whole dispatch for this row: `outbox-worker.ts`'s `dispatchRow` retries up to the
 * worker's attempt budget, then dead-letters, visibly. Retry re-runs every handler registered for the
 * event, not just the one that failed (`runHandlers`'s TSDoc) — so a `planPublish` failure on, say,
 * `pages.updated` drags `reindexRefs`'s already-succeeded handler for the SAME envelope along for every
 * retry too, and vice versa (ADR-0022 flagged this coupling in advance). Both handlers are idempotent, so
 * the redundant reruns converge rather than compound.
 *
 * Idempotency: every delivery re-derives from the CURRENT row plus the envelope's own immutable
 * before/after — running the same envelope twice always recomputes the identical `Invalidation` and
 * re-enqueues it; the queue itself (debounce + coalesce) is what collapses repeated identical plans into
 * one publish run, not this handler.
 */
async function planPublish(envelope: EventEnvelope): Promise<void> {
  const runtime = usePublishRuntime()
  if (!runtime) return // no live publish machinery (dev, or `output.auto` off) — nothing to enqueue against.

  const { collection, recordId } = envelope.aggregate
  const c = getCollection(collection)
  if (!c) return // an event for a collection no longer registered — nothing to plan against.

  const db = useContentDb().db
  const cols = getTableColumns(c.table) as Record<string, AnySQLiteColumn>
  const after = (db.select().from(c.table as never).where(eq(cols.id, recordId)).get() as Row | undefined) ?? null
  const def = c.def as unknown as WriteCollection

  const verb = envelope.name.slice(envelope.name.lastIndexOf('.') + 1)

  if (verb === 'updated' && !isBeforeAfterPayload(envelope.payload)) {
    const forced: WriteClassification = {
      ...classifyWrite(def, after, after, primaryLocale(), prefixPrimaryLocale()),
      pathChanged: true,
      statusChanged: !!def.status,
    }
    const inv = planWrite(forced, publishOnSave())
    runtime.queue.enqueue(inv.type === 'tags' && inv.prune.length ? { ...inv, prune: [] } : inv)
    return
  }

  let classification: WriteClassification
  if (verb === 'created') {
    classification = classifyWrite(def, null, after, primaryLocale(), prefixPrimaryLocale())
  } else if (verb === 'deleted') {
    const before = (envelope.payload ?? null) as Row | null
    classification = classifyWrite(def, before, after, primaryLocale(), prefixPrimaryLocale())
  } else {
    classification = classifyWrite(def, (envelope.payload as { before: Row | null }).before, after, primaryLocale(), prefixPrimaryLocale())
  }

  runtime.queue.enqueue(planWrite(classification, publishOnSave()))
}

/** Registers `planPublish` (this module's own internal handler) against every content/media write verb.
 *  Called once, from the `05.plan-publish.ts` plugin's body — not a module-import side effect (mirrors
 *  `registerReindexRefs`/`registerMediaCleanup`). Safe to register unconditionally: the handler itself
 *  no-ops whenever there is no live {@link usePublishRuntime} (dev, or `output.auto` off) — the dev/auto
 *  gate lives in whether `zz.publish.ts` ever calls `setPublishRuntime`, not in whether this registers.
 * @public
 */
export function registerPlanPublish(): void {
  for (const verb of ['created', 'updated', 'deleted']) {
    registerOutboxHandler('planPublish', { event: `*.${verb}` }, planPublish)
  }
}
