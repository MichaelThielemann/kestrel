import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { buildCollection, clearRegistry, create, defineCollection, desiredSchema, diffSchema, ensureOutboxTable, getOne, readRevisions, registerCollection, renderSqlite, revisionsTable, revisionsTableName, schemaVersionOf, sqliteClientOf  } from '@michaelthielemann/kestrel-core'
import type { BuiltCollection } from '@michaelthielemann/kestrel-core'
import { createTestDb } from '../helpers/db'
// DESIGN: a plain function in `layers/core/server/db/revision-migration.ts`, separate from the `defineTask`
// wrapper at `layers/core/server/tasks/db/migrate-revisions.ts` — mirrors the sync.ts (core)/migrate.ts
// (task) split `db:migrate` already uses, and is the only way this contract's per-collection-transaction /
// mid-run-failure / resumability points are unit-testable at all: `defineTask` and `useDb()` are
// Nitro-runtime globals, unavailable in this project's plain "node" vitest environment. The task wrapper
// itself is covered by the thin e2e smoke test in `test/e2e/migrate-revisions.test.ts`.
//
// Signature: `migrateRevisions(db: BetterSQLite3Database, opts: { force: boolean }):
// { collection: string; seeded: number; skipped: number }[]`. Mirrors `pruneAllDueRevisions`'s own style
// (iterates `allCollections()` from the registry itself, no explicit collection list parameter) rather than
// `db:migrate`'s `collections`-from-`#kestrel/collections`-import style — the registry is the thing that's
// actually reachable/testable outside a real Nuxt build.
//
// Gate: throws a plain `Error` naming the flag (`/force/i`) when `opts.force !== true`, rather than
// `db:migrate`'s silent skip-and-report — a data-seeding run (unlike a schema diff) has no meaningful
// partial/"skip just this part" shape to report. Same `{force:true}` flag name/value convention as
// `db:migrate`/`db:migrate-module`'s own payload.
//
// Scope: this task ASSUMES the `<collection>_revisions` tables already exist (provisioned by
// `db:migrate`/`db:migrate-module`, or dev's additive schema-sync) — it seeds ROWS, it does not create
// tables. Table creation lazily inside this task would blur the schema-migration/data-migration line the
// codebase otherwise keeps strict (see `revisions.ts`'s own TSDoc on why `ensureRevisionsTable` is never
// called lazily off a write path).
//
// Seeded revision fields: snapshot = the exact persisted row (deep-equal), schema_version =
// `schemaVersionOf(current def)`, tombstone = false, correlation_id = some constant migration marker (not
// asserted here — implementation detail), created_at = the row's own `updatedAt` (ISO), NOT migration
// wall-clock `now`. Pinned by analogy with the ordinary write path already proven in `revisions.test.ts`:
// `updateOne` stamps a revision's `createdAt` from the WRITE's `updatedAt`, not creation time — a seeded
// revision 1 is standing in for "the write that produced this row's current state", so the same field is
// the honest source.
//
// Mid-collection failure / resumability: one `db.transaction()` per collection (never one giant transaction
// spanning every collection) — a failure inside collection B's transaction rolls back ONLY B's attempted
// inserts (including ones already applied earlier in that same collection's loop); collection A's
// transaction already committed before B was even attempted, so A's seeds survive regardless. On failure the
// function PROPAGATES the error (does not swallow/continue to the next collection) — a re-run is how an
// operator resumes, and per-row idempotence (skip a record that already has a revision) is what makes that
// re-run safe rather than a silent partial-success report that could mask a real problem.
type Row = Record<string, unknown>

function widgetsCollection(): BuiltCollection {
  return buildCollection(defineCollection({
    name: 'widgets',
    mode: 'multi',
    translatable: false,
    fields: { title: { type: 'text', required: true } },
  }))
}

function gizmosCollection(): BuiltCollection {
  return buildCollection(defineCollection({
    name: 'gizmos',
    mode: 'multi',
    translatable: false,
    fields: { title: { type: 'text', required: true } },
  }))
}

/** Provisions content + revisions tables for every given collection (both, via the real schema-sync
 *  engine) and registers them — the DB state right after an operator has already run `db:migrate`/
 *  `db:migrate-module`, i.e. exactly what `db:migrate-revisions` is meant to run against. */
function seedDb(collections: BuiltCollection[]): BetterSQLite3Database {
  clearRegistry()
  const db = createTestDb()
  const tables = collections.flatMap((c) => [c.table, revisionsTable(c.name)])
  for (const stmt of renderSqlite(diffSchema(desiredSchema(tables), {}))) db.run(sql.raw(stmt))
  for (const c of collections) registerCollection(c)
  ensureOutboxTable(sqliteClientOf(db), 'content')
  return db
}

