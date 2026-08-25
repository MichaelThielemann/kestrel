import { describe, it, expect } from 'vitest'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { createTestDb } from '../helpers/db'
import {
  buildContentManifest, clearRegistry, create, desiredSchema, ensureOutboxTable, getOne, isDestructive,
  planOps, readOutbox, registerCollection, runWrite, setStatusMany, sqliteClientOf, syncSchema, update,
  ensureRevisionsTable, revisionsTableName, revisionsTable, readRevisions, rebuildFromRevisions,
} from '@kestrel/core'
import { pagesCollection } from '@kestrel/collections'
import postsCollection from '../../server/collections/posts'

/**
 * Contract tests for append-only revisions (revisions table + eager current-row materialization).
 * DELETE (tombstones) is later work — no delete-shape assertions here.
 *
 * Surface under test:
 *   revisionsTableName(collection) => `<collection>_revisions`
 *   ensureRevisionsTable(sqlite, collection) => idempotent CREATE TABLE IF NOT EXISTS, columns:
 *     record_id INTEGER, revision INTEGER, snapshot TEXT/json, schema_version, correlation_id, created_at
 *   readRevisions(db, collection, recordId) => RevisionRow[] ordered by revision ascending, snapshot
 *     already JSON-decoded
 *   rebuildFromRevisions(db, collection, recordId) => restores/returns the current row from the last
 *     revision's snapshot
 *
 * Working assumption: `snapshot` deep-equals the exact row `create`/`update` returns (the full persisted
 * record, not just the pre-persist validated input) — this is what makes rebuild ("row deep-equal to the
 * last revision snapshot") a meaningful claim.
 */

type Row = Record<string, unknown>

function colNames(sqlite: Database.Database, table: string): string[] {
  return (sqlite.pragma(`table_info("${table}")`) as { name: string }[]).map((c) => c.name)
}

function seed(): BetterSQLite3Database {
  clearRegistry()
  registerCollection(pagesCollection)
  registerCollection(postsCollection)
  const db = createTestDb()
  const client = sqliteClientOf(db)
  ensureOutboxTable(client, 'content')
  ensureRevisionsTable(client, 'pages')
  ensureRevisionsTable(client, 'posts')
  return db
}

describe('revisions: table shape + manifest join', () => {
  it('revisionsTableName follows the <collection>_revisions convention', () => {
    expect(revisionsTableName('pages')).toBe('pages_revisions')
    expect(revisionsTableName('posts')).toBe('posts_revisions')
  })

  it('ensureRevisionsTable creates the contract columns, idempotently', () => {
    const db = seed()
    const client = sqliteClientOf(db)
    const cols = colNames(client, revisionsTableName('pages'))
    for (const col of ['record_id', 'revision', 'snapshot', 'schema_version', 'correlation_id', 'created_at']) {
      expect(cols).toContain(col)
    }
    expect(() => ensureRevisionsTable(client, 'pages')).not.toThrow()
    expect(colNames(client, revisionsTableName('pages'))).toEqual(cols)
  })

  it('a registered collection\'s revisions table joins the content ownership manifest', () => {
    seed()
    const manifest = buildContentManifest()
    expect(manifest.tables).toContain(revisionsTableName('pages'))
    expect(manifest.tables).toContain(revisionsTableName('posts'))
  })

  it('the real schema-sync pipeline upgrades a pre-existing non-unique (record_id, revision) index to '
    + 'UNIQUE additively — no force/allowDestructive needed, and it rejects a duplicate afterward', () => {
    // Simulates a dev DB that already ran an older build of this table shape (a plain, non-unique index)
    // before the index became UNIQUE — the real regression this probe rules out, not just a unit-level
    // diff-engine claim. `seed()` (not a bare `createTestDb()`) so `pages_revisions` actually exists to
    // regress, independent of what any earlier test in this file happened to register.
    const client = sqliteClientOf(seed())
    const name = revisionsTableName('pages')
    client.exec(`DROP INDEX IF EXISTS ${name}_record`)
    client.exec(`CREATE INDEX ${name}_record ON ${name} (record_id, revision)`)
    client.prepare(
      `INSERT INTO ${name} (record_id, revision, snapshot, schema_version, correlation_id, created_at) VALUES (1, 1, '{}', 1, 'c', 'now')`,
    ).run()

    // Scoped to `name` alone (like the per-module migration task's own `opts.tables`) — every OTHER real
    // table in this db (pages, posts, media, outbox_content, …) is legitimately absent from this narrow
    // `desired` and must not register as a spurious drop_table.
    const desired = desiredSchema([revisionsTable('pages')])
    const pending = planOps(client, desired).filter((op) => op.type !== 'drop_table')
    expect(pending.every((op) => !isDestructive(op))).toBe(true) // additive only: no force required

    const { applied, skipped } = syncSchema(client, desired, { tables: [name] })
    expect(skipped).toEqual([])
    expect(applied.length).toBeGreaterThan(0)

    // The upgrade took effect: a second (record_id, revision) = (1, 1) row now violates UNIQUE.
    expect(() => client.prepare(
      `INSERT INTO ${name} (record_id, revision, snapshot, schema_version, correlation_id, created_at) VALUES (1, 1, '{}', 1, 'c', 'now')`,
    ).run()).toThrowError(/UNIQUE/)
  })
})

