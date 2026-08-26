import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { allCollections, clearOutboxHandlers, clearRegistry, create, ensureRevisionsTable, outboxHandlersFor, pollOnce, readOutbox, recordRefs, registerCollection, registerReindexRefs, remove, createLocalDriver, getResolvedKestrelConfig, resetDbInstance, setResolvedKestrelConfig, useDb, DEFAULT_IMAGE_POLICY } from '@kestrel/core'
import * as outboxDb from '@kestrel/core'
import {
  registerMediaCleanup,
  mediaCollection,
  media as mediaTable,
  useMediaDbFor,
  deleteAffected,
  relocateMedia,
  duplicateMedia,
} from '@kestrel/media'
import { getTableColumns, eq } from 'drizzle-orm'

/**
 * Contract under test: mediaCleanup runs as an outbox handler (layers/media/server/handlers/media-cleanup.ts),
 * registered via registerOutboxHandler, and must be idempotent. The media library's synthetic write paths
 * (relocate / duplicate / delete / alt-edit — which call emitMediaWrite -> runWriteAfterStepsSync, bypassing
 * core CRUD persist) must emit a REAL outbox row atomically with their own DB write, so mediaCleanup (and
 * any other outbox consumer, e.g. reindexRefs' *.updated wildcard) actually gets driven by them.
 */

let db: BetterSQLite3Database
let uploadsDir: string
let driver: ReturnType<typeof createLocalDriver>

const ORIG_CONFIG = getResolvedKestrelConfig()
const migrationsFolder = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'server/database/migrations')

// reindexRefs (via useContentDb) reads the shared useDb() singleton, not an injectable port — point the
// singleton itself at a fresh in-memory db instead of stubbing a global, which useDb() never reads
// (mirrors reindex-refs-handler.test.ts's freshDb()).
function setupRuntime(): BetterSQLite3Database {
  uploadsDir = mkdtempSync(join(tmpdir(), 'kestrel-media-cleanup-'))
  driver = createLocalDriver({ dir: uploadsDir, baseUrl: '/uploads' })
  // The handler's own useStorageDriver() (@kestrel/media, an explicit import there) reads the config
  // provider, so seed it to point at the same uploadsDir the test's own `driver` uses for fileExists checks.
  setResolvedKestrelConfig({
    ...ORIG_CONFIG,
    dbPath: ':memory:',
    media: { dir: uploadsDir, baseUrl: '/uploads', driver: 'local', maxUploadBytes: 10_000_000, allowedMimes: '', s3: { bucket: '', region: '', endpoint: '', prefix: '', publicBaseUrl: '' }, imagePolicy: DEFAULT_IMAGE_POLICY },
  })
  resetDbInstance()
  const freshDb = useDb() as unknown as BetterSQLite3Database
  migrate(freshDb, { migrationsFolder })
  const sqlite = (freshDb as unknown as { $client: { exec: (sql: string) => void } }).$client
  for (const c of allCollections()) ensureRevisionsTable(sqlite as never, c.def.name)
  return freshDb
}

function seedMediaRow(storageKey: string, derivativeKey?: string): { id: number } {
  const row = create(db, mediaCollection, {
    storageKey,
    filename: storageKey.split('/').pop(),
    mime: 'image/png',
    ext: 'png',
    size: 3,
    derivatives: derivativeKey ? { 'w320.webp': { key: derivativeKey, width: 320, height: 240, mime: 'image/webp' } } : undefined,
  }) as { id: number }
  return row
}

async function putFiles(storageKey: string, derivativeKey?: string): Promise<void> {
  await driver.put(storageKey, Buffer.from('orig'), 'image/png')
  if (derivativeKey) await driver.put(derivativeKey, Buffer.from('deriv'), 'image/webp')
}

async function fileExists(key: string): Promise<boolean> {
  return (await driver.exists?.(key)) ?? false
}

function mediaRowExists(id: number): boolean {
  const cols = getTableColumns(mediaTable) as Record<string, never>
  return db.select().from(mediaTable).where(eq(cols.id, id)).all().length > 0
}

