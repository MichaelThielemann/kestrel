import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  buildCollection,
  clearPipelines, clearRegistry, create, defineCollection, desiredSchema, diffSchema, ensureOutboxTable,
  makeTicker, registerCollection, remove, renderSqlite, runWrite, setResolvedKestrelConfig, sqliteClientOf,
  ensureRevisionsTable, revisionsTable, revisionsTableName, readRevisions, schemaVersionOf,
  registerRevisionUpcast, clearRevisionUpcasts, insertRevisionRow, clearPruneCursors, applyRevisionUpcast,
} from '@michaelthielemann/kestrel-core'
import { resolveServerKestrelConfig } from '../../layers/core/server/utils/server-config'
import { createTestDb } from '../helpers/db'
import { pagesCollection } from '@michaelthielemann/kestrel-collections'

/**
 * Retention pruning + revision schema versioning + upcast-on-rollback.
 *
 * Retention config: `KestrelConfig.revisions?: { keep?: number | 'all', maxAgeDays?: number }`, resolved
 * into `ResolvedKestrel.revisions` by `resolveKestrel`, default `{ keep: 'all' }` (nothing pruned). Read
 * server-side via `revisionRetentionPolicy(collection: string)` in
 * `layers/core/server/utils/revision-retention.ts`, mirroring `media-enabled.ts`'s
 * `serverRuntimeConfig()?.kestrel?.revisions ?? resolveServerKestrel().revisions` pattern.
 *
 * Pruning core: `pruneRevisions(sqlite, collection, recordId, policy, now)` in `revisions.ts`, returning
 * the number of rows deleted; takes `now` as an explicit `Date` (not the ambient clock) for determinism,
 * the same style as `ctx.facts.now`/`TestClock` elsewhere in this codebase.
 *
 * Worker-wide entry point: `pruneAllDueRevisions(db, now)` in `revisions.ts`, iterating every registered
 * collection's revisions table and applying `revisionRetentionPolicy` per collection — the function an
 * idle outbox tick calls. The tick wiring itself (whether `makeTicker`'s returned function actually calls
 * this on an idle tick) is not independently pinned here.
 *
 * Revision upcast surface: a dedicated `registerRevisionUpcast(collection, fromVersion, { toVersion, fn })`
 * registry local to `revisions.ts`, not a reuse of `@michaelthielemann/kestrel-contracts`' `registerUpcast`/`upcastToLatest`
 * — that walker presumes sequential author-assigned versions (it stops at `max(registered) + 1`), which a
 * def-hash (unordered 32-bit value) cannot satisfy. `fromVersion` is read back off a real recorded
 * revision's `schemaVersion` (never hardcoded); `toVersion` is read off `schemaVersionOf(currentDef)`.
 *
 * Schema-version-sensitive fixture: two collections named identically ("gadgets") but registered with
 * different field defs, in a way that never requires re-running the schema migration (both defs share the
 * same physical columns — only `required`-ness of an already-existing nullable column differs).
 */

type Row = Record<string, unknown>

function seedGadgets(required: boolean) {
  const def = buildCollection(defineCollection({
    name: 'gadgets',
    mode: 'multi',
    fields: {
      title: { type: 'text', required: true },
      note: { type: 'text', required },
    },
  }))
  return def
}

function articlesWithSubtitle() {
  return buildCollection(defineCollection({
    name: 'articles', mode: 'multi', translatable: false, status: true,
    fields: {
      title: { type: 'text', required: true },
      featured: { type: 'boolean' },
      subtitle: { type: 'text', required: true, condition: { field: 'featured', is: true } },
    },
  }))
}

const originalRuntimeConfig = globalThis.useRuntimeConfig
function stubRuntimeConfig(value: unknown) {
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => value
}
function clearRuntimeConfig() {
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = originalRuntimeConfig
}

beforeEach(() => {
  clearRevisionUpcasts()
  clearPruneCursors()
})
afterEach(() => {
  clearRevisionUpcasts()
  clearPruneCursors()
  clearRuntimeConfig()
  // Restore the provider to the default resolution (not the throwing unset state) — other tests in this
  // file call `revisionRetentionPolicy` through real pipeline writes and need it populated.
  setResolvedKestrelConfig(resolveServerKestrelConfig())
})

