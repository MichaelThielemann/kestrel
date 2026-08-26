import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import type { Layer, Context } from 'effect'
import { OwnershipViolation, desiredSchema, diffSchema, ensureOutboxTable, makeModuleDb, recordRefs, renderSqlite, createLocalDriver } from '@michaelthielemann/kestrel-core'
import type { ModuleDbService } from '@michaelthielemann/kestrel-core'
import {
  mediaOwnershipManifest,
  media as mediaTable,
  mediaSettings,
  folders,
  ensureFolder,
  listLibrary,
  deleteAffected,
  findMediaUsages,
} from '@michaelthielemann/kestrel-media'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mediaTables = { media: mediaTable, media_settings: mediaSettings, folders }

function seedDb(): Database.Database {
  const sqlite = new Database(':memory:')
  const desired = desiredSchema([mediaTable, mediaSettings, folders, recordRefs])
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  ensureOutboxTable(sqlite, 'content')
  return sqlite
}

function getService<I, A>(layer: Layer.Layer<I>, tag: Context.Tag<I, A>): A {
  return Effect.runSync(Effect.scoped(Effect.provide(tag, layer)))
}

describe('media module — ownership enforcement (ADR-0012)', () => {
  it('the manifest owns exactly media, media_settings, folders', () => {
    expect([...mediaOwnershipManifest.tables].sort()).toEqual(['folders', 'media', 'media_settings'])
  })

  it('own-table access succeeds through the adapter', () => {
    const sqlite = seedDb()
    const { layer, tag } = makeModuleDb(mediaOwnershipManifest, sqlite, mediaTables)
    const svc = getService(layer, tag)

    expect(() => svc.db.insert(svc.tables.folders as typeof folders).values({ path: 'a' }).run()).not.toThrow()
    expect(() => svc.db.select().from(svc.tables.folders as typeof folders).all()).not.toThrow()
  })

  it('a cross-module raw-SQL access to a foreign table throws OwnershipViolation', () => {
    const sqlite = seedDb()
    const { layer, tag } = makeModuleDb(mediaOwnershipManifest, sqlite, mediaTables)
    const svc: ModuleDbService = getService(layer, tag)

    expect(() => svc.db.prepare('SELECT * FROM record_refs').all()).toThrow(OwnershipViolation)
    try {
      svc.db.prepare('SELECT * FROM record_refs').all()
      expect.fail('expected OwnershipViolation')
    } catch (err) {
      expect(err).toBeInstanceOf(OwnershipViolation)
      const violation = err as OwnershipViolation
      expect(violation.table).toBe('record_refs')
      expect(violation.module).toBe('media')
    }
  })

  it('a Drizzle query joining an own table against a foreign one throws OwnershipViolation', () => {
    const sqlite = seedDb()
    const { layer, tag } = makeModuleDb(mediaOwnershipManifest, sqlite, mediaTables)
    const svc = getService(layer, tag)

    expect(() => {
      svc.db.select().from(svc.tables.folders as typeof folders)
        .leftJoin(recordRefs, eq(folders.id, recordRefs.id))
        .all()
    }).toThrow(OwnershipViolation)
  })

  it('real media utils (ensureFolder, listLibrary) work unchanged against the adapter-scoped db', () => {
    const sqlite = seedDb()
    const { layer, tag } = makeModuleDb(mediaOwnershipManifest, sqlite, mediaTables)
    const svc = getService(layer, tag)

    ensureFolder(svc.db, 'gallery/2026')
    const listing = listLibrary(svc.db, { folder: '' }, (key) => `/uploads/${key}`)
    expect(listing.folders.map((f) => f.path)).toEqual(['gallery'])
  })

  it('a real media transaction site (deleteAffected) commits through the adapter end to end', async () => {
    const sqlite = seedDb()
    const { layer, tag } = makeModuleDb(mediaOwnershipManifest, sqlite, mediaTables)
    const svc = getService(layer, tag)
    const uploadsDir = mkdtempSync(join(tmpdir(), 'kestrel-ownership-'))
    try {
      const driver = createLocalDriver({ dir: uploadsDir, baseUrl: '/uploads' })
      svc.db.insert(svc.tables.folders as typeof folders).values({ path: 'pics' }).run()
      const inserted = svc.db.insert(svc.tables.media as typeof mediaTable).values({
        storageKey: 'pics/a.png', folder: 'pics', filename: 'a.png', mime: 'image/png', ext: 'png', size: 1,
      } as never).returning().get() as { id: number }

      // emitMediaOutbox (the synthetic-write outbox seam) resolves its raw connection structurally, off
      // `svc.db`'s own registration in module-db.ts's `rawSqliteClientOf` — built here via a direct
      // `makeModuleDb` call, not `useMediaDbFor`, and still resolves correctly with no global stub needed.
      const report = await deleteAffected(svc.db, driver, [{ type: 'folder', path: 'pics' }])
      expect(report.summary.files).toBe(1)
      expect(svc.db.select().from(svc.tables.media as typeof mediaTable).all()).toEqual([])
      void inserted
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  it('the usages cross-collection reverse lookup (a deliberate ownership exemption, see media-ops.ts) is NOT scoped by the adapter', () => {
    // findMediaUsages/findMediaUsagesForMany scan every OTHER collection's table by design — passing the
    // media-scoped adapter's db into that exempted function is a type error (MediaDb lacks the raw
    // BetterSQLite3Database members it needs), enforced at compile time, not by this runtime test; this
    // test instead pins that the exemption still resolves correctly against the real (unscoped) db.
    const sqlite = new Database(':memory:')
    const desired = desiredSchema([mediaTable, mediaSettings, folders, recordRefs])
    for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
    expect(findMediaUsages(drizzle(sqlite), 1)).toEqual([])
  })

  it('no raw-connection escape hatch exists outside the named, deliberate ADR-0012/ADR-0023 owners', () => {
    // The escape hatches: `.$client` (the undocumented drizzle -> raw better-sqlite3.Database handle),
    // `sqliteClientOf(` (outbox.ts's own exported accessor over it), and `rawSqliteClientOf(`
    // (module-db.ts's identity-keyed adapter -> raw-connection lookup, ADR-0023). Every module-db adapter
    // builder, the outbox primitives themselves, the schema-sync/migration tasks, and the two named
    // ADR-0012 exemptions (findMediaUsagesForMany's cross-collection READ in media/utils/usages.ts, and
    // emitMediaOutbox's cross-module WRITE via media/db/media-db.ts's `sqliteClientOfMediaDb`) legitimately
    // reach one of these. Nothing else in the whole `layers/` tree may — every other call site must go
    // through a checked `<Module>Db` adapter. A grep, not a type check: the escape hatches are typed as
    // `Database.Database`, indistinguishable at the type level from any other value once destructured.
    // Exempted by RESOLVED absolute path, not basename — a same-named file in a different directory is
    // NOT automatically exempt. Scanned roots: `layers/` (still-layer-owned adapters/tasks/plugins) AND
    // `packages/kestrel-core/src/` + `packages/kestrel-media/src/` + `packages/kestrel-publishing/src/`
    // (the movers — module-db/outbox/outbox-worker/revisions/revision-migration/content-db/persist/
    // media-db/publishing-db/snapshots all carry the escape hatch and now live there).
    const layersRoot = join(process.cwd(), 'layers')
    const coreRoot = join(process.cwd(), 'packages/kestrel-core/src')
    const mediaRoot = join(process.cwd(), 'packages/kestrel-media/src')
    const publishingRoot = join(process.cwd(), 'packages/kestrel-publishing/src')
    const escapeHatchPattern = /\$client\b|\bsqliteClientOf\(|\brawSqliteClientOf\(/
    const exemptPaths = new Set([
      // The adapter/primitive owners: build or directly implement the escape hatch itself.
      'packages/kestrel-core/src/server/db/module-db.ts',
      'packages/kestrel-core/src/server/db/outbox.ts',
      'packages/kestrel-core/src/server/db/outbox-worker.ts',
      // The revisions adapter/primitive owner: same raw-SQL, statement-cached shape as outbox.ts,
      // for the same reason (a dynamic per-collection table no checked <Module>Db manifest predates).
      'packages/kestrel-core/src/server/db/revisions.ts',
      // The revisions data-migration task: reads via sqliteClientOf for the same reason revisions.ts
      // itself does (a dynamic per-collection table no checked <Module>Db manifest predates).
      'packages/kestrel-core/src/server/db/revision-migration.ts',
      'packages/kestrel-core/src/server/db/content-db.ts',
      'packages/kestrel-core/src/server/pipeline/steps/persist.ts',
      'layers/core/server/plugins/02.schema-sync.ts',
      'layers/core/server/tasks/db/migrate-module.ts',
      'layers/core/server/tasks/db/migrate.ts',
      'packages/kestrel-media/src/server/db/media-db.ts',
      'packages/kestrel-publishing/src/server/db/publishing-db.ts',
      // recordSnapshot/republishSnapshot predict the row id their own insert will get (to keep the
      // current-pointer partial unique index satisfied across the supersede pointer flip) — the same
      // `rawSqliteClientOf`/`$client` escape hatch outbox.ts and revisions.ts use, for a fresh table no
      // checked <Module>Db manifest predates.
      'packages/kestrel-publishing/src/server/db/snapshots.ts',
      // Reads the raw client at boot to hand it to `ensureSnapshotTriggers` — same `$client` pattern
      // `02.schema-sync.ts` already uses to reach the schema engine; DDL (triggers) is outside anything a
      // checked <Module>Db surface exposes.
      'layers/public/server/plugins/00.ensure-snapshot-triggers.ts',
    ].map((p) => join(process.cwd(), p)))

    // A stale exemption (naming a file that moved or was deleted) silently stops exempting anything real
    // AND silently stops covering the path it used to name — fail loud instead of just under-scanning.
    for (const p of exemptPaths) expect(existsSync(p), `exemptPaths entry does not exist: ${p}`).toBe(true)

    const offenders: string[] = []

    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || exemptPaths.has(full)) continue
        if (escapeHatchPattern.test(readFileSync(full, 'utf-8'))) offenders.push(full)
      }
    }
    walk(layersRoot)
    walk(coreRoot)
    walk(mediaRoot)
    walk(publishingRoot)

    expect(
      offenders,
      offenders.length
        ? `found a raw-connection escape hatch outside the named owners: ${offenders.join(', ')}. `
          + 'If this is a genuine new adapter/primitive owner (not a bypass), add its path to exemptPaths '
          + 'in this test with a one-line reason; otherwise route it through a checked <Module>Db instead.'
        : undefined,
    ).toEqual([])
  })
})
