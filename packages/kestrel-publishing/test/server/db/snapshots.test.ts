import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desiredSchema, diffSchema, renderSqlite } from '@kestrel/core'
import { publishedSnapshots, recordSnapshot, republishSnapshot, retractSnapshot, currentSnapshot, ensureSnapshotTriggers, type SnapshotsDb } from '../../../src/server/db/snapshots.js'

/**
 * Coverage for the demote+insert transaction (rollback safety) and `ensureSnapshotTriggers` (portable
 * trigger provisioning for a consumer layer whose table only ever comes from the schema engine, never
 * the committed migration).
 *
 * This suite exercises `snapshots.ts`'s functions directly against a raw, unwrapped, migrated drizzle
 * instance (unchecked — no `<Module>Db` ownership adapter, on purpose: it's the pure-logic/trigger suite,
 * not the ownership suite). `SnapshotsDb` is branded so a raw handle no longer satisfies it structurally —
 * `migratedDb()`'s cast is the one place that deliberately steps around that, mirroring
 * `record-ref-index.test.ts`'s own `asContentDb` helper.
 */

const migrationsFolder = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)), 'server/database/migrations')

function migratedDb(): SnapshotsDb {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  return db as unknown as SnapshotsDb
}

function sqliteClientOf(db: SnapshotsDb): Database.Database {
  return (db as unknown as { $client: Database.Database }).$client
}

function fixturePayload(n: number): { html: string; media: string[] } {
  return { html: `<p>v${n}</p>`, media: [`media:${n}`] }
}

describe('supersedeAndInsert — demote+insert is one transaction', () => {
  it('an insert that fails after the demote leaves NOTHING changed: the old row is still current, no new row exists', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    const first = recordSnapshot(db, { route: '/a', payload: fixturePayload(1), fingerprint: 'f1' })

    // A test-only trigger that aborts exactly the insert `recordSnapshot`'s second call will attempt —
    // simulating a real insert failure (disk full, SQLITE_BUSY, a killed process) at the same point.
    client.exec(`
      CREATE TRIGGER force_fail_insert BEFORE INSERT ON published_snapshots
      WHEN NEW.fingerprint = 'FORCE_FAIL'
      BEGIN SELECT RAISE(ABORT, 'forced failure for test'); END;
    `)

    expect(() => recordSnapshot(db, { route: '/a', payload: fixturePayload(2), fingerprint: 'FORCE_FAIL' })).toThrow()

    const rows = client.prepare('SELECT id, route, superseded_by FROM published_snapshots').all() as
      { id: number; route: string; superseded_by: number | null }[]
    expect(rows).toHaveLength(1) // no new row was left behind
    expect(rows[0]).toEqual({ id: first.id, route: '/a', superseded_by: null }) // the old row is untouched — still current
  })
})

describe('supersedeAndInsert — publishedAt stays strictly monotonic across a chain', () => {
  it('a same-millisecond supersede still gets a strictly later publishedAt than the row it replaces', () => {
    const db = migratedDb()
    const first = recordSnapshot(db, { route: '/a', payload: fixturePayload(1), fingerprint: 'f1' })
    const second = recordSnapshot(db, { route: '/a', payload: fixturePayload(2), fingerprint: 'f2' })
    expect(second.publishedAt.getTime()).toBeGreaterThan(first.publishedAt.getTime())
  })
})