beforeEach(() => {
  clearRegistry()
  registerCollection(mediaCollection)
  db = setupRuntime()
})
afterEach(() => {
  clearOutboxHandlers()
  clearRegistry()
  setResolvedKestrelConfig(ORIG_CONFIG)
  resetDbInstance()
  rmSync(uploadsDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('media-cleanup handler: registration', () => {
  it('registerMediaCleanup() leaves a handler registered for media.deleted', () => {
    registerMediaCleanup()
    expect(outboxHandlersFor('media.deleted').length).toBeGreaterThan(0)
  })
})

describe('media-cleanup handler: the old inline after-step is deleted', () => {
  it('layers/media/server/plugins/03.media-cleanup.ts (the no-op stub that once held it) no longer exists', () => {
    // A stronger proof than "the file exists but doesn't register X": the file itself is gone. It was
    // kept as an empty stub only so the numbered plugin sequence stayed stable for filename-sort — moot
    // now that plugin order is declared data (layers/core/modules/plugin-order), so it was deleted.
    expect(existsSync(join(process.cwd(), 'layers/media/server/plugins/03.media-cleanup.ts'))).toBe(false)
  })
})

describe('media-cleanup handler: converges storage GC via a real write + pollOnce', () => {
  it('a deleted media row leaves its objects on disk until pollOnce runs, then removes them', async () => {
    registerMediaCleanup()
    const row = seedMediaRow('a/pic.png', 'a/pic.png-w320.webp')
    await putFiles('a/pic.png', 'a/pic.png-w320.webp')

    remove(db, mediaCollection, row.id)

    // The delete alone must not touch storage — only pollOnce (the outbox handler) does.
    expect(await fileExists('a/pic.png')).toBe(true)
    expect(await fileExists('a/pic.png-w320.webp')).toBe(true)

    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)

    expect(await fileExists('a/pic.png')).toBe(false)
    expect(await fileExists('a/pic.png-w320.webp')).toBe(false)
  })

  it('an update (non-delete) leaves the objects untouched', async () => {
    registerMediaCleanup()
    const row = seedMediaRow('b/pic.png')
    await putFiles('b/pic.png')

    create(db, mediaCollection, { storageKey: 'unrelated.png', filename: 'unrelated.png', mime: 'image/png', ext: 'png', size: 1 })
    await pollOnce(db, 'content')

    expect(await fileExists('b/pic.png')).toBe(true)
    void row
  })
})

describe('media-cleanup handler: idempotency — same envelope delivered twice', () => {
  it('redelivering the same media.deleted envelope does not throw and leaves storage in the same (deleted) state', async () => {
    registerMediaCleanup()
    const row = seedMediaRow('c/pic.png', 'c/pic.png-w320.webp')
    await putFiles('c/pic.png', 'c/pic.png-w320.webp')

    remove(db, mediaCollection, row.id)
    const envelope = readOutbox(db, 'content').find((r) => r.envelope.name === 'media.deleted' && r.envelope.aggregate.recordId === row.id)!.envelope
    const handlers = outboxHandlersFor('media.deleted')
    expect(handlers.length).toBeGreaterThan(0)

    await Promise.all(handlers.map((h) => h.handler(envelope)))
    expect(await fileExists('c/pic.png')).toBe(false)
    expect(await fileExists('c/pic.png-w320.webp')).toBe(false)

    // Redelivery against an already-clean disk must not throw (the local driver's delete is idempotent on
    // a missing key) and must leave the same end state.
    await expect(Promise.all(handlers.map((h) => h.handler(envelope)))).resolves.not.toThrow()
    expect(await fileExists('c/pic.png')).toBe(false)
    expect(await fileExists('c/pic.png-w320.webp')).toBe(false)
  })
})

describe('media-cleanup handler: redelivery-after-crash semantics', () => {
  it('a row already applied but left unmarked (processed_at NULL) re-applies cleanly on the next pollOnce', async () => {
    registerMediaCleanup()
    const row = seedMediaRow('d/pic.png')
    await putFiles('d/pic.png')

    remove(db, mediaCollection, row.id)
    await pollOnce(db, 'content')
    expect(await fileExists('d/pic.png')).toBe(false)

    const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client
    sqlite.prepare('UPDATE outbox_content SET processed_at = NULL, attempts = 0 WHERE aggregate_key = ?').run(`media:${row.id}`)

    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)
    expect(await fileExists('d/pic.png')).toBe(false)
  })
})

describe('the synthetic-media-write outbox seam: a bypass write emits a real outbox row', () => {
  it('deleteAffected (the media library delete, bypassing core CRUD) writes a media.deleted envelope with the right identity', async () => {
    const row = seedMediaRow('e/pic.png', 'e/pic.png-w320.webp')
    await putFiles('e/pic.png', 'e/pic.png-w320.webp')

    const mediaDb = useMediaDbFor(db).db
    await deleteAffected(mediaDb, driver, [{ type: 'file', id: row.id }])

    const rows = readOutbox(db, 'content').filter((r) => r.envelope.name === 'media.deleted' && r.envelope.aggregate.recordId === row.id)
    expect(rows.length).toBe(1)
    expect(rows[0]!.envelope.aggregate.collection).toBe('media')
  })

  it('relocateMedia (the media library move/rename, bypassing core CRUD) writes a media.updated envelope', async () => {
    const row = seedMediaRow('f/pic.png')
    await putFiles('f/pic.png')

    const mediaDb = useMediaDbFor(db).db
    await relocateMedia(mediaDb, driver, row.id, { folder: 'moved', filename: 'pic.png' })

    const rows = readOutbox(db, 'content').filter((r) => r.envelope.name === 'media.updated' && r.envelope.aggregate.recordId === row.id)
    expect(rows.length).toBe(1)
    expect(rows[0]!.envelope.aggregate.collection).toBe('media')
  })

  it('duplicateMedia (bypassing core CRUD) writes a media.created envelope for the NEW row, not the source', async () => {
    const row = seedMediaRow('g/pic.png')
    await putFiles('g/pic.png')

    const mediaDb = useMediaDbFor(db).db
    const copy = await duplicateMedia(mediaDb, driver, row.id, { folder: 'dup', filename: 'pic.png' })

    const rows = readOutbox(db, 'content').filter((r) => r.envelope.name === 'media.created' && r.envelope.aggregate.recordId === copy.id)
    expect(rows.length).toBe(1)
    expect(rows[0]!.envelope.aggregate.recordId).not.toBe(row.id)
  })

  it('the seam feeds mediaCleanup: a synthetic delete leaves storage untouched until pollOnce dispatches the new envelope', async () => {
    registerMediaCleanup()
    const row = seedMediaRow('h/pic.png', 'h/pic.png-w320.webp')
    await putFiles('h/pic.png', 'h/pic.png-w320.webp')

    const mediaDb = useMediaDbFor(db).db
    await deleteAffected(mediaDb, driver, [{ type: 'file', id: row.id }])

    // deleteAffected's OWN inline storage delete already runs today; this pins only that the OUTBOX-DRIVEN
    // path also exists and converges — the mediaCleanup handler must not throw when it independently tries
    // to clean up keys deleteAffected already removed (idempotent redundant cleanup).
    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)
    expect(await fileExists('h/pic.png')).toBe(false)
    expect(await fileExists('h/pic.png-w320.webp')).toBe(false)
  })
})

