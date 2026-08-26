import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { Effect, type Layer, type Context } from 'effect'
import { OwnershipViolation, desiredSchema, diffSchema, makeModuleDb, recordRefs, renderSqlite } from '@michaelthielemann/kestrel-core'
import type { ModuleDbService } from '@michaelthielemann/kestrel-core'
import { publishingOwnershipManifest, type SnapshotsDb } from '@michaelthielemann/kestrel-publishing'
/**
 * Contract tests for the snapshot store + DeliveryPort wiring.
 *
 * File/module: `layers/public/server/db/snapshots.ts` exports the `publishedSnapshots` drizzle table plus
 * two write functions this suite requires to exist:
 *   - `recordSnapshot(db, { route, payload, fingerprint }): SnapshotRow` — a publish writes through this.
 *     Unchanged fingerprint for the route's current row is a no-op (returns the existing current row, no
 *     new insert); a changed fingerprint inserts a new row and flips the previous current row's
 *     `supersededBy` to the new row's id.
 *   - `republishSnapshot(db, { fromId }): SnapshotRow` — rollback-by-pointer. Reads the row at `fromId`
 *     (current or already-superseded) and creates a NEW current row with the same route/payload/
 *     fingerprint (content-equal), a fresh id and `publishedAt`; the referenced old row is never mutated
 *     beyond the ordinary supersede-pointer flip its own current-ness may still owe.
 *
 * Unchanged-content behavior: unchanged fingerprint = no new row is the pinned default; a design that
 * always inserts (dedupe out of scope) would need this test updated.
 *
 * Insert-only enforcement is pinned at the DB level via a hand-authored SQLite trigger — the drizzle
 * schema-render engine has no trigger concept (`layers/core/server/db/module-db.ts` explicitly lists
 * `CREATE TRIGGER` as DDL its own scan does not special-case).
 *
 * `PublishedSnapshot`'s struct shape is still the placeholder `Schema.Record({ key: Schema.String, value:
 * Schema.Unknown })` brand (see `packages/kestrel-contracts/src/brands.ts`), so this suite builds fixture
 * payloads as plain records and never asserts a specific field name inside the payload — it pins the
 * CONTAINER's behavior (route/fingerprint/supersede chain), not the payload's struct.
 *
 * Contract C is pinned at the snapshot store's own write API (`recordSnapshot`), not through
 * `startPublishRun`/the real publish flow: `layers/public/server/utils/publish/orchestrator.ts`'s
 * `snapshot` step is a documented placeholder, and the real publish command lives in `publisher.ts`.
 *
 * Migration numbering: `0017_published_snapshots.sql`, following `0016_publish_runs.sql`.
 */

const migrationsFolder = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'server/database/migrations')

function migratedDb(): BetterSQLite3Database {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  return db
}

function sqliteClientOf(db: BetterSQLite3Database): Database.Database {
  return (db as unknown as { $client: Database.Database }).$client
}

function getService<I, A>(layer: Layer.Layer<I>, tag: Context.Tag<I, A>): A {
  return Effect.runSync(Effect.scoped(Effect.provide(tag, layer)))
}

function fixturePayload(n: number): Record<string, unknown> {
  return { html: `<p>v${n}</p>`, media: [`media:${n}`] }
}