/** Inserts a row directly through drizzle, bypassing `create()`/the write pipeline entirely — no revision
 *  gets appended: an existing row with no revision history at all. */
function insertRawRow(db: BetterSQLite3Database, collection: BuiltCollection, title: string, createdAt: Date, updatedAt: Date): Row {
  return db.insert(collection.table).values({ title, createdAt, updatedAt } as never).returning().get() as Row
}

describe('db:migrate-revisions (core): explicit-flag gate', () => {
  it('refuses to run without the explicit flag, naming it', async () => {
    const { migrateRevisions } = await import('@michaelthielemann/kestrel-core')
    const widgets = widgetsCollection()
    const db = seedDb([widgets])
    insertRawRow(db, widgets, 'a', new Date('2020-01-01'), new Date('2020-01-02'))
    expect(() => migrateRevisions(db, { force: false })).toThrow(/force/i)
    // Refusing must not have silently seeded anyway.
    const rows = db.select().from(widgets.table).all() as Row[]
    expect(readRevisions(db, 'widgets', rows[0]!.id as number)).toHaveLength(0)
  })

  it('runs and seeds when the flag is explicitly set', async () => {
    const { migrateRevisions } = await import('@michaelthielemann/kestrel-core')
    const widgets = widgetsCollection()
    const db = seedDb([widgets])
    const row = insertRawRow(db, widgets, 'a', new Date('2020-01-01'), new Date('2020-01-02'))
    expect(() => migrateRevisions(db, { force: true })).not.toThrow()
    expect(readRevisions(db, 'widgets', row.id as number)).toHaveLength(1)
  })
})

describe('db:migrate-revisions (core): missing-revisions-table pre-check', () => {
  it('a missing revisions table on ANY registered collection refuses the whole run up front, naming '
    + 'db:migrate as the remedy, never leaking a raw "no such table" — and seeds nothing at all, not even '
    + 'for a collection whose own table is fine', async () => {
    const { migrateRevisions } = await import('@michaelthielemann/kestrel-core')
    clearRegistry()
    const widgets = widgetsCollection()
    const gizmos = gizmosCollection()
    const db = createTestDb()
    // widgets: content + revisions tables, fully provisioned. gizmos: content table only — simulates an
    // install where db:migrate/db:migrate-module hasn't provisioned gizmos' revisions table yet.
    for (const stmt of renderSqlite(diffSchema(desiredSchema([widgets.table, revisionsTable('widgets'), gizmos.table]), {}))) {
      db.run(sql.raw(stmt))
    }
    registerCollection(widgets)
    registerCollection(gizmos)
    ensureOutboxTable(sqliteClientOf(db), 'content')
    const w = insertRawRow(db, widgets, 'a', new Date('2020-01-01'), new Date('2020-01-01'))

    let caught: unknown
    try {
      migrateRevisions(db, { force: true })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/db:migrate/)
    expect((caught as Error).message).not.toMatch(/no such table/i)

    // Fail-up-front: widgets (whose own revisions table is fine) got zero seeds too — the pre-check runs
    // for every collection BEFORE any seeding starts, not discovered mid-run after widgets already committed.
    expect(readRevisions(db, 'widgets', w.id as number)).toHaveLength(0)
  })
})

describe('db:migrate-revisions (core): seeding semantics', () => {
  it('seeds revision 1 = the full persisted row, schema_version from the current def, tombstone false, '
    + 'created_at = the row\'s own updatedAt (not migration wall-clock)', async () => {
    const { migrateRevisions } = await import('@michaelthielemann/kestrel-core')
    const widgets = widgetsCollection()
    const db = seedDb([widgets])
    const createdAt = new Date('2020-01-01T00:00:00.000Z')
    const updatedAt = new Date('2020-06-01T00:00:00.000Z')
    const row = insertRawRow(db, widgets, 'Hello', createdAt, updatedAt)

    migrateRevisions(db, { force: true })

    const revisions = readRevisions(db, 'widgets', row.id as number)
    expect(revisions).toHaveLength(1)
    const rev = revisions[0]!
    expect(rev.revision).toBe(1)
    expect(rev.recordId).toBe(row.id)
    expect(rev.snapshot).toEqual(row)
    expect(rev.schemaVersion).toBe(schemaVersionOf(widgets.def))
    expect(rev.tombstone).toBe(false)
    expect(rev.createdAt).toBe(updatedAt.toISOString())
  })

  it('seeds one revision 1 per existing row, independently, across multiple rows in one collection', async () => {
    const { migrateRevisions } = await import('@michaelthielemann/kestrel-core')
    const widgets = widgetsCollection()
    const db = seedDb([widgets])
    const a = insertRawRow(db, widgets, 'a', new Date('2020-01-01'), new Date('2020-01-01'))
    const b = insertRawRow(db, widgets, 'b', new Date('2020-01-02'), new Date('2020-01-02'))
    const c = insertRawRow(db, widgets, 'c', new Date('2020-01-03'), new Date('2020-01-03'))

    migrateRevisions(db, { force: true })

    for (const row of [a, b, c]) {
      const revisions = readRevisions(db, 'widgets', row.id as number)
      expect(revisions).toHaveLength(1)
      expect(revisions[0]!.snapshot).toEqual(row)
    }
  })
})