describe('TRIGGER_DDL stays in step with 0017_published_snapshots.sql', () => {
  function normalizedTriggerSql(client: Database.Database): Record<string, string> {
    const rows = client.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as { name: string; sql: string }[]
    const out: Record<string, string> = {}
    // Backtick-quoting an identifier vs not, and whitespace/indentation, are not semantic differences —
    // strip both before comparing, so this test pins the DDL's MEANING, not its formatting.
    for (const { name, sql } of rows) out[name] = sql.replace(/`/g, '').replace(/\s+/g, ' ').trim()
    return out
  }

  it('the migrated db\'s triggers and ensureSnapshotTriggers\'s triggers are the same set, semantically identical', () => {
    const migrated = sqliteClientOf(migratedDb())

    const sqlite = new Database(':memory:')
    const desired = desiredSchema([publishedSnapshots])
    for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
    ensureSnapshotTriggers(sqlite)

    expect(normalizedTriggerSql(sqlite)).toEqual(normalizedTriggerSql(migrated))
  })
})

describe('republishSnapshot — no-op when fromId is already the route\'s current row', () => {
  it('republishing the current row returns it unchanged and writes nothing new', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    const current = recordSnapshot(db, { route: '/a', payload: fixturePayload(1), fingerprint: 'f1' })

    const result = republishSnapshot(db, { fromId: current.id })

    expect(result.id).toBe(current.id)
    const rows = client.prepare('SELECT id FROM published_snapshots').all()
    expect(rows).toHaveLength(1)
  })
})

describe('retractSnapshot — demotes the current row without touching history', () => {
  it('after retraction, currentSnapshot returns null but the row survives with retractedAt set', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    const head = recordSnapshot(db, { route: '/a', payload: fixturePayload(1), fingerprint: 'f1' })

    const retracted = retractSnapshot(db, '/a')

    expect(retracted?.id).toBe(head.id)
    expect(currentSnapshot(db, '/a')).toBeNull()
    const row = client.prepare('SELECT superseded_by, retracted_at FROM published_snapshots WHERE id = ?').get(head.id) as
      { superseded_by: number | null; retracted_at: number | null }
    expect(row.superseded_by).toBeNull() // history untouched — retraction is not a supersede
    expect(row.retracted_at).not.toBeNull()
  })

  it('is a no-op when the route has no snapshot at all', () => {
    const db = migratedDb()
    expect(retractSnapshot(db, '/never-published')).toBeNull()
  })

  it('republishing a retracted route resumes the same chain (supersedes the retracted row)', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    const head = recordSnapshot(db, { route: '/a', payload: fixturePayload(1), fingerprint: 'f1' })
    retractSnapshot(db, '/a')

    const revived = recordSnapshot(db, { route: '/a', payload: fixturePayload(2), fingerprint: 'f2' })

    expect(currentSnapshot(db, '/a')).toMatchObject({ route: '/a' })
    const row = client.prepare('SELECT superseded_by FROM published_snapshots WHERE id = ?').get(head.id) as { superseded_by: number | null }
    expect(row.superseded_by).toBe(revived.id) // the retracted row is now history, not orphaned
  })

  // The DB-level trigger, not just application code, rejects a second retraction — mirrors the
  // supersede-once trigger's own coverage above.
  it('the retracted_at column rejects a second UPDATE at the DB level', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    const head = recordSnapshot(db, { route: '/a', payload: fixturePayload(1), fingerprint: 'f1' })
    retractSnapshot(db, '/a')

    expect(() => client.prepare('UPDATE published_snapshots SET retracted_at = ? WHERE id = ?').run(Date.now() + 1000, head.id)).toThrow()
  })
})

describe('ensureSnapshotTriggers — portable provisioning for a schema-engine-provisioned table', () => {
  function engineProvisionedDb(): Database.Database {
    // No migration involved: the same path a consumer layer's boot takes (`#kestrel/schema-tables` +
    // the schema engine), which never reaches `0017_published_snapshots.sql`.
    const sqlite = new Database(':memory:')
    const desired = desiredSchema([publishedSnapshots])
    for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
    return sqlite
  }

  function insertRow(client: Database.Database, route: string, fingerprint: string): number {
    const info = client.prepare('INSERT INTO published_snapshots (route, payload, fingerprint, published_at, superseded_by) VALUES (?, ?, ?, ?, NULL)')
      .run(route, JSON.stringify(fixturePayload(1)), fingerprint, Date.now())
    return Number(info.lastInsertRowid)
  }

  it('a schema-engine-provisioned table has NO trigger protection before ensureSnapshotTriggers runs', () => {
    const client = engineProvisionedDb()
    const id = insertRow(client, '/a', 'f1')
    // Pins the premise this function exists to fix: the schema engine renders columns/indexes but never
    // triggers, so an UPDATE succeeds here — unlike the same statement against a migrated db.
    expect(() => client.prepare('UPDATE published_snapshots SET payload = ? WHERE id = ?').run('{}', id)).not.toThrow()
  })

  it('after ensureSnapshotTriggers, the UPDATE-rejection matrix passes identically to a migrated db', () => {
    const client = engineProvisionedDb()
    ensureSnapshotTriggers(client)
    const id = insertRow(client, '/a', 'f1')
    const second = insertRow(client, '/b', 'f2') // distinct route: the partial unique index on /a stays untouched

    expect(() => client.prepare('UPDATE published_snapshots SET payload = ? WHERE id = ?').run(JSON.stringify(fixturePayload(9)), id)).toThrow()
    expect(() => client.prepare('UPDATE published_snapshots SET route = ? WHERE id = ?').run('/z', id)).toThrow()
    expect(() => client.prepare('UPDATE published_snapshots SET fingerprint = ? WHERE id = ?').run('f9', id)).toThrow()
    expect(() => client.prepare('UPDATE published_snapshots SET published_at = ? WHERE id = ?').run(Date.now() + 1000, id)).toThrow()
    expect(() => client.prepare('UPDATE published_snapshots SET superseded_by = ? WHERE id = ?').run(second, id)).not.toThrow()
    expect(() => client.prepare('UPDATE published_snapshots SET superseded_by = ? WHERE id = ?').run(second, id)).toThrow() // already set once
  })

  it('is idempotent — calling it twice does not error', () => {
    const client = engineProvisionedDb()
    ensureSnapshotTriggers(client)
    expect(() => ensureSnapshotTriggers(client)).not.toThrow()
  })

  it('tolerates the table not existing yet instead of crashing', () => {
    const sqlite = new Database(':memory:') // no table at all
    expect(() => ensureSnapshotTriggers(sqlite)).not.toThrow()
  })

  it('rejects a self-pointer even from NULL', () => {
    const client = engineProvisionedDb()
    ensureSnapshotTriggers(client)
    const id = insertRow(client, '/a', 'f1')
    expect(() => client.prepare('UPDATE published_snapshots SET superseded_by = ? WHERE id = ?').run(id, id)).toThrow()
  })
})