describe('published_snapshots table (static, 4-place parity)', () => {
  it('the drizzle table module exports publishedSnapshots with the contracted columns', async () => {
    const mod = await import('@michaelthielemann/kestrel-publishing')
    expect(mod.publishedSnapshots).toBeDefined()
  })

  it('desired schema for publishedSnapshots renders and diffs clean against a fresh db (schema-engine parity)', async () => {
    const { publishedSnapshots } = await import('@michaelthielemann/kestrel-publishing')
    const desired = desiredSchema([publishedSnapshots])
    const sqlite = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
    expect(() => sqlite.prepare('SELECT id, route, payload, fingerprint, published_at, superseded_by FROM published_snapshots').all()).not.toThrow()
  })

  it('a committed migration creates published_snapshots with the same shape the schema engine produces', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    expect(() => client.prepare('SELECT id, route, payload, fingerprint, published_at, superseded_by FROM published_snapshots').all()).not.toThrow()
  })

  it('server/database/schema.ts re-exports publishedSnapshots', async () => {
    const schema = await import('../../server/database/schema.ts')
    expect((schema as Record<string, unknown>).publishedSnapshots).toBeDefined()
  })

  it('the publishing manifest owns published_snapshots alongside publish_deps/publish_runs/publish_status', () => {
    expect([...publishingOwnershipManifest.tables].sort()).toEqual(
      ['publish_deps', 'publish_runs', 'publish_status', 'published_snapshots'].sort(),
    )
  })

  it('own-table access to published_snapshots succeeds through the module-db adapter', async () => {
    const { publishedSnapshots } = await import('@michaelthielemann/kestrel-publishing')
    const sqlite = new Database(':memory:')
    const desired = desiredSchema([publishedSnapshots])
    for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
    const { layer, tag } = makeModuleDb(publishingOwnershipManifest, sqlite, { published_snapshots: publishedSnapshots })
    const svc: ModuleDbService = getService(layer, tag)

    expect(() => svc.db.insert(svc.tables.published_snapshots as typeof publishedSnapshots)
      .values({ route: '/a', payload: JSON.stringify(fixturePayload(1)), fingerprint: 'f1' }).run()).not.toThrow()
  })

  it('a cross-module raw-SQL access to published_snapshots throws OwnershipViolation', async () => {
    const { publishedSnapshots } = await import('@michaelthielemann/kestrel-publishing')
    const sqlite = new Database(':memory:')
    const desired = desiredSchema([publishedSnapshots, recordRefs])
    for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
    const { layer, tag } = makeModuleDb(publishingOwnershipManifest, sqlite, { published_snapshots: publishedSnapshots })
    const svc: ModuleDbService = getService(layer, tag)

    try {
      svc.db.prepare('SELECT * FROM record_refs').all()
      expect.fail('expected OwnershipViolation')
    } catch (err) {
      expect(err).toBeInstanceOf(OwnershipViolation)
    }
  })

  it('an index supports the current-snapshot-per-route lookup (route, superseded_by)', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    const indexList = client.prepare("PRAGMA index_list('published_snapshots')").all() as { name: string }[]
    const indexedCols = indexList.flatMap((idx) =>
      (client.prepare(`PRAGMA index_info('${idx.name}')`).all() as { name: string }[]).map((c) => c.name),
    )
    expect(indexedCols).toContain('route')
  })

  it('the current-pointer invariant: at most one row per route with superseded_by IS NULL is enforceable at the DB level', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    client.prepare('INSERT INTO published_snapshots (route, payload, fingerprint, published_at, superseded_by) VALUES (?, ?, ?, ?, NULL)')
      .run('/a', JSON.stringify(fixturePayload(1)), 'f1', Date.now())

    expect(() => {
      client.prepare('INSERT INTO published_snapshots (route, payload, fingerprint, published_at, superseded_by) VALUES (?, ?, ?, ?, NULL)')
        .run('/a', JSON.stringify(fixturePayload(2)), 'f2', Date.now())
    }).toThrow()
  })
})

describe('snapshot rows are insert-only except the superseded_by pointer', () => {
  function insertRow(client: Database.Database, route: string, fingerprint: string): number {
    const info = client.prepare('INSERT INTO published_snapshots (route, payload, fingerprint, published_at, superseded_by) VALUES (?, ?, ?, ?, NULL)')
      .run(route, JSON.stringify(fixturePayload(1)), fingerprint, Date.now())
    return Number(info.lastInsertRowid)
  }

  it('an UPDATE attempt on payload fails loudly', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    const id = insertRow(client, '/a', 'f1')

    expect(() => client.prepare('UPDATE published_snapshots SET payload = ? WHERE id = ?').run(JSON.stringify(fixturePayload(9)), id)).toThrow()
  })

  it('an UPDATE attempt on route fails loudly', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    const id = insertRow(client, '/a', 'f1')

    expect(() => client.prepare('UPDATE published_snapshots SET route = ? WHERE id = ?').run('/b', id)).toThrow()
  })

  it('an UPDATE attempt on fingerprint fails loudly', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    const id = insertRow(client, '/a', 'f1')

    expect(() => client.prepare('UPDATE published_snapshots SET fingerprint = ? WHERE id = ?').run('f2', id)).toThrow()
  })

  it('an UPDATE attempt on published_at fails loudly', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    const id = insertRow(client, '/a', 'f1')

    expect(() => client.prepare('UPDATE published_snapshots SET published_at = ? WHERE id = ?').run(Date.now() + 1000, id)).toThrow()
  })

  it('setting superseded_by from NULL to a value succeeds exactly once', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    const id = insertRow(client, '/a', 'f1')
    const secondId = insertRow(client, '/b', 'f2') // distinct route, so the partial-unique index on /a is untouched

    expect(() => client.prepare('UPDATE published_snapshots SET superseded_by = ? WHERE id = ?').run(secondId, id)).not.toThrow()
    const row = client.prepare('SELECT superseded_by FROM published_snapshots WHERE id = ?').get(id) as { superseded_by: number }
    expect(row.superseded_by).toBe(secondId)
  })

  it('re-pointing an already-superseded row fails', () => {
    const db = migratedDb()
    const client = sqliteClientOf(db)
    const id = insertRow(client, '/a', 'f1')
    const secondId = insertRow(client, '/b', 'f2')
    const thirdId = insertRow(client, '/c', 'f3')
    client.prepare('UPDATE published_snapshots SET superseded_by = ? WHERE id = ?').run(secondId, id)

    expect(() => client.prepare('UPDATE published_snapshots SET superseded_by = ? WHERE id = ?').run(thirdId, id)).toThrow()
  })
})