describe('db:migrate-revisions (core): one transaction per collection, resumable', () => {
  const POISON_TABLE_SQL = (name: string, blockedId: number): string => `CREATE TABLE ${name} (
    record_id INTEGER NOT NULL CHECK (record_id != ${blockedId}),
    revision INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    tombstone INTEGER NOT NULL DEFAULT 0
  )`

  /** widgets: normally provisioned (content + revisions tables), two pre-existing rows.
   *  gizmos: content table only, plus a HAND-BUILT revisions table whose CHECK constraint rejects the
   *  second row's id — forces the seeding INSERT for that row to fail partway through gizmos' own
   *  transaction, without touching widgets or needing to interrupt anything mid-flight. */
  function poisonedFixture() {
    clearRegistry()
    const widgets = widgetsCollection()
    const gizmos = gizmosCollection()
    const db = createTestDb()
    for (const stmt of renderSqlite(diffSchema(desiredSchema([widgets.table, revisionsTable('widgets'), gizmos.table]), {}))) {
      db.run(sql.raw(stmt))
    }
    registerCollection(widgets)
    registerCollection(gizmos)
    ensureOutboxTable(sqliteClientOf(db), 'content')

    const wa = insertRawRow(db, widgets, 'wa', new Date('2020-01-01'), new Date('2020-01-01'))
    const wb = insertRawRow(db, widgets, 'wb', new Date('2020-01-02'), new Date('2020-01-02'))
    const ga = insertRawRow(db, gizmos, 'ga', new Date('2020-01-01'), new Date('2020-01-01'))
    const gb = insertRawRow(db, gizmos, 'gb', new Date('2020-01-02'), new Date('2020-01-02'))

    sqliteClientOf(db).exec(POISON_TABLE_SQL(revisionsTableName('gizmos'), gb.id as number))

    return { db, widgets, gizmos, wa, wb, ga, gb }
  }

  function unpoison(db: BetterSQLite3Database) {
    const client = sqliteClientOf(db)
    client.exec(`DROP TABLE ${revisionsTableName('gizmos')}`)
    for (const stmt of renderSqlite(diffSchema(desiredSchema([revisionsTable('gizmos')]), {}))) db.run(sql.raw(stmt))
  }

  it('a mid-collection failure rolls back that collection\'s seeds entirely, leaving an earlier '
    + 'collection\'s already-committed seeds untouched', async () => {
    const { migrateRevisions } = await import('@michaelthielemann/kestrel-core')
    const { db, wa, wb, ga } = poisonedFixture()

    expect(() => migrateRevisions(db, { force: true })).toThrow()

    // widgets processed (and committed) before gizmos was ever attempted.
    expect(readRevisions(db, 'widgets', wa.id as number)).toHaveLength(1)
    expect(readRevisions(db, 'widgets', wb.id as number)).toHaveLength(1)

    // gizmos' transaction rolled back completely — including the row that would have succeeded on its own.
    expect(readRevisions(db, 'gizmos', ga.id as number)).toHaveLength(0)
    const total = sqliteClientOf(db).prepare(`SELECT COUNT(*) as n FROM ${revisionsTableName('gizmos')}`).get() as { n: number }
    expect(total.n).toBe(0)
  })

  it('is resumable: fixing the failure and re-running completes the failed collection without '
    + 'duplicating the collection that already succeeded', async () => {
    const { migrateRevisions } = await import('@michaelthielemann/kestrel-core')
    const { db, wa, wb, ga, gb } = poisonedFixture()

    expect(() => migrateRevisions(db, { force: true })).toThrow()
    unpoison(db)
    expect(() => migrateRevisions(db, { force: true })).not.toThrow()

    expect(readRevisions(db, 'widgets', wa.id as number)).toHaveLength(1) // still exactly one — not duplicated
    expect(readRevisions(db, 'widgets', wb.id as number)).toHaveLength(1)
    expect(readRevisions(db, 'gizmos', ga.id as number)).toHaveLength(1)
    expect(readRevisions(db, 'gizmos', gb.id as number)).toHaveLength(1)
  })
})