describe('revisions: eager append — createOne / updateOne', () => {
  it('createOne leaves exactly one new revision: revision 1, snapshot = the created record, matching correlation/timing', () => {
    const db = seed()
    const row = create(db, pagesCollection, { title: 'Hello', path: '/hello', status: 'draft' }) as Row

    const revisions = readRevisions(db, 'pages', row.id as number)
    expect(revisions).toHaveLength(1)
    const rev = revisions[0]!
    expect(rev.revision).toBe(1)
    expect(rev.recordId).toBe(row.id)
    expect(rev.snapshot).toEqual(row)

    const outboxRows = readOutbox(db, 'content')
    expect(outboxRows).toHaveLength(1)
    expect(rev.correlationId).toBe(outboxRows[0]!.envelope.correlationId)
    expect(rev.createdAt).toBe(new Date(row.createdAt as string | number | Date).toISOString())
  })

  it('updateOne appends revision 2, snapshot = the updated record, createdAt = the write\'s updatedAt', () => {
    const db = seed()
    const row = create(db, pagesCollection, { title: 'Hello', path: '/hello', status: 'draft' }) as Row
    const updated = update(db, pagesCollection, row.id as number, { title: 'Hello v2' }) as Row

    const revisions = readRevisions(db, 'pages', row.id as number)
    expect(revisions).toHaveLength(2)
    expect(revisions.map((r) => r.revision)).toEqual([1, 2])
    const rev2 = revisions[1]!
    expect(rev2.snapshot).toEqual(updated)
    expect(rev2.createdAt).toBe(new Date(updated.updatedAt as string | number | Date).toISOString())
  })
})

describe('revisions: eager append — createMany / updateMany (batch shapes)', () => {
  it('createMany appends exactly one revision (revision 1) per created record', () => {
    const db = seed()
    const rows = runWrite<Row[]>('createMany', {
      collection: pagesCollection,
      db,
      input: [
        { title: 'A', path: '/a', status: 'draft' },
        { title: 'B', path: '/b', status: 'draft' },
      ],
    })
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const revisions = readRevisions(db, 'pages', row.id as number)
      expect(revisions).toHaveLength(1)
      expect(revisions[0]!.revision).toBe(1)
      expect(revisions[0]!.snapshot).toEqual(row)
    }
  })

  it('updateMany\'s revision 2 snapshot is the synthesized {...before, ...patch} row — no RETURNING on a '
    + 'batch statement (see persist.ts), so this is honestly NOT a re-read of the stored row, unlike every '
    + 'other shape in this file', () => {
    const db = seed()
    const a = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    const b = create(db, pagesCollection, { title: 'B', path: '/b', status: 'draft' }) as Row

    setStatusMany(db, pagesCollection, [a.id as number, b.id as number], 'published')

    for (const row of [a, b]) {
      const revisions = readRevisions(db, 'pages', row.id as number)
      expect(revisions).toHaveLength(2)
      expect(revisions.map((r) => r.revision)).toEqual([1, 2])
      const rev2 = revisions[1]!
      // Ground truth for `updatedAt` comes from an independent DB read of the CURRENT row, not from the
      // revision snapshot itself — the point of this assertion is to pin the snapshot's exact composition
      // (before-row fields + the patch, nothing else), not to re-derive updatedAt's own provenance (already
      // pinned by the createOne/updateOne tests above).
      const current = getOne(db, pagesCollection, row.id as number) as Row
      expect(rev2.snapshot).toEqual({ ...row, status: 'published', updatedAt: current.updatedAt })
    }
  })
})