describe('recordSnapshot writes one row per published route, with fingerprint dedupe', () => {
  it('recording a route for the first time inserts a current row', async () => {
    const { recordSnapshot, publishedSnapshots } = await import('@michaelthielemann/kestrel-publishing')
    const db = migratedDb()
    // `SnapshotsDb` is branded — cast at the crossing (mirrors `record-ref-index.test.ts`'s `asContentDb`).
    const snapshotsDb = db as unknown as SnapshotsDb

    const row = await recordSnapshot(snapshotsDb, { route: '/a', payload: fixturePayload(1), fingerprint: 'f1' })
    expect(row.route).toBe('/a')
    expect(row.supersededBy).toBeNull()

    const all = db.select().from(publishedSnapshots).all()
    expect(all).toHaveLength(1)
  })

  it('recording the same route with an unchanged fingerprint does NOT write a new row', async () => {
    const { recordSnapshot, publishedSnapshots } = await import('@michaelthielemann/kestrel-publishing')
    const db = migratedDb()
    const snapshotsDb = db as unknown as SnapshotsDb

    const first = await recordSnapshot(snapshotsDb, { route: '/a', payload: fixturePayload(1), fingerprint: 'f1' })
    const second = await recordSnapshot(snapshotsDb, { route: '/a', payload: fixturePayload(1), fingerprint: 'f1' })

    expect(second.id).toBe(first.id)
    const all = db.select().from(publishedSnapshots).all()
    expect(all).toHaveLength(1)
  })
})

describe('publishing a changed route supersedes the old row instead of mutating it', () => {
  it('a changed fingerprint inserts a new row and points the old row at it; the old payload stays readable', async () => {
    const { recordSnapshot, publishedSnapshots } = await import('@michaelthielemann/kestrel-publishing')
    const { eq } = await import('drizzle-orm')
    const db = migratedDb()
    const snapshotsDb = db as unknown as SnapshotsDb

    const first = await recordSnapshot(snapshotsDb, { route: '/a', payload: fixturePayload(1), fingerprint: 'f1' })
    const second = await recordSnapshot(snapshotsDb, { route: '/a', payload: fixturePayload(2), fingerprint: 'f2' })

    expect(second.id).not.toBe(first.id)
    expect(second.supersededBy).toBeNull()

    const reread = db.select().from(publishedSnapshots).where(eq(publishedSnapshots.id, first.id)).get()
    expect(reread?.supersededBy).toBe(second.id)
    expect(JSON.parse(reread!.payload as string)).toEqual(fixturePayload(1)) // old payload still readable — history

    const currentRows = db.select().from(publishedSnapshots)
      .where(eq(publishedSnapshots.route, '/a')).all()
      .filter((r) => r.supersededBy === null)
    expect(currentRows).toHaveLength(1) // current-pointer invariant holds after supersede
    expect(currentRows[0]!.id).toBe(second.id)
  })
})