describe('db:migrate-revisions (core): rerun is a no-op', () => {
  it('a second run after a clean completion changes nothing — no revision-2s appear, counts identical', async () => {
    const { migrateRevisions } = await import('@michaelthielemann/kestrel-core')
    const widgets = widgetsCollection()
    const db = seedDb([widgets])
    const a = insertRawRow(db, widgets, 'a', new Date('2020-01-01'), new Date('2020-01-01'))
    const b = insertRawRow(db, widgets, 'b', new Date('2020-01-02'), new Date('2020-01-02'))

    const first = migrateRevisions(db, { force: true })
    expect(first.find((r) => r.collection === 'widgets')?.seeded).toBe(2)

    const second = migrateRevisions(db, { force: true })
    expect(second.find((r) => r.collection === 'widgets')?.seeded).toBe(0)

    expect(readRevisions(db, 'widgets', a.id as number)).toHaveLength(1)
    expect(readRevisions(db, 'widgets', b.id as number)).toHaveLength(1)
    const total = sqliteClientOf(db).prepare(`SELECT COUNT(*) as n FROM ${revisionsTableName('widgets')}`).get() as { n: number }
    expect(total.n).toBe(2)
  })
})

describe('db:migrate-revisions (core): reads identical before/after', () => {
  it('row counts and a representative read are byte-identical pre/post migration', async () => {
    const { migrateRevisions } = await import('@michaelthielemann/kestrel-core')
    const widgets = widgetsCollection()
    const db = seedDb([widgets])
    const a = insertRawRow(db, widgets, 'a', new Date('2020-01-01'), new Date('2020-01-01'))
    const b = insertRawRow(db, widgets, 'b', new Date('2020-01-02'), new Date('2020-01-02'))

    const countBefore = (sqliteClientOf(db).prepare(`SELECT COUNT(*) as n FROM widgets`).get() as { n: number }).n
    const readBefore = getOne(db, widgets, a.id as number) as Row

    migrateRevisions(db, { force: true })

    const countAfter = (sqliteClientOf(db).prepare(`SELECT COUNT(*) as n FROM widgets`).get() as { n: number }).n
    const readAfter = getOne(db, widgets, a.id as number) as Row
    expect(countAfter).toBe(countBefore)
    expect(readAfter).toEqual(readBefore)
    expect(readAfter).toEqual(a)
    void b
  })
})

describe('db:migrate-revisions (core): rows already carrying a revision from the ordinary write path', () => {
  it('a row written after Phase-6 code (already has revision 1 from persist) is not double-seeded', async () => {
    const { migrateRevisions } = await import('@michaelthielemann/kestrel-core')
    const widgets = widgetsCollection()
    const db = seedDb([widgets])
    const created = create(db, widgets, { title: 'already seeded' }) as Row
    expect(readRevisions(db, 'widgets', created.id as number)).toHaveLength(1)

    migrateRevisions(db, { force: true })

    const revisions = readRevisions(db, 'widgets', created.id as number)
    expect(revisions).toHaveLength(1)
    expect(revisions[0]!.revision).toBe(1)
    expect(revisions[0]!.snapshot).toEqual(created)
  })
})

describe('db:migrate-revisions (core): deleted-record ghosts', () => {
  it('only seeds rows that still exist — a gap from a long-gone delete gets no fabricated tombstone', async () => {
    const { migrateRevisions } = await import('@michaelthielemann/kestrel-core')
    const widgets = widgetsCollection()
    const db = seedDb([widgets])
    const keep = insertRawRow(db, widgets, 'keep', new Date('2020-01-01'), new Date('2020-01-01'))
    const ghost = insertRawRow(db, widgets, 'ghost', new Date('2020-01-01'), new Date('2020-01-01'))
    // Simulates a legacy install where this row was deleted long ago — no trace left anywhere.
    sqliteClientOf(db).prepare(`DELETE FROM widgets WHERE id = ?`).run(ghost.id)

    migrateRevisions(db, { force: true })

    const client = sqliteClientOf(db)
    const total = client.prepare(`SELECT COUNT(*) as n FROM ${revisionsTableName('widgets')}`).get() as { n: number }
    expect(total.n).toBe(1)
    const tombstones = client.prepare(`SELECT COUNT(*) as n FROM ${revisionsTableName('widgets')} WHERE tombstone = 1`).get() as { n: number }
    expect(tombstones.n).toBe(0)
    expect(readRevisions(db, 'widgets', keep.id as number)).toHaveLength(1)
  })
})
