import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import type { Layer, Context } from 'effect'
import { OwnershipViolation, desiredSchema, diffSchema, makeModuleDb, recordRefs, renderSqlite } from '@kestrel/core'
import type { ModuleDbService } from '@kestrel/core'
import {
  publishingOwnershipManifest,
  usePublishingDbFor,
  publishDeps,
  publishStatus,
  publishRuns,
  createSqlitePersistence,
  DepsStore,
  recordPublishStatus,
  clearPublishStatus,
  lastPublishedAt,
  type DepsPersistenceDb,
  type PublishStatusDb,
} from '@kestrel/publishing'
const publishingTables = { publish_deps: publishDeps, publish_status: publishStatus }
const publishingTablesWithRuns = { publish_deps: publishDeps, publish_status: publishStatus, publish_runs: publishRuns }

function seedDb(): Database.Database {
  const sqlite = new Database(':memory:')
  const desired = desiredSchema([publishDeps, publishStatus, recordRefs])
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  return sqlite
}

function seedDbWithRuns(): Database.Database {
  const sqlite = new Database(':memory:')
  const desired = desiredSchema([publishDeps, publishStatus, publishRuns, recordRefs])
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  return sqlite
}

function getService<I, A>(layer: Layer.Layer<I>, tag: Context.Tag<I, A>): A {
  return Effect.runSync(Effect.scoped(Effect.provide(tag, layer)))
}

describe('publishing module — ownership enforcement (ADR-0012)', () => {
  it('the manifest owns exactly publish_deps, publish_runs, publish_status', () => {
    expect([...publishingOwnershipManifest.tables].sort()).toEqual(['publish_deps', 'publish_runs', 'publish_status', 'published_snapshots'])
  })

  it('own-table access succeeds through the adapter', () => {
    const sqlite = seedDb()
    const { layer, tag } = makeModuleDb(publishingOwnershipManifest, sqlite, publishingTables)
    const svc = getService(layer, tag)

    expect(() => svc.db.insert(svc.tables.publish_deps as typeof publishDeps).values({ route: '/a', tags: '[]' }).run()).not.toThrow()
    expect(() => svc.db.select().from(svc.tables.publish_deps as typeof publishDeps).all()).not.toThrow()
  })

  it('a cross-module raw-SQL access to a foreign table throws OwnershipViolation', () => {
    const sqlite = seedDb()
    const { layer, tag } = makeModuleDb(publishingOwnershipManifest, sqlite, publishingTables)
    const svc: ModuleDbService = getService(layer, tag)

    expect(() => svc.db.prepare('SELECT * FROM record_refs').all()).toThrow(OwnershipViolation)
    try {
      svc.db.prepare('SELECT * FROM record_refs').all()
      expect.fail('expected OwnershipViolation')
    } catch (err) {
      expect(err).toBeInstanceOf(OwnershipViolation)
      const violation = err as OwnershipViolation
      expect(violation.table).toBe('record_refs')
      expect(violation.module).toBe('publishing')
    }
  })

  it('a Drizzle query joining an own table against a foreign one throws OwnershipViolation', () => {
    const sqlite = seedDb()
    const { layer, tag } = makeModuleDb(publishingOwnershipManifest, sqlite, publishingTables)
    const svc = getService(layer, tag)

    expect(() => {
      svc.db.select().from(svc.tables.publish_deps as typeof publishDeps)
        .leftJoin(recordRefs, eq(publishDeps.route, recordRefs.targetColl))
        .all()
    }).toThrow(OwnershipViolation)
  })

  it('REAL-PATH: createSqlitePersistence + DepsStore round-trips route -> tags through the adapter end to end', () => {
    const sqlite = seedDb()
    const db = drizzle(sqlite)
    const adapterDb = usePublishingDbFor(db).db
    const store = new DepsStore(createSqlitePersistence(adapterDb))

    store.record('/speakers', ['speakers', 'settings'])
    store.record('/speakers/ann', ['speakers:1'])
    expect(store.routesForTags(['speakers:1'])).toEqual(['/speakers/ann'])

    // Rehydrates from the same durable table through a second adapter instance ("a restart").
    const rehydrated = new DepsStore(createSqlitePersistence(usePublishingDbFor(db).db))
    expect(rehydrated.routes().sort()).toEqual(['/speakers', '/speakers/ann'])
  })

  it('REAL-PATH: recordPublishStatus / lastPublishedAt / clearPublishStatus work end to end through the adapter', () => {
    const sqlite = seedDb()
    const adapterDb = usePublishingDbFor(drizzle(sqlite)).db

    recordPublishStatus(adapterDb, '/about', { status: 'success', target: 'local' })
    expect(lastPublishedAt(adapterDb).has('/about')).toBe(true)

    clearPublishStatus(adapterDb, '/about')
    expect(lastPublishedAt(adapterDb).has('/about')).toBe(false)
  })

  it('a stale-manifest ownership violation reaches the caller through createSqlitePersistence, not swallowed as "not migrated"', () => {
    const sqlite = seedDb()
    // A publishing adapter built WITHOUT publish_deps in its manifest — simulates an adapter cached
    // before the table was migrated in, or a programmer error naming the wrong manifest.
    const { layer, tag } = makeModuleDb({ module: 'publishing', tables: ['publish_status'] }, sqlite, publishingTables)
    const svc = getService(layer, tag)

    expect(() => createSqlitePersistence(svc.db)).toThrow(OwnershipViolation)
  })

  it('a stale-manifest ownership violation reaches the caller through recordPublishStatus/lastPublishedAt/clearPublishStatus, not swallowed as "not migrated"', () => {
    const sqlite = seedDb()
    const { layer, tag } = makeModuleDb({ module: 'publishing', tables: ['publish_deps'] }, sqlite, publishingTables)
    const svc = getService(layer, tag)

    expect(() => recordPublishStatus(svc.db, '/x', { status: 'success', target: 'local' })).toThrow(OwnershipViolation)
    expect(() => lastPublishedAt(svc.db)).toThrow(OwnershipViolation)
    expect(() => clearPublishStatus(svc.db, '/x')).toThrow(OwnershipViolation)
  })

  it('a genuinely missing table still degrades gracefully (the real not-migrated case, unaffected by the rethrow)', () => {
    // Deliberately bypasses the adapter (unlike every other case in this file) — this pins the writers'
    // OWN missing-table resilience, not the adapter's ownership check, so it needs a raw handle here; cast
    // at the crossing (`DepsPersistenceDb`/`PublishStatusDb` are branded, mirroring `record-ref-index.test.ts`'s
    // own `asContentDb` helper) rather than routing through `makeModuleDb` for a table that doesn't exist.
    const bare = drizzle(new Database(':memory:')) as unknown as DepsPersistenceDb & PublishStatusDb // neither publish_deps nor publish_status exists
    expect(() => createSqlitePersistence(bare)).not.toThrow()
    expect(() => recordPublishStatus(bare, '/x', { status: 'success', target: 'local' })).not.toThrow()
    expect(() => lastPublishedAt(bare)).not.toThrow()
    expect(() => clearPublishStatus(bare, '/x')).not.toThrow()
  })
})