describe('revision retention config resolution', () => {
  it('defaults to keep: "all" (nothing pruned) when the consumer configures nothing', async () => {
    const { resolveKestrel } = await import('@michaelthielemann/kestrel-core')
    const resolved = resolveKestrel({}, {}, process.cwd()) as unknown as { revisions?: { keep: number | 'all', maxAgeDays?: number } }
    expect(resolved.revisions).toBeDefined()
    expect(resolved.revisions!.keep).toBe('all')
  })

  it('a configured keep: N round-trips through resolveKestrel', async () => {
    const { resolveKestrel } = await import('@michaelthielemann/kestrel-core')
    const resolved = resolveKestrel({ revisions: { keep: 5 } } as never, {}, process.cwd()) as unknown as { revisions?: { keep: number | 'all' } }
    expect(resolved.revisions!.keep).toBe(5)
  })

  // `revisionRetentionPolicy` reads a pre-resolved config, not `useRuntimeConfig` itself — this checks
  // the resolution precedence; `revisionRetentionPolicy`'s own normalization is checked separately below.
  it('resolveServerKestrelConfig reads runtimeConfig.kestrel.revisions, defaulting to keep: "all"', () => {
    stubRuntimeConfig({ kestrel: {} })
    expect(resolveServerKestrelConfig().revisions).toEqual({ keep: 'all' })

    stubRuntimeConfig({ kestrel: { revisions: { keep: 3 } } })
    expect(resolveServerKestrelConfig().revisions).toEqual({ keep: 3 })
  })

  it('revisionRetentionPolicy normalizes whatever the provider carries, defaulting to keep: "all"', async () => {
    const { revisionRetentionPolicy } = await import('@michaelthielemann/kestrel-core')
    setResolvedKestrelConfig({ ...resolveServerKestrelConfig(), revisions: undefined as never })
    expect(revisionRetentionPolicy('pages')).toEqual({ keep: 'all' })

    setResolvedKestrelConfig({ ...resolveServerKestrelConfig(), revisions: { keep: 3 } })
    expect(revisionRetentionPolicy('pages')).toEqual({ keep: 3 })
  })

  it('a garbage/negative keep reaching the provider UNVALIDATED (the runtimeConfig path) fails safe to "all" rather than reaching prune arithmetic', async () => {
    const { revisionRetentionPolicy } = await import('@michaelthielemann/kestrel-core')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      setResolvedKestrelConfig({ ...resolveServerKestrelConfig(), revisions: { keep: -5 } as never })
      expect(revisionRetentionPolicy('pages')).toEqual({ keep: 'all' })
      expect(warn).toHaveBeenCalled()

      warn.mockClear()
      setResolvedKestrelConfig({ ...resolveServerKestrelConfig(), revisions: { keep: 'soon' as unknown as number } })
      expect(revisionRetentionPolicy('pages')).toEqual({ keep: 'all' })
      expect(warn).toHaveBeenCalled()

      warn.mockClear()
      setResolvedKestrelConfig({ ...resolveServerKestrelConfig(), revisions: { keep: 3, maxAgeDays: -1 } })
      expect(revisionRetentionPolicy('pages')).toEqual({ keep: 3 })
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

function seedPages(): BetterSQLite3Database {
  clearRegistry()
  registerCollection(pagesCollection)
  const db = createTestDb()
  const client = sqliteClientOf(db)
  ensureOutboxTable(client, 'content')
  ensureRevisionsTable(client, 'pages')
  return db
}

describe('pruneRevisions: keep: N retains the newest N, pins the two protections', () => {
  it('keep: "all" (default) prunes nothing, however many revisions exist', async () => {
    const { pruneRevisions } = await import('@michaelthielemann/kestrel-core')
    const { update } = await import('@michaelthielemann/kestrel-core')
    const db = seedPages()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    for (let i = 0; i < 5; i++) update(db, pagesCollection, row.id as number, { title: `A v${i}` })

    const deleted = pruneRevisions(sqliteClientOf(db), 'pages', row.id as number, { keep: 'all' }, new Date())
    expect(deleted).toBe(0)
    expect(readRevisions(db, 'pages', row.id as number)).toHaveLength(6)
  })

  it('keep: 2 with 5 revisions deletes 3, retains the newest 2 by revision number', async () => {
    const { pruneRevisions } = await import('@michaelthielemann/kestrel-core')
    const { update } = await import('@michaelthielemann/kestrel-core')
    const db = seedPages()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    for (let i = 0; i < 4; i++) update(db, pagesCollection, row.id as number, { title: `A v${i}` })
    expect(readRevisions(db, 'pages', row.id as number)).toHaveLength(5)

    const deleted = pruneRevisions(sqliteClientOf(db), 'pages', row.id as number, { keep: 2 }, new Date())
    expect(deleted).toBe(3)
    const remaining = readRevisions(db, 'pages', row.id as number)
    expect(remaining.map((r) => r.revision)).toEqual([4, 5])
  })

  it('pin: the LAST revision is never pruned even with keep: 1 collapsing everything else', async () => {
    const { pruneRevisions } = await import('@michaelthielemann/kestrel-core')
    const { update } = await import('@michaelthielemann/kestrel-core')
    const db = seedPages()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    for (let i = 0; i < 4; i++) update(db, pagesCollection, row.id as number, { title: `A v${i}` })

    pruneRevisions(sqliteClientOf(db), 'pages', row.id as number, { keep: 1 }, new Date())
    const remaining = readRevisions(db, 'pages', row.id as number)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.revision).toBe(5)
  })

  it('pin: a TOMBSTONE last revision is never pruned, even with keep: 1', async () => {
    const { pruneRevisions } = await import('@michaelthielemann/kestrel-core')
    const { update } = await import('@michaelthielemann/kestrel-core')
    const db = seedPages()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    update(db, pagesCollection, row.id as number, { title: 'A v2' })
    remove(db, pagesCollection, row.id as number)
    expect(readRevisions(db, 'pages', row.id as number)).toHaveLength(3)

    pruneRevisions(sqliteClientOf(db), 'pages', row.id as number, { keep: 1 }, new Date())
    const remaining = readRevisions(db, 'pages', row.id as number)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.tombstone).toBe(true)
  })

  it('pin: sequence numbers of retained revisions are untouched — no renumbering, gaps are legal', async () => {
    const { pruneRevisions } = await import('@michaelthielemann/kestrel-core')
    const { update } = await import('@michaelthielemann/kestrel-core')
    const db = seedPages()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    for (let i = 0; i < 4; i++) update(db, pagesCollection, row.id as number, { title: `A v${i}` })

    pruneRevisions(sqliteClientOf(db), 'pages', row.id as number, { keep: 2 }, new Date())
    const remaining = readRevisions(db, 'pages', row.id as number)
    // 4 and 5 survive, 1-3 are gone: readRevisions must tolerate the gap (no renumbering to 1,2).
    expect(remaining.map((r) => r.revision)).toEqual([4, 5])
  })

  it('pin: pruning never breaks rollback to a retained revision, across the gap it created', async () => {
    const { pruneRevisions } = await import('@michaelthielemann/kestrel-core')
    const { update, getOne } = await import('@michaelthielemann/kestrel-core')
    clearPipelines()
    const db = seedPages()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    for (let i = 0; i < 4; i++) update(db, pagesCollection, row.id as number, { title: `A v${i}` })
    const before = readRevisions(db, 'pages', row.id as number)
    const target = before.find((r) => r.revision === 4)!

    pruneRevisions(sqliteClientOf(db), 'pages', row.id as number, { keep: 2 }, new Date())
    expect(readRevisions(db, 'pages', row.id as number).some((r) => r.revision === 1)).toBe(false)

    runWrite('rollback', { collection: pagesCollection, db, id: row.id as number, input: { revision: 4 } })
    const current = getOne(db, pagesCollection, row.id as number)
    expect(current.title).toBe((target.snapshot as Row).title)
  })

  it('maxAgeDays: revisions older than the cutoff are pruned, same LAST/tombstone protections apply', async () => {
    const { pruneRevisions } = await import('@michaelthielemann/kestrel-core')
    const { update } = await import('@michaelthielemann/kestrel-core')
    const db = seedPages()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    update(db, pagesCollection, row.id as number, { title: 'A v2' })
    update(db, pagesCollection, row.id as number, { title: 'A v3' })

    const client = sqliteClientOf(db)
    const OLD = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    client.prepare(`UPDATE ${revisionsTableName('pages')} SET created_at = ? WHERE record_id = ? AND revision IN (1, 2)`).run(OLD, row.id)

    const deleted = pruneRevisions(client, 'pages', row.id as number, { keep: 'all', maxAgeDays: 30 }, new Date())
    expect(deleted).toBe(2)
    const remaining = readRevisions(db, 'pages', row.id as number)
    expect(remaining.map((r) => r.revision)).toEqual([3])
  })

  it('maxAgeDays: an old LAST revision still survives (the last-revision pin outranks age)', async () => {
    const { pruneRevisions } = await import('@michaelthielemann/kestrel-core')
    const db = seedPages()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    const client = sqliteClientOf(db)
    const ANCIENT = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString()
    client.prepare(`UPDATE ${revisionsTableName('pages')} SET created_at = ? WHERE record_id = ? AND revision = 1`).run(ANCIENT, row.id)

    const deleted = pruneRevisions(client, 'pages', row.id as number, { keep: 'all', maxAgeDays: 1 }, new Date())
    expect(deleted).toBe(0)
    expect(readRevisions(db, 'pages', row.id as number)).toHaveLength(1)
  })
})

describe('pruneAllDueRevisions: the entry point an idle outbox tick would call', () => {
  it('prunes every registered collection\'s revisions per its own resolved retention policy', async () => {
    const { pruneAllDueRevisions } = await import('@michaelthielemann/kestrel-core')
    const { update } = await import('@michaelthielemann/kestrel-core')
    setResolvedKestrelConfig({ ...resolveServerKestrelConfig(), revisions: { keep: 1 } })
    const db = seedPages()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    for (let i = 0; i < 3; i++) update(db, pagesCollection, row.id as number, { title: `A v${i}` })
    expect(readRevisions(db, 'pages', row.id as number)).toHaveLength(4)

    const totalDeleted = pruneAllDueRevisions(db, new Date())
    expect(totalDeleted).toBeGreaterThan(0)
    expect(readRevisions(db, 'pages', row.id as number)).toHaveLength(1)
  })

  it('makeTicker exists and its tick still resolves a PollResult on an otherwise-empty outbox (flagged gap: prune wiring into the idle branch is not independently pinned — see file header)', async () => {
    const db = seedPages()
    const tick = makeTicker(() => db, 'content')
    const result = await tick()
    expect(result).not.toBeNull()
    expect(result!.processed).toBe(0)
  })

  it('a backlog bigger than the batch limit drains across MULTIPLE calls via cursor pagination — not the same first batch forever, starving everything past it', async () => {
    const { pruneAllDueRevisions } = await import('@michaelthielemann/kestrel-core')
    setResolvedKestrelConfig({ ...resolveServerKestrelConfig(), revisions: { keep: 1 } })
    const db = seedPages()
    const client = sqliteClientOf(db)
    const TOTAL = 520 // > PRUNE_RECORD_BATCH_LIMIT (500)
    const now = new Date().toISOString()
    for (let id = 1; id <= TOTAL; id++) {
      insertRevisionRow(client, 'pages', { recordId: id, revision: 1, snapshot: { id, title: 'a' }, schemaVersion: 1, correlationId: 'c', createdAt: now })
      insertRevisionRow(client, 'pages', { recordId: id, revision: 2, snapshot: { id, title: 'b' }, schemaVersion: 1, correlationId: 'c', createdAt: now })
    }

    const firstTick = pruneAllDueRevisions(db, new Date())
    expect(firstTick).toBe(500) // exactly the batch limit's worth of records, one prunable revision each

    const secondTick = pruneAllDueRevisions(db, new Date())
    expect(secondTick).toBe(20) // the remaining 20 records, resumed from the cursor
  }, 20000)
})

describe('schema_version is derived from the collection def, not a fixed literal', () => {
  it('two writes under the same def stamp the same schema_version', () => {
    clearRegistry()
    const v1 = seedGadgets(false)
    const db = createTestDb()
    for (const stmt of renderSqlite(diffSchema(desiredSchema([v1.table, revisionsTable('gadgets')]), {}))) db.run(sql.raw(stmt))
    registerCollection(v1)
    ensureOutboxTable(sqliteClientOf(db), 'content')

    const a = create(db, v1, { title: 'a' }) as Row
    const b = create(db, v1, { title: 'b' }) as Row
    const revA = readRevisions(db, 'gadgets', a.id as number)[0]!
    const revB = readRevisions(db, 'gadgets', b.id as number)[0]!
    expect(revA.schemaVersion).toBe(revB.schemaVersion)
  })

  it('registering a changed def (different required-ness of an existing field) stamps a different schema_version', () => {
    clearRegistry()
    const v1 = seedGadgets(false)
    const db = createTestDb()
    for (const stmt of renderSqlite(diffSchema(desiredSchema([v1.table, revisionsTable('gadgets')]), {}))) db.run(sql.raw(stmt))
    registerCollection(v1)
    ensureOutboxTable(sqliteClientOf(db), 'content')
    const a = create(db, v1, { title: 'a' }) as Row
    const versionV1 = readRevisions(db, 'gadgets', a.id as number)[0]!.schemaVersion

    clearRegistry()
    const v2 = seedGadgets(true)
    registerCollection(v2)
    const b = create(db, v2, { title: 'b', note: 'required now' }) as Row
    const versionV2 = readRevisions(db, 'gadgets', b.id as number)[0]!.schemaVersion

    expect(versionV2).not.toBe(versionV1)
  })

  it('is deterministic across two separate writes under the same def, not time-sensitive', async () => {
    clearRegistry()
    const v1 = seedGadgets(false)
    const db = createTestDb()
    for (const stmt of renderSqlite(diffSchema(desiredSchema([v1.table, revisionsTable('gadgets')]), {}))) db.run(sql.raw(stmt))
    registerCollection(v1)
    ensureOutboxTable(sqliteClientOf(db), 'content')

    const a = create(db, v1, { title: 'a' }) as Row
    await new Promise((r) => setTimeout(r, 5))
    const b = create(db, v1, { title: 'b' }) as Row
    expect(readRevisions(db, 'gadgets', a.id as number)[0]!.schemaVersion)
      .toBe(readRevisions(db, 'gadgets', b.id as number)[0]!.schemaVersion)
  })
})

describe('upcast chain applied on rollback to an old schema_version', () => {
  function seedGadgetsDb(v1: ReturnType<typeof seedGadgets>) {
    const db = createTestDb()
    for (const stmt of renderSqlite(diffSchema(desiredSchema([v1.table, revisionsTable('gadgets')]), {}))) db.run(sql.raw(stmt))
    registerCollection(v1)
    ensureOutboxTable(sqliteClientOf(db), 'content')
    return db
  }

  it('without a registered chain, rolling back an old-version revision surfaces a tagged Quarantined error (409-class), record untouched', async () => {
    clearRegistry()
    const v1 = seedGadgets(false)
    const db = seedGadgetsDb(v1)
    const row = create(db, v1, { title: 'a' }) as Row // note omitted — valid under v1

    clearRegistry()
    const v2 = seedGadgets(true) // note now required
    registerCollection(v2)

    let caught: unknown
    try {
      runWrite('rollback', { collection: v2, db, id: row.id as number, input: { revision: 1 } })
    } catch (e) {
      caught = e
    }
    expect(caught, 'expected rollback to a version with no upcast chain to throw').toBeDefined()
    expect((caught as { _tag?: string })._tag).toBe('Quarantined')

    const client = sqliteClientOf(db)
    const current = client.prepare('SELECT note FROM gadgets WHERE id = ?').get(row.id) as { note: unknown }
    expect(current.note).toBeFalsy()
  })

  it('with a registered chain (registerRevisionUpcast), rollback applies it and the restored row validates', async () => {
    clearRegistry()
    const v1 = seedGadgets(false)
    const db = seedGadgetsDb(v1)
    const row = create(db, v1, { title: 'a' }) as Row
    const oldVersion = readRevisions(db, 'gadgets', row.id as number)[0]!.schemaVersion

    clearRegistry()
    const v2 = seedGadgets(true)
    registerCollection(v2)

    registerRevisionUpcast('gadgets', oldVersion, {
      toVersion: schemaVersionOf(v2.def),
      fn: (payload) => ({ ...(payload as Row), note: (payload as Row).note ?? 'upcasted-default' }),
    })

    runWrite('rollback', { collection: v2, db, id: row.id as number, input: { revision: 1 } })

    const client = sqliteClientOf(db)
    const current = client.prepare('SELECT note FROM gadgets WHERE id = ?').get(row.id) as { note: unknown }
    expect(current.note).toBe('upcasted-default')
  })

  it('a TWO-HOP chain applies both steps in order, even with a DESCENDING intermediate version number — proving the walk follows explicit toVersion edges, never a sequential "+1"', async () => {
    clearRegistry()
    const v1 = seedGadgets(false)
    const db = seedGadgetsDb(v1)
    const row = create(db, v1, { title: 'a' }) as Row
    const oldVersion = readRevisions(db, 'gadgets', row.id as number)[0]!.schemaVersion

    clearRegistry()
    const v2 = seedGadgets(true)
    registerCollection(v2)
    const currentVersion = schemaVersionOf(v2.def)
    // Deliberately smaller than oldVersion AND unrelated to currentVersion's magnitude — a sequential
    // "fromVersion + 1" walker would never reach this by incrementing.
    const middleVersion = oldVersion - 999_999_999

    registerRevisionUpcast('gadgets', oldVersion, {
      toVersion: middleVersion,
      fn: (payload) => ({ ...(payload as Row), note: 'step1' }),
    })
    registerRevisionUpcast('gadgets', middleVersion, {
      toVersion: currentVersion,
      fn: (payload) => ({ ...(payload as Row), note: `${(payload as Row).note}-step2` }),
    })

    runWrite('rollback', { collection: v2, db, id: row.id as number, input: { revision: 1 } })

    const client = sqliteClientOf(db)
    const current = client.prepare('SELECT note FROM gadgets WHERE id = ?').get(row.id) as { note: unknown }
    expect(current.note).toBe('step1-step2')
  })

  it('a chain that stops before reaching the current version is unresolved — Quarantined, not a coin-flip on hash ordering', async () => {
    clearRegistry()
    const v1 = seedGadgets(false)
    const db = seedGadgetsDb(v1)
    const row = create(db, v1, { title: 'a' }) as Row
    const oldVersion = readRevisions(db, 'gadgets', row.id as number)[0]!.schemaVersion

    clearRegistry()
    const v2 = seedGadgets(true)
    registerCollection(v2)
    // One hop registered, but its toVersion is a dead end — never the current version, and nothing
    // registered from there either.
    registerRevisionUpcast('gadgets', oldVersion, {
      toVersion: oldVersion - 42,
      fn: (payload) => ({ ...(payload as Row), note: 'partial' }),
    })

    let caught: unknown
    try {
      runWrite('rollback', { collection: v2, db, id: row.id as number, input: { revision: 1 } })
    } catch (e) {
      caught = e
    }
    expect(caught, 'expected a partial chain to Quarantine, not silently pass').toBeDefined()
    expect((caught as { _tag?: string })._tag).toBe('Quarantined')
  })

  it('a registered step whose fn throws resolves:false with the original raw snapshot — never a crash', () => {
    clearRegistry()
    const v1 = seedGadgets(false)
    const db = seedGadgetsDb(v1)
    const row = create(db, v1, { title: 'a' }) as Row
    const oldVersion = readRevisions(db, 'gadgets', row.id as number)[0]!.schemaVersion

    clearRegistry()
    const v2 = seedGadgets(true)
    registerCollection(v2)

    registerRevisionUpcast('gadgets', oldVersion, {
      toVersion: schemaVersionOf(v2.def),
      fn: () => { throw new Error('boom') },
    })

    const target = readRevisions(db, 'gadgets', row.id as number)[0]!
    const outcome = applyRevisionUpcast(v2.def, target)
    expect(outcome.resolved).toBe(false)
    expect(outcome.snapshot).toEqual(target.snapshot)
  })
})

describe('restoring a TOMBSTONED record to a now-noncompliant published snapshot is denied', () => {
  it('the null-before "draft"-modeled path runs the same conditions gate as a live-record rollback', () => {
    clearRegistry()
    const v1 = buildCollection(defineCollection({
      name: 'articles', mode: 'multi', translatable: false, status: true,
      fields: { title: { type: 'text', required: true }, featured: { type: 'boolean' } },
    }))
    const db = createTestDb()
    for (const stmt of renderSqlite(diffSchema(desiredSchema([v1.table, revisionsTable('articles')]), {}))) db.run(sql.raw(stmt))
    registerCollection(v1)
    ensureOutboxTable(sqliteClientOf(db), 'content')

    const row = create(db, v1, { title: 'x', featured: true, status: 'published' }) as Row
    remove(db, v1, row.id as number)

    // Additive column, present-but-empty on the target revision — isolates this test to the conditions
    // gate specifically, mirroring the existing non-tombstone sibling test's own technique.
    sqliteClientOf(db).exec('ALTER TABLE articles ADD COLUMN subtitle text')
    const revClient = sqliteClientOf(db)
    const raw = revClient.prepare(`SELECT snapshot FROM ${revisionsTableName('articles')} WHERE record_id = ? AND revision = 1`).get(row.id) as { snapshot: string }
    const patched = { ...(JSON.parse(raw.snapshot) as Row), subtitle: '' }
    revClient.prepare(`UPDATE ${revisionsTableName('articles')} SET snapshot = ? WHERE record_id = ? AND revision = 1`).run(JSON.stringify(patched), row.id)

    clearRegistry()
    const v2 = articlesWithSubtitle()
    registerCollection(v2)

    expect(() => runWrite('rollback', { collection: v2, db, id: row.id as number, input: { revision: 1 } })).toThrowError(
      expect.objectContaining({ issues: [{ path: ['subtitle'], message: 'This field is required.', code: undefined }] }),
    )
  })
})

// rebuildFromRevisions is a recovery tool, and recovery must not resurrect a stale-shaped row silently:
// it applies the upcast chain strictly, same as rollback — no chain to bridge an old schemaVersion means
// a tagged Quarantined error, never a raw write of the old shape.
describe('rebuildFromRevisions ALSO applies the upcast chain, strict', () => {
  it('without a registered chain, rebuilding an old-version revision throws the tagged Quarantined error, no row written', async () => {
    const { rebuildFromRevisions } = await import('@michaelthielemann/kestrel-core')
    clearRegistry()
    const v1 = seedGadgets(false)
    const db = createTestDb()
    for (const stmt of renderSqlite(diffSchema(desiredSchema([v1.table, revisionsTable('gadgets')]), {}))) db.run(sql.raw(stmt))
    registerCollection(v1)
    ensureOutboxTable(sqliteClientOf(db), 'content')
    const row = create(db, v1, { title: 'a' }) as Row

    clearRegistry()
    const v2 = seedGadgets(true)
    registerCollection(v2)
    sqliteClientOf(db).prepare('DELETE FROM gadgets WHERE id = ?').run(row.id)

    let caught: unknown
    try {
      rebuildFromRevisions(db, v2, row.id as number)
    } catch (e) {
      caught = e
    }
    expect(caught, 'expected rebuild across an unbridged schema-version gap to throw').toBeDefined()
    expect((caught as { _tag?: string })._tag).toBe('Quarantined')
    const current = sqliteClientOf(db).prepare('SELECT * FROM gadgets WHERE id = ?').get(row.id)
    expect(current).toBeUndefined()
  })

  it('with a registered chain, rebuilding an old-version revision applies it and writes the upcasted row', async () => {
    const { rebuildFromRevisions } = await import('@michaelthielemann/kestrel-core')
    clearRegistry()
    const v1 = seedGadgets(false)
    const db = createTestDb()
    for (const stmt of renderSqlite(diffSchema(desiredSchema([v1.table, revisionsTable('gadgets')]), {}))) db.run(sql.raw(stmt))
    registerCollection(v1)
    ensureOutboxTable(sqliteClientOf(db), 'content')
    const row = create(db, v1, { title: 'a' }) as Row
    const oldVersion = readRevisions(db, 'gadgets', row.id as number)[0]!.schemaVersion

    clearRegistry()
    const v2 = seedGadgets(true)
    registerCollection(v2)
    registerRevisionUpcast('gadgets', oldVersion, {
      toVersion: schemaVersionOf(v2.def),
      fn: (payload) => ({ ...(payload as Row), note: (payload as Row).note ?? 'upcasted-default' }),
    })
    sqliteClientOf(db).prepare('DELETE FROM gadgets WHERE id = ?').run(row.id)

    const restored = rebuildFromRevisions(db, v2, row.id as number) as Row
    expect(restored.note).toBe('upcasted-default')
  })

  it('same schemaVersion (no drift) still rebuilds the raw snapshot untouched — the common case pays no upcast cost', async () => {
    const { rebuildFromRevisions } = await import('@michaelthielemann/kestrel-core')
    const db = seedPages()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    sqliteClientOf(db).prepare('DELETE FROM pages WHERE id = ?').run(row.id)

    const restored = rebuildFromRevisions(db, pagesCollection, row.id as number)
    expect(restored).toEqual(row)
  })
})

// keep + maxAgeDays together combine as a union of prunability.
describe('keep + maxAgeDays together prune the UNION (either criterion alone would leave some)', () => {
  it('a revision beyond keep OR older than the cutoff is pruned, even though neither policy alone would remove both', async () => {
    const { pruneRevisions } = await import('@michaelthielemann/kestrel-core')
    const { update } = await import('@michaelthielemann/kestrel-core')
    const db = seedPages()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    for (let i = 0; i < 4; i++) update(db, pagesCollection, row.id as number, { title: `A v${i}` })
    // revisions 1..5. keep:4 alone would prune only revision 1 (the sole one beyond the newest 4).
    // Age the SECOND-oldest (revision 2) past the cutoff too — age alone (with keep:'all') would prune only
    // revision 2. Neither policy alone removes both; the union must.
    const client = sqliteClientOf(db)
    const OLD = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    client.prepare(`UPDATE ${revisionsTableName('pages')} SET created_at = ? WHERE record_id = ? AND revision = 2`).run(OLD, row.id)

    const deleted = pruneRevisions(client, 'pages', row.id as number, { keep: 4, maxAgeDays: 30 }, new Date())
    expect(deleted).toBe(2)
    const remaining = readRevisions(db, 'pages', row.id as number)
    expect(remaining.map((r) => r.revision)).toEqual([3, 4, 5])
  })

  it('pin: an ancient LAST revision survives even among several OTHER prunable ones (last-revision protection outranks age generally, not just in the single-revision case)', async () => {
    const { pruneRevisions } = await import('@michaelthielemann/kestrel-core')
    const { update } = await import('@michaelthielemann/kestrel-core')
    const db = seedPages()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    update(db, pagesCollection, row.id as number, { title: 'A v2' })
    // revisions 1, 2. Both stamped ancient — the LAST one (revision 2) must still survive purely because
    // it is the last revision, not because it happens to be recent.
    const client = sqliteClientOf(db)
    const OLD = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    client.prepare(`UPDATE ${revisionsTableName('pages')} SET created_at = ? WHERE record_id = ?`).run(OLD, row.id)

    const deleted = pruneRevisions(client, 'pages', row.id as number, { keep: 'all', maxAgeDays: 30 }, new Date())
    expect(deleted).toBe(1)
    const remaining = readRevisions(db, 'pages', row.id as number)
    expect(remaining.map((r) => r.revision)).toEqual([2])
  })
})