describe('republishSnapshot creates a new current row instead of mutating the old one', () => {
  it('republishing an old snapshot creates a NEW row with equal content, new id, new published_at; the old row is untouched', async () => {
    const { recordSnapshot, republishSnapshot, publishedSnapshots } = await import('@michaelthielemann/kestrel-publishing')
    const { eq } = await import('drizzle-orm')
    const db = migratedDb()
    const snapshotsDb = db as unknown as SnapshotsDb

    const v1 = await recordSnapshot(snapshotsDb, { route: '/a', payload: fixturePayload(1), fingerprint: 'f1' })
    const v2 = await recordSnapshot(snapshotsDb, { route: '/a', payload: fixturePayload(2), fingerprint: 'f2' })
    const beforeRepublish = db.select().from(publishedSnapshots).where(eq(publishedSnapshots.id, v1.id)).get()

    const v3 = await republishSnapshot(snapshotsDb, { fromId: v1.id })

    expect(v3.id).not.toBe(v1.id)
    expect(v3.id).not.toBe(v2.id)
    expect(JSON.parse(v3.payload as string)).toEqual(fixturePayload(1)) // content equals the OLD snapshot's
    expect(v3.publishedAt).not.toEqual(beforeRepublish!.publishedAt)

    // the referenced old row (v1) was not mutated by the rollback
    const v1AfterRepublish = db.select().from(publishedSnapshots).where(eq(publishedSnapshots.id, v1.id)).get()
    expect(v1AfterRepublish).toEqual(beforeRepublish)

    // current-pointer invariant: exactly one current row for the route, and it is v3
    const currentRows = db.select().from(publishedSnapshots)
      .where(eq(publishedSnapshots.route, '/a')).all()
      .filter((r) => r.supersededBy === null)
    expect(currentRows).toHaveLength(1)
    expect(currentRows[0]!.id).toBe(v3.id)

    const v2AfterRepublish = db.select().from(publishedSnapshots).where(eq(publishedSnapshots.id, v2.id)).get()
    expect(v2AfterRepublish?.supersededBy).toBe(v3.id)
  })
})

describe('published_snapshots is read only through the publishing module / DeliveryPort implementations', () => {
  it('the snapshot store module exists at the contracted path', () => {
    // Fails loudly (ENOENT) rather than vacuously passing, if the module has not been created yet.
    expect(() => readFileSync(resolve(process.cwd(), 'packages/kestrel-publishing/src/server/db/snapshots.ts'), 'utf8')).not.toThrow()
  })

  it('no source file outside the publishing module or a real DeliveryPort implementation references published_snapshots directly', () => {
    const root = process.cwd()
    const skipDirs = new Set(['node_modules', '.git', '.nuxt', '.output', '.data', 'graphify-out', '.stryker-tmp', '.superpowers'])
    // Specific, documented exemptions (a file, not a directory-wide skip) — each with its own reason.
    const exemptFiles = new Set([
      'server/database/schema.ts', // drizzle-kit's schema-discovery barrel: a plain named re-export of the
      // TABLE only (never snapshots.ts's read/write API), needed for `db:generate` and
      // `server/database/schema.test.ts`'s own parity check.
    ])

    // Derived, not hand-listed: `@michaelthielemann/kestrel-publishing` itself, plus every `@michaelthielemann/kestrel-*` package that
    // declares it as a real `dependencies` entry — a DeliveryPort implementation (or anything else that
    // legitimately reads snapshots) necessarily takes that dependency, so a new one is exempted the moment
    // it depends on publishing, with no edit to this file.
    const packagesDir = resolve(root, 'packages')
    const exemptPackagePrefixes = readdirSync(packagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => resolve(packagesDir, e.name))
      .filter((dir) => existsSync(join(dir, 'package.json')))
      .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; dependencies?: Record<string, string> } }))
      .filter(({ pkg }) => pkg.name === '@michaelthielemann/kestrel-publishing' || pkg.dependencies?.['@michaelthielemann/kestrel-publishing'] !== undefined)
      .map(({ dir }) => `${dir.slice(root.length + 1)}/`)

    const violations: string[] = []

    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skipDirs.has(entry.name)) continue
        const full = resolve(dir, entry.name)
        const rel = full.slice(root.length + 1)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|vue)$/.test(entry.name)) continue
        if (rel.startsWith('layers/public/server/')) continue // the owning module's remaining layer wiring
        if (exemptPackagePrefixes.some((prefix) => rel.startsWith(prefix))) continue
        // NOT narrowed to just this suite: every architecture-invariant suite under here (ownership,
        // derived-rebuild, etc.) legitimately builds its own raw-SQL `published_snapshots` fixture.
        if (rel.startsWith('test/architecture/')) continue
        if (exemptFiles.has(rel)) continue

        const text = readFileSync(full, 'utf8')
        if (text.includes('published_snapshots') || /\bpublishedSnapshots\b/.test(text)) violations.push(rel)
      }
    }

    walk(root)
    expect(violations).toEqual([])
  })
})
