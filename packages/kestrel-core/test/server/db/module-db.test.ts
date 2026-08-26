import { describe, it, expect, expectTypeOf } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import type { Layer, Context } from 'effect'
import { desiredSchema } from '../../../src/server/schema/desired.js'
import { diffSchema } from '../../../src/server/schema/diff.js'
import { renderSqlite } from '../../../src/server/schema/render-sqlite.js'
import { makeModuleDb, OwnershipViolation } from '../../../src/server/db/module-db.js'
import type { OwnershipManifest } from '@michaelthielemann/kestrel-contracts'

// Contract under test:
//   makeModuleDb(manifest, sqlite, tables) -> { layer: Layer.Layer<ModuleDbTag>, tag }
// where the tag exposes ONLY the manifest's Drizzle tables + prepared-statement helpers, and every
// executed statement is checked against the manifest in dev/test mode.
//
// `sqlite` is the raw `better-sqlite3.Database` handle (this codebase never reaches for a hidden DB
// singleton inside a callee — every op takes `db` explicitly); the adapter builds its own Drizzle
// wrapper from this handle internally and never returns the handle itself (see the "not reachable"
// tests below). `tables` is the concrete Drizzle table objects for `manifest.tables`
// (`Record<string, AnySQLiteTable>`), since `OwnershipManifest` carries table *names* only.
//
// `OwnershipViolation` is module-local (exported from `module-db.ts`, not `@michaelthielemann/kestrel-contracts`): it is a
// dev/test-only enforcement guard, never part of the public consumer error channel (`KestrelError`) and
// never crosses the Promise/HTTP boundary, so it does not need `Schema.TaggedError`'s encode/decode — a
// plain `Data.TaggedError` is enough.

const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
})

const authors = sqliteTable('authors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})

const mediaFiles = sqliteTable('media_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  postId: integer('post_id'),
  path: text('path').notNull(),
})

const contentManifest: OwnershipManifest = { module: 'content', tables: ['posts', 'authors'] }
const mediaManifest: OwnershipManifest = { module: 'media', tables: ['media_files'] }
const contentTables = { posts, authors }
const mediaTables = { media_files: mediaFiles }

function seedDb(): Database.Database {
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([posts, authors, mediaFiles]), {}))) sqlite.exec(stmt)
  return sqlite
}

/** Extracts the built service out of a Layer + its paired Tag — the only way to read a Layer back in a test. */
function getService<I, A>(layer: Layer.Layer<I>, tag: Context.Tag<I, A>): A {
  return Effect.runSync(Effect.scoped(Effect.provide(tag, layer)))
}

/** Runs `fn` with `NODE_ENV` forced to `'production'` for the duration, then restores it. `makeModuleDb`
 *  reads `NODE_ENV` once, at construction, so the override must be in place before it is called. */
function inProdMode<T>(fn: () => T): T {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    return fn()
  } finally {
    process.env.NODE_ENV = prev
  }
}

