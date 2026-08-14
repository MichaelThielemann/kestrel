import type { CollectionDef } from './defineCollection'

/**
 * Post-write EFFECTS — the fail-able sibling of the write-event bus (`write-events.ts`).
 *
 * A write LISTENER is fire-and-forget on purpose: a publish failure must never break a content write, so
 * `emitWrite` swallows throws. That is exactly wrong for a write whose external side effect is part of
 * the contract — a redirects artifact the edge serves is stale the moment it fails, and an editor who saw
 * a green save has no way to know. An EFFECT is awaited by the route and its rejection becomes the save's
 * error response.
 *
 * Deliberately narrow: only the singleton PUT runs effects. Widening it to create/update/delete would make
 * every content write fail-able, which is the invariant the listener bus exists to protect.
 *
 * The DB row is already committed when effects run (better-sqlite3 writes are synchronous and CRUD holds
 * no transaction), so a failing effect means "saved, but the side effect is stale" — never a rollback.
 * The message an effect throws has to say so.
 */
export interface WriteEffectEvent {
  def: CollectionDef
  /** The row as saved. */
  row: Record<string, unknown>
}

type WriteEffect = (event: WriteEffectEvent) => Promise<void> | void

const effects: WriteEffect[] = []

export function registerWriteEffect(fn: WriteEffect): void {
  effects.push(fn)
}

export function clearWriteEffects(): void {
  effects.length = 0
}

/** Run the registered effects in order. Rejects on the first failure, leaving the rest unrun. */
export async function runWriteEffects(def: CollectionDef, row: Record<string, unknown>): Promise<void> {
  for (const fn of effects) await fn({ def, row })
}
