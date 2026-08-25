// An in-process async mutex keyed by string: operations sharing a key run STRICTLY one-at-a-time (FIFO),
// while different keys run concurrently. Kestrel is single-process SSR (the publish queue is single-flight
// the same way), so this is sufficient to serialize storage+DB mutations that would otherwise race —
// concurrent uploads to the same key, a folder delete/move interleaving an upload under it, or a backfill
// re-deriving a row an overwrite is replacing. (A horizontally-scaled deployment would need a distributed
// lock instead; that is a separate concern flagged where it matters.)

const tails = new Map<string, Promise<unknown>>()

/**
 * Run `fn` once every previously-enqueued task for `key` has settled. Returns fn's result/rejection
 * unchanged; a failing task never blocks the queue (the next task still runs). The key's chain entry is
 * dropped once it drains, so the map doesn't grow unbounded.
 * @public
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  // Chain after prev regardless of how prev settled (don't let one task's rejection skip the next).
  const result = prev.then(fn, fn)
  const tail = result.then(() => {}, () => {})
  tails.set(key, tail)
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
  return result
}

/**
 * The lock key for a media mutation on a specific object: the exact storage key. Same-key ops serialize
 * (a concurrent upload to the same key, or a backfill re-deriving a row an overwrite is replacing), while
 * different objects stay fully concurrent. (Folder delete/move races are handled separately by the
 * removeDir listPrefix guard, so they need no lock here.)
 * @public
 */
export function mediaLockKey(storageKey: string): string {
  return `media:${storageKey.replace(/^\/+/, '')}`
}