describe('revisions: atomicity (load-bearing)', () => {
  it('a forced revisions-insert failure rolls back the record write too — same transaction', () => {
    const db = seed()
    const client = sqliteClientOf(db)
    client.exec(`DROP TABLE ${revisionsTableName('pages')}`)

    const before = (db.select().from(pagesCollection.table).all() as unknown[]).length
    expect(() => create(db, pagesCollection, { title: 'X', path: '/x', status: 'draft' })).toThrow()
    const after = (db.select().from(pagesCollection.table).all() as unknown[]).length
    expect(after).toBe(before)
  })

  it('a write whose persist fails (unique conflict) leaves zero new revision rows for that write', () => {
    const db = seed()
    create(db, pagesCollection, { title: 'A', path: '/dup', status: 'draft' })
    expect(() => create(db, pagesCollection, { title: 'B', path: '/dup', status: 'draft' })).toThrow()

    const client = sqliteClientOf(db)
    const count = (client.prepare(`SELECT COUNT(*) as c FROM ${revisionsTableName('pages')}`).get() as { c: number }).c
    expect(count).toBe(1) // only the successful create's revision
  })
})

describe('revisions: read model untouched', () => {
  it('the content table\'s own columns are unchanged by writes that also append revisions', () => {
    const db = seed()
    const client = sqliteClientOf(db)
    const before = colNames(client, 'pages')
    create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' })
    expect(colNames(client, 'pages')).toEqual(before)
  })

  it('a read of a written record carries no revision fields', () => {
    const db = seed()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    const read = getOne(db, pagesCollection, row.id as number)
    const keys = Object.keys(read)
    for (const forbidden of ['revision', 'snapshot', 'schemaVersion', 'schema_version', 'correlationId', 'correlation_id']) {
      expect(keys).not.toContain(forbidden)
    }
  })
})

describe('revisions: rebuild', () => {
  it('rebuildFromRevisions restores a deleted current row from the last revision snapshot', () => {
    const db = seed()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    const updated = update(db, pagesCollection, row.id as number, { title: 'A v2' }) as Row

    const client = sqliteClientOf(db)
    client.prepare('DELETE FROM pages WHERE id = ?').run(updated.id)
    expect(client.prepare('SELECT * FROM pages WHERE id = ?').get(updated.id)).toBeUndefined()

    const restored = rebuildFromRevisions(db, pagesCollection, updated.id as number)
    expect(restored).toEqual(updated)
    expect(client.prepare('SELECT * FROM pages WHERE id = ?').get(updated.id)).toBeTruthy()
  })
})

describe('revisions: sequence integrity', () => {
  it('two writes to the same record produce revisions 1,2 — no gaps, no duplicates', () => {
    const db = seed()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    update(db, pagesCollection, row.id as number, { title: 'A2' })

    expect(readRevisions(db, 'pages', row.id as number).map((r) => r.revision)).toEqual([1, 2])
  })

  it('writes to two different records keep independent, gapless sequences', () => {
    const db = seed()
    const a = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    const b = create(db, postsCollection, { title: 'B', status: 'draft' }) as Row
    update(db, pagesCollection, a.id as number, { title: 'A2' })
    update(db, postsCollection, b.id as number, { title: 'B2' })
    update(db, pagesCollection, a.id as number, { title: 'A3' })

    expect(readRevisions(db, 'pages', a.id as number).map((r) => r.revision)).toEqual([1, 2, 3])
    expect(readRevisions(db, 'posts', b.id as number).map((r) => r.revision)).toEqual([1, 2])
  })
})