describe('makeModuleDb — ownership-enforcing per-module DB adapter', () => {
  it('own-table access succeeds: select/insert/update/delete + a prepared statement', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    const inserted = svc.db.insert(svc.tables.posts as typeof posts).values({ title: 'Hello' }).returning().all()
    expect(inserted).toHaveLength(1)
    const id = inserted[0]!.id as number

    const rows = svc.db.select().from(svc.tables.posts as typeof posts).all()
    expect(rows).toHaveLength(1)

    svc.db.update(svc.tables.posts as typeof posts).set({ title: 'Updated' }).run()
    expect(() => svc.db.prepare('UPDATE posts SET title = ? WHERE id = ?').run('Prepared', id)).not.toThrow()

    svc.db.delete(svc.tables.posts as typeof posts).run()
    expect(() => svc.db.prepare('SELECT * FROM posts').all()).not.toThrow()
  })

  it('raw SQL through the adapter throws OwnershipViolation naming the foreign table + module', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    expect(() => svc.db.prepare('SELECT * FROM media_files').all()).toThrow(OwnershipViolation)
    try {
      svc.db.prepare('SELECT * FROM media_files').all()
      expect.fail('expected OwnershipViolation')
    } catch (err) {
      expect(err).toBeInstanceOf(OwnershipViolation)
      const violation = err as OwnershipViolation
      expect(violation.table).toBe('media_files')
      expect(violation.module).toBe('content')
    }
  })

  it('own-table selectDistinct succeeds; a foreign selectDistinct throws OwnershipViolation', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)
    svc.db.insert(svc.tables.posts as typeof posts).values({ title: 'Hello' }).run()

    expect(() => svc.db.selectDistinct({ title: posts.title }).from(svc.tables.posts as typeof posts).all()).not.toThrow()
    expect(() => svc.db.selectDistinct().from(mediaFiles).all()).toThrow(OwnershipViolation)
  })

  it('a Drizzle query joining own x foreign table throws OwnershipViolation', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    expect(() => {
      svc.db.select().from(svc.tables.posts as typeof posts)
        .leftJoin(mediaFiles, eq(posts.id, mediaFiles.postId))
        .all()
    }).toThrow(OwnershipViolation)
  })

  it('a foreign table referenced only inside a subquery/CTE is still caught', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    // Nested inside a subquery, not top-level FROM/JOIN — the introspection must not be fooled by nesting.
    expect(() => svc.db.prepare(
      'SELECT * FROM posts WHERE id IN (SELECT post_id FROM media_files)',
    ).all()).toThrow(OwnershipViolation)

    // Same table, referenced via a CTE instead of a direct subquery.
    expect(() => svc.db.prepare(
      'WITH foreign_ids AS (SELECT post_id FROM media_files) SELECT * FROM posts WHERE id IN (SELECT post_id FROM foreign_ids)',
    ).all()).toThrow(OwnershipViolation)
  })

  it('a CTE cannot shadow a foreign DML target: DELETE/INSERT/UPDATE still throw', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    // SQLite resolves a DML target straight to the real table even when a CTE of the same name is in
    // scope — a CTE cannot be a DML target. The ownership check must not be fooled by the alias either.
    expect(() => svc.db.prepare(
      'WITH media_files AS (SELECT 1) DELETE FROM media_files',
    ).run()).toThrow(OwnershipViolation)

    expect(() => svc.db.prepare(
      "WITH media_files AS (SELECT 1) INSERT INTO media_files (path) VALUES ('/x.png')",
    ).run()).toThrow(OwnershipViolation)

    expect(() => svc.db.prepare(
      "WITH media_files AS (SELECT 1) UPDATE media_files SET path = '/y.png'",
    ).run()).toThrow(OwnershipViolation)

    // The throws above are not vacuous: the real foreign table exists and is untouched.
    drizzle(db).insert(mediaFiles).values({ path: '/seed.png' }).run()
    expect((drizzle(db).select().from(mediaFiles).all() as { path: string }[]).map((r) => r.path)).toEqual(['/seed.png'])
  })

  it('comma-joined FROM list, foreign DDL, and PRAGMA introspection are all caught', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    // `FROM a, b` — SQLite's implicit-join comma list; the foreign table is not the first item.
    expect(() => svc.db.prepare(
      'SELECT * FROM posts, media_files WHERE posts.id = media_files.post_id',
    ).all()).toThrow(OwnershipViolation)

    expect(() => svc.db.prepare('DROP TABLE media_files').run()).toThrow(OwnershipViolation)
    expect(() => svc.db.prepare('ALTER TABLE media_files RENAME TO mf2').run()).toThrow(OwnershipViolation)
    expect(() => svc.db.prepare('CREATE INDEX mf_idx ON media_files (path)').run()).toThrow(OwnershipViolation)
    expect(() => svc.db.prepare('PRAGMA table_info(media_files)').all()).toThrow(OwnershipViolation)

    // Own-table equivalents must still pass — coverage growth must not turn into new false positives.
    expect(() => svc.db.prepare('SELECT * FROM posts, authors').all()).not.toThrow()
    expect(() => svc.db.prepare('PRAGMA table_info(posts)').all()).not.toThrow()
  })

  it('an upsert (.onConflictDoUpdate) does not mistake its SET clause for a foreign "set" table', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    svc.db.insert(posts).values({ id: 1, title: 'first' }).run()

    // Compiles to `... ON CONFLICT ("id") DO UPDATE SET "title" = ?, ...` — the literal `UPDATE SET`
    // must not be read as a table-qualified UPDATE statement targeting a table named "set".
    expect(() => svc.db.insert(posts)
      .values({ id: 1, title: 'second' })
      .onConflictDoUpdate({ target: posts.id, set: { title: 'second' } })
      .run()).not.toThrow()
    expect(svc.db.prepare('SELECT title FROM posts WHERE id = 1').get()).toEqual({ title: 'second' })
  })

  it('a schema-qualified own-table name is not mistaken for a foreign table', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    // `main.posts` must resolve to `posts` (owned), not to a foreign table literally named `main`.
    expect(() => svc.db.prepare('SELECT * FROM main.posts').all()).not.toThrow()
    expect(() => svc.db.prepare('SELECT * FROM main.media_files').all()).toThrow(OwnershipViolation)
  })

  it('a Drizzle builder chained through its own .prepare() is still checked, not crashed', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    // Drizzle's own chain `.prepare()` (distinct from `svc.db.prepare`) returns a prepared-query object
    // shaped without `toSQL()` — the wrapper must fall back to its `{ query: { sql } }` shape instead of
    // throwing a TypeError, and must still enforce ownership on it.
    expect(() => svc.db.select().from(svc.tables.posts as typeof posts).prepare().all()).not.toThrow()
    expect(() => svc.db.select().from(mediaFiles).prepare().all()).toThrow(OwnershipViolation)
  })

  it('.values() is arity-aware: terminal with no args, a chain method with insert row data', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    // Select's zero-arg `.values()` executes and returns raw array rows — must still be checked.
    expect(() => svc.db.select().from(mediaFiles).values()).toThrow(OwnershipViolation)
    expect(() => svc.db.select().from(svc.tables.posts as typeof posts).values()).not.toThrow()

    // Insert's `.values(row)` supplies data and chains — must not be treated as terminal.
    const inserted = svc.db.insert(svc.tables.posts as typeof posts).values({ title: 'Chained' }).returning().all()
    expect(inserted).toHaveLength(1)
  })

  it('awaiting a query builder (the thenable path) is still checked, not bypassed', async () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    await expect(svc.db.select().from(mediaFiles)).rejects.toBeInstanceOf(OwnershipViolation)
    await expect(svc.db.select().from(svc.tables.posts as typeof posts)).resolves.toBeDefined()
  })

  it('prod mode switches the check off: the same foreign statement passes', () => {
    const db = seedDb()

    inProdMode(() => {
      const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
      const svc = getService(layer, tag)
      expect(() => svc.db.prepare('SELECT * FROM media_files').all()).not.toThrow()
    })
  })

  it('the raw Database handle is not reachable through the returned service (runtime)', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag) as unknown as Record<string, unknown>

    const surface = new Set(Object.keys(svc))
    for (const key of surface) {
      const value = svc[key]
      expect(value).not.toBeInstanceOf(Database)
      if (value && typeof value === 'object') {
        expect(Object.values(value as Record<string, unknown>)).not.toContain(db)
      }
    }

    // The statement returned by `prepare()` must not carry `.database` (better-sqlite3's own
    // back-reference to the raw handle) at any depth — a bare Statement exposes exactly that.
    const prepare = (svc.db as Record<string, unknown>).prepare as (sql: string) => Record<string, unknown>
    const stmt = prepare('SELECT * FROM posts')
    expect(stmt).not.toBeInstanceOf(Database)
    expect(Object.keys(stmt)).not.toContain('database')
    for (const value of Object.values(stmt)) {
      expect(value).not.toBeInstanceOf(Database)
      expect(value).not.toBe(db)
    }
  })

  it('the raw Database handle is not reachable through the returned service (type-level)', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    // @ts-expect-error — `rawDb` (or any raw better-sqlite3 handle) must not be part of ModuleDbService.
    void svc.rawDb
    expectTypeOf(svc).not.toHaveProperty('rawDb')

    const stmt = svc.db.prepare('SELECT * FROM posts')
    // @ts-expect-error — `database` (better-sqlite3's raw-handle back-reference) must not survive onto
    // the statement facade the adapter returns.
    void stmt.database
    expectTypeOf(stmt).not.toHaveProperty('database')
  })

  it('two adapters over the same underlying file: each sees only its own tables (cross-adapter isolation)', () => {
    const db = seedDb()
    const { layer: contentLayer, tag: contentTag } = makeModuleDb(contentManifest, db, contentTables)
    const { layer: mediaLayer, tag: mediaTag } = makeModuleDb(mediaManifest, db, mediaTables)
    const content = getService(contentLayer, contentTag)
    const media = getService(mediaLayer, mediaTag)

    expect(() => content.db.prepare('SELECT * FROM posts').all()).not.toThrow()
    expect(() => content.db.prepare('SELECT * FROM media_files').all()).toThrow(OwnershipViolation)

    expect(() => media.db.prepare('SELECT * FROM media_files').all()).not.toThrow()
    expect(() => media.db.prepare('SELECT * FROM posts').all()).toThrow(OwnershipViolation)

    // Same underlying file: a write through one adapter is visible on the other's own-table read —
    // isolation is per-manifest access control, not per-adapter data partitioning.
    media.db.prepare('INSERT INTO media_files (path) VALUES (?)').run('/a.png')
    const count = (drizzle(db).select().from(mediaFiles).all() as unknown[]).length
    expect(count).toBe(1)
  })

  it('db.transaction: own-table reads/writes inside the callback succeed, and commit', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    svc.db.transaction((tx) => {
      tx.insert(posts).values({ title: 'in a tx' }).run()
      tx.update(posts).set({ title: 'updated in a tx' }).where(eq(posts.title, 'in a tx')).run()
    })
    expect(svc.db.select().from(posts).all()).toEqual([{ id: 1, title: 'updated in a tx' }])
  })

  it('db.transaction forwards its config (e.g. { behavior: "immediate" }) to the underlying driver', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    expect(() => svc.db.transaction((tx) => {
      tx.insert(posts).values({ title: 'immediate' }).run()
    }, { behavior: 'immediate' })).not.toThrow()
    expect(svc.db.select().from(posts).all()).toHaveLength(1)
  })

  it('db.transaction: a foreign-table access inside the callback still throws OwnershipViolation', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    expect(() => svc.db.transaction((tx) => {
      tx.select().from(mediaFiles).all()
    })).toThrow(OwnershipViolation)

    expect(() => svc.db.transaction((tx) => {
      tx.insert(mediaFiles).values({ path: '/x.png' }).run()
    })).toThrow(OwnershipViolation)

    // Not vacuous: nothing landed in the foreign table.
    expect((drizzle(db).select().from(mediaFiles).all() as unknown[]).length).toBe(0)
  })

  it('db.transaction in prod mode delegates straight to the driver (own-table work still commits)', () => {
    const db = seedDb()
    inProdMode(() => {
      const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
      const svc = getService(layer, tag)
      svc.db.transaction((tx) => {
        tx.insert(posts).values({ title: 'prod tx' }).run()
      })
      expect(svc.db.select().from(posts).all()).toEqual([{ id: 1, title: 'prod tx' }])
    })
  })

  it('db.transaction: the tx handle exposes ONLY select/insert/update/delete/transaction — no raw escape hatch', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    svc.db.transaction((tx) => {
      // `run`/`all`/`get`/`values` (free raw SQL bypassing the four checked methods), `with`/`$count`
      // (unwrapped builders) and `session` (the real escape hatch to the raw better-sqlite3.Database, see
      // the "two adapters" isolation test below for what it would leak) must all be genuinely absent, not
      // merely unchecked — an object literal, not a wrapped/proxied Drizzle tx, guarantees that.
      for (const key of ['run', 'all', 'get', 'values', 'with', '$count', 'session', 'prepare'] as const) {
        expect(key in tx, `tx.${key} must not exist`).toBe(false)
      }
      expectTypeOf(tx).not.toHaveProperty('session')
      // @ts-expect-error — `session` (and therefore `session.client`, the raw handle) must not be reachable.
      void tx.session
    })
  })

  it('db.transaction: a nested transaction (SAVEPOINT) hands the callback the same checked handle', () => {
    const db = seedDb()
    const { layer, tag } = makeModuleDb(contentManifest, db, contentTables)
    const svc = getService(layer, tag)

    svc.db.transaction((tx) => {
      tx.insert(posts).values({ title: 'outer' }).run()
      tx.transaction((nested) => {
        nested.insert(posts).values({ title: 'nested' }).run()
        // The nested handle is checked too — not the raw savepoint tx.
        expect(() => nested.select().from(mediaFiles).all()).toThrow(OwnershipViolation)
      })
    })
    expect(svc.db.select().from(posts).all().map((r) => (r as { title: string }).title).sort())
      .toEqual(['nested', 'outer'])
  })
})