describe('publish_runs — the orchestrator state table joins the publishing manifest (ADR-0012 continued)', () => {
  it('the manifest owns publish_deps, publish_runs, publish_status', () => {
    expect([...publishingOwnershipManifest.tables].sort()).toEqual(['publish_deps', 'publish_runs', 'publish_status', 'published_snapshots'])
  })

  it('own-table access to publish_runs succeeds through the adapter', () => {
    const sqlite = seedDbWithRuns()
    const { layer, tag } = makeModuleDb(publishingOwnershipManifest, sqlite, publishingTablesWithRuns)
    const svc = getService(layer, tag)

    expect(() => svc.db.insert(svc.tables.publish_runs as typeof publishRuns).values({ step: 'command', status: 'running' }).run()).not.toThrow()
    expect(() => svc.db.select().from(svc.tables.publish_runs as typeof publishRuns).all()).not.toThrow()
  })

  it('a cross-module raw-SQL access to publish_runs from a manifest that omits it throws OwnershipViolation (stale-adapter case)', () => {
    const sqlite = seedDbWithRuns()
    const { layer, tag } = makeModuleDb({ module: 'publishing', tables: ['publish_deps', 'publish_status'] }, sqlite, publishingTablesWithRuns)
    const svc: ModuleDbService = getService(layer, tag)

    expect(() => svc.db.prepare('SELECT * FROM publish_runs').all()).toThrow(OwnershipViolation)
    try {
      svc.db.prepare('SELECT * FROM publish_runs').all()
      expect.fail('expected OwnershipViolation')
    } catch (err) {
      expect(err).toBeInstanceOf(OwnershipViolation)
      const violation = err as OwnershipViolation
      expect(violation.table).toBe('publish_runs')
      expect(violation.module).toBe('publishing')
    }
  })

  it('a foreign module cannot join publish_runs against a non-owned table', () => {
    const sqlite = seedDbWithRuns()
    const { layer, tag } = makeModuleDb(publishingOwnershipManifest, sqlite, publishingTablesWithRuns)
    const svc = getService(layer, tag)

    expect(() => {
      svc.db.select().from(svc.tables.publish_runs as typeof publishRuns)
        .leftJoin(recordRefs, eq(publishRuns.id, recordRefs.id))
        .all()
    }).toThrow(OwnershipViolation)
  })

  it('desired schema for publish_runs renders and diffs clean against a fresh db — schema-engine parity, mirrors how outbox_content joined the schema', () => {
    const desired = desiredSchema([publishRuns])
    const sqlite = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
    // The table must actually exist with the columns the orchestrator contract needs — a schema
    // definition the render/diff engine accepts but that lacks these columns would pass the line above
    // and still be useless to the orchestrator, so read them back explicitly.
    expect(() => sqlite.prepare('SELECT id, step, status, error, created_at, updated_at FROM publish_runs').all()).not.toThrow()
  })
})
