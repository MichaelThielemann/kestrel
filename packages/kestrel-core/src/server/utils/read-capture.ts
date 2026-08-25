import { AsyncLocalStorage } from 'node:async_hooks'

// Records which collections/records a render reads, so the publisher can map a content write back to
// exactly the routes that embed it (precise incremental invalidation). The CRUD read seams call
// `captureRead`; the publisher wraps each route render in `withReadCapture`. Outside a capture run
// `captureRead` is a cheap no-op, so normal request/CRUD traffic is unaffected.
const storage = new AsyncLocalStorage<{ tags: Set<string> }>()

/** Tag that the current render read collection `coll` (a `list`/singleton) or record `coll:id` (a `getOne`).
 * @public
 */
export function captureRead(coll: string, id?: number | null): void {
  const store = storage.getStore()
  if (!store) return
  store.tags.add(typeof id === 'number' ? `${coll}:${id}` : coll)
}

/** Run `fn` while collecting the data tags its reads touch; returns the result + the captured tags.
 * @public
 *  Async-safe: AsyncLocalStorage propagates through the awaits of an SSR render. */
export async function withReadCapture<T>(fn: () => Promise<T> | T): Promise<{ result: T; tags: string[] }> {
  const store = { tags: new Set<string>() }
  const result = await storage.run(store, fn)
  return { result, tags: [...store.tags] }
}

/** Sync variant for the synchronous populate path: collects `fn`'s tags into a FRESH set (the enclosing
 * @public
 *  capture does NOT see them — the caller re-emits, e.g. the resolve-scope memo replaying tags on hits). */
export function withReadCaptureSync<T>(fn: () => T): { result: T; tags: string[] } {
  const store = { tags: new Set<string>() }
  const result = storage.run(store, fn)
  return { result, tags: [...store.tags] }
}

/** Re-emit previously captured tags into the CURRENT capture context (no-op outside one).
 * @public
 */
export function replayReadTags(tags: readonly string[]): void {
  const store = storage.getStore()
  if (!store) return
  for (const t of tags) store.tags.add(t)
}
