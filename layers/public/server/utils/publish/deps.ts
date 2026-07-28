/**
 * Routes whose captured dependency tags intersect `changed`. The publisher captures, per published
 * route, the set of data tags it read while rendering (`<coll>` for a `list`, `<coll>:<id>` for a
 * `getOne`, `<coll>` for a singleton). On a write, the changed tags `{coll, coll:id}` map back to
 * exactly the routes that embed that data — so editing one speaker re-renders its detail page + the
 * overview that lists speakers, and nothing else. Pure.
 */
export function routesForTags(changed: Iterable<string>, index: Map<string, Set<string>>): string[] {
  const want = new Set(changed)
  const out: string[] = []
  for (const [route, tags] of index) {
    for (const t of tags) {
      if (want.has(t)) { out.push(route); break }
    }
  }
  return out
}

/**
 * Routes the publisher previously wrote (tracked in the deps index) that are no longer in the published
 * set — a page that was unpublished, deleted, or whose slug changed. Their static files must be removed
 * on the next full publish. Pure; the diff drives a targeted prune (it only ever deletes files this
 * publisher created — output ≡ DB, no opt-in toggle).
 */
export function staleRoutes(tracked: Iterable<string>, publishedNow: Iterable<string>): string[] {
  const live = new Set(publishedNow)
  return [...tracked].filter((route) => !live.has(route))
}

/**
 * Durable backing for the deps index: a write-through `route → tags` store that survives a restart.
 * The in-memory index is the (synchronous) query layer; this port persists every mutation and is read
 * back once on construction to rehydrate. Kept abstract so `DepsStore` stays pure-unit-testable (a fake
 * port in node tests) while production injects the SQLite-backed adapter (`createSqlitePersistence`).
 */
export interface DepsPersistence {
  /** Every persisted `route → tags` pair (read once on DepsStore construction to rehydrate). */
  load(): Iterable<readonly [string, Iterable<string>]>
  /** Persist (upsert) a route's tag set. */
  save(route: string, tags: Iterable<string>): void
  /** Remove a route. */
  remove(route: string): void
  /** Drop every route. */
  clearAll(): void
}

/**
 * In-memory `route → tags` index, populated as routes are published and queried on each write — the fast
 * synchronous query layer. When constructed with a `DepsPersistence`, the index is rehydrated from it on
 * boot and every mutation is written through, so the store survives a restart: a boot full-publish's
 * `staleRoutes` can then prune pages that were unpublished/deleted while the server was down.
 */
export class DepsStore {
  private index = new Map<string, Set<string>>()

  constructor(private persistence?: DepsPersistence) {
    if (persistence) for (const [route, tags] of persistence.load()) this.index.set(route, new Set(tags))
  }

  /** Replace the tag set captured for `route`. */
  record(route: string, tags: Iterable<string>): void {
    const set = new Set(tags)
    this.index.set(route, set)
    this.persistence?.save(route, set)
  }

  /** Routes whose tags intersect `changed`. */
  routesForTags(changed: Iterable<string>): string[] {
    return routesForTags(changed, this.index)
  }

  /** Every route with a captured tag set. */
  routes(): string[] {
    return [...this.index.keys()]
  }

  /** Drop `route` from the index (on prune/unpublish). */
  forget(route: string): void {
    this.index.delete(route)
    this.persistence?.remove(route)
  }

  clear(): void {
    this.index.clear()
    this.persistence?.clearAll()
  }
}
