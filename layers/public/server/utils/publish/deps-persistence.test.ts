import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createSqlitePersistence } from './deps-persistence'
import { DepsStore } from './deps'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE publish_deps (route TEXT PRIMARY KEY NOT NULL, tags TEXT NOT NULL)')
  return drizzle(sqlite)
}

const asMap = (entries: Iterable<readonly [string, Iterable<string>]>) =>
  new Map([...entries].map(([r, t]) => [r, [...t]]))

describe('createSqlitePersistence (durable publish_deps backing)', () => {
  it('round-trips route -> tags through save / load', () => {
    const p = createSqlitePersistence(freshDb())
    p.save('/speakers', ['speakers', 'settings'])
    p.save('/speakers/ann', ['speakers:1', 'settings'])
    expect(asMap(p.load())).toEqual(
      new Map([['/speakers', ['speakers', 'settings']], ['/speakers/ann', ['speakers:1', 'settings']]]),
    )
  })

  it('save upserts (replaces the tag set for an existing route)', () => {
    const p = createSqlitePersistence(freshDb())
    p.save('/x', ['a'])
    p.save('/x', ['b'])
    const map = asMap(p.load())
    expect(map.get('/x')).toEqual(['b'])
    expect([...map.keys()]).toEqual(['/x'])
  })

  it('remove deletes one route; clearAll empties the table', () => {
    const p = createSqlitePersistence(freshDb())
    p.save('/a', ['x'])
    p.save('/b', ['y'])
    p.remove('/a')
    expect([...p.load()].map(([r]) => r)).toEqual(['/b'])
    p.clearAll()
    expect([...p.load()]).toEqual([])
  })

  it('a DepsStore backed by it survives a "restart" (re-hydrates from the same db)', () => {
    const db = freshDb()
    const s1 = new DepsStore(createSqlitePersistence(db))
    s1.record('/posts/old', ['posts:3'])
    s1.record('/about', ['pages:9'])
    // a fresh process pointed at the same DB rebuilds its index from the durable table:
    const s2 = new DepsStore(createSqlitePersistence(db))
    expect(s2.routes().sort()).toEqual(['/about', '/posts/old'])
    expect(s2.routesForTags(['posts:3'])).toEqual(['/posts/old'])
  })

  it('degrades gracefully when the publish_deps table is absent (a not-yet-migrated deploy)', () => {
    const bare = drizzle(new Database(':memory:')) // no publish_deps table
    const p = createSqlitePersistence(bare)
    expect([...p.load()]).toEqual([])
    // every write op must be a safe no-op, never throw (the boot publish + every write call save())
    expect(() => { p.save('/a', ['x']); p.remove('/a'); p.clearAll() }).not.toThrow()
    // a DepsStore backed by it still works purely in-memory (no crash on record)
    const s = new DepsStore(p)
    expect(() => s.record('/a', ['x'])).not.toThrow()
    expect(s.routesForTags(['x'])).toEqual(['/a'])
  })
})