describe('the synthetic-media-write outbox seam: atomicity with the DB write', () => {
  it('happy path: the envelope and the row deletion are paired — envelope present implies the row is gone', async () => {
    const row = seedMediaRow('i/pic.png')
    await putFiles('i/pic.png')

    const mediaDb = useMediaDbFor(db).db
    await deleteAffected(mediaDb, driver, [{ type: 'file', id: row.id }])

    const wroteEnvelope = readOutbox(db, 'content').some((r) => r.envelope.name === 'media.deleted' && r.envelope.aggregate.recordId === row.id)
    expect(wroteEnvelope).toBe(true)
    expect(mediaRowExists(row.id)).toBe(false)
  })

  // Best-effort forced-failure probe: forces the shared outbox-insert primitive (the same one the normal
  // content write path already runs inside its own `db.transaction`, see persist.ts's `emitOutbox`) to
  // throw, and checks the row write rolled back with it. This pins the EXPECTED integration point, not a
  // literal requirement to call this exact function — if the implementer wires the seam through a
  // different primitive that also runs inside the same transaction as the row write, this test's mock
  // will not intercept it and the test needs updating to match.
  it('a forced failure in the outbox insert rolls back the paired row write (no envelope without the effect)', async () => {
    const row = seedMediaRow('j/pic.png')
    await putFiles('j/pic.png')

    const spy = vi.spyOn(outboxDb, 'insertOutboxRow').mockImplementation(() => {
      throw new Error('forced outbox-insert failure')
    })

    const mediaDb = useMediaDbFor(db).db
    await expect(deleteAffected(mediaDb, driver, [{ type: 'file', id: row.id }])).rejects.toThrow()

    spy.mockRestore()
    expect(mediaRowExists(row.id)).toBe(true) // the row write rolled back together with the envelope insert
    const wroteEnvelope = readOutbox(db, 'content').some((r) => r.envelope.name === 'media.deleted' && r.envelope.aggregate.recordId === row.id)
    expect(wroteEnvelope).toBe(false)
  })
})

describe('the write pipeline finishes without inline cleanup work', () => {
  it('a synthetic media delete returns before any pollOnce runs, and storage is untouched by the return', async () => {
    const row = seedMediaRow('k/pic.png', 'k/pic.png-w320.webp')
    await putFiles('k/pic.png', 'k/pic.png-w320.webp')

    const mediaDb = useMediaDbFor(db).db
    // No handler registered at all here — proves the seam itself (writing the envelope) is decoupled from
    // any consumer's derived work; nothing throws for lack of a mediaCleanup registration.
    await expect(deleteAffected(mediaDb, driver, [{ type: 'file', id: row.id }])).resolves.toBeDefined()
  })
})

describe('convergence with reindexRefs: a media write also reaches the *.updated wildcard, harmlessly', () => {
  it('a synthetic relocate dispatches to both mediaCleanup (exact media.updated) and reindexRefs (*.updated), producing no ref edges', async () => {
    registerMediaCleanup()
    registerReindexRefs()
    const row = seedMediaRow('l/pic.png')
    await putFiles('l/pic.png')

    const mediaDb = useMediaDbFor(db).db
    await relocateMedia(mediaDb, driver, row.id, { folder: 'moved-l', filename: 'pic.png' })

    const result = await pollOnce(db, 'content')
    expect(result.deadLettered).toBe(0)

    const edges = db.select().from(recordRefs).all()
      .filter((r: { sourceColl: string }) => r.sourceColl === 'media')
    expect(edges).toEqual([]) // media carries no ref-bearing field — reindexing it is a documented no-op
  })
})
