import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { buildCollection, buildPipelineIndex, clearPipelines, clearRegistry, create, defineCollection, desiredSchema, diffSchema, ensureOutboxTable, ensureRevisionsTable, getOne, putSingleton, readRevisions, rebuildFromRevisions, registerCollection, remove, removeMany, renderSqlite, revisionsTable, revisionsTableName, runWrite, sqliteClientOf, update  } from '@kestrel/core'
import type { PipelineDescriptor } from '@kestrel/core'
import { createTestDb } from '../helpers/db'
import { callPipelineRoute, usePipelineRouteDb } from '../helpers/pipeline-route'
import { pagesCollection } from '@kestrel/collections'

/**
 * Delete tombstones + the rollback pipeline.
 *
 * Tombstone discriminator: a tombstone revision has `tombstone: true` on the decoded `RevisionRow` (raw
 * column `tombstone INTEGER NOT NULL DEFAULT 0`) and `snapshot: null` (no row to snapshot).
 * `RevisionRow.snapshot`'s type therefore widens to `Row | null`.
 *
 * rebuildFromRevisions on a tombstoned record: returns `null` (no-op), does not throw and does not
 * resurrect the row — the existing contract already returns a plain value (`Row`) for the happy path, so
 * `Row | null` is the smaller, more honest widening.
 *
 * Rollback wire shape: `POST /api/<collection>/rollback/<id>` with body `{ revision: number }`, composed
 * as one more default write pipeline (so it needs no per-collection registration, like
 * createOne/deleteOne) — `ui: { kind: 'record', confirm: true }`. `PipelineDescriptor` gains a `ui` field.
 *
 * Rollback error tags: rolling back to an unknown revision number, or to a revision that is itself a
 * tombstone, both answer `ValidationFailed` (400) with `issues[0].path` including `'revision'`.
 *
 * `recordTimeToRollback(file, durationMs)` appends one ndjson line with a `timeToRollbackSec` key to the
 * given, caller-supplied file.
 */

type Row = Record<string, unknown>

function seed(): BetterSQLite3Database {
  clearRegistry()
  registerCollection(pagesCollection)
  const db = createTestDb()
  const client = sqliteClientOf(db)
  ensureOutboxTable(client, 'content')
  ensureRevisionsTable(client, 'pages')
  return db
}

function seedForRoute(): BetterSQLite3Database {
  const db = seed()
  usePipelineRouteDb(db)
  return db
}

function rollbackPage(id: number, revision: number, role = 'admin'): Promise<unknown> {
  return callPipelineRoute('POST', `/api/pages/rollback/${id}`, { role, body: { revision } })
}

describe('tombstone revisions on delete', () => {
  it('deleteOne appends a tombstone revision in the same transaction: prior snapshots stay, current row is gone', () => {
    const db = seed()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    const updated = update(db, pagesCollection, row.id as number, { title: 'A v2' }) as Row

    remove(db, pagesCollection, row.id as number)

    const revisions = readRevisions(db, 'pages', row.id as number)
    expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3])
    expect(revisions[0]!.snapshot).toEqual(row)
    expect(revisions[1]!.snapshot).toEqual(updated)
    const tomb = revisions[2]! as unknown as { tombstone: boolean, snapshot: unknown }
    expect(tomb.tombstone).toBe(true)

    const client = sqliteClientOf(db)
    expect(client.prepare('SELECT * FROM pages WHERE id = ?').get(row.id)).toBeUndefined()
  })

  it('deleteMany appends one tombstone revision per deleted unit', () => {
    const db = seed()
    const a = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    const b = create(db, pagesCollection, { title: 'B', path: '/b', status: 'draft' }) as Row

    removeMany(db, pagesCollection, [a.id as number, b.id as number])

    for (const row of [a, b]) {
      const revisions = readRevisions(db, 'pages', row.id as number)
      expect(revisions).toHaveLength(2)
      const tomb = revisions[1]! as unknown as { tombstone: boolean }
      expect(tomb.tombstone).toBe(true)
    }
  })

  it('a snapshot revision is never mistaken for a tombstone', () => {
    const db = seed()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    const rev = readRevisions(db, 'pages', row.id as number)[0]! as unknown as { tombstone: boolean }
    expect(rev.tombstone).toBe(false)
  })

  it('atomicity: forcing the tombstone append to fail rolls back the delete — the record survives', () => {
    const db = seed()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row

    const client = sqliteClientOf(db)
    client.exec(`DROP TABLE ${revisionsTableName('pages')}`)

    expect(() => remove(db, pagesCollection, row.id as number)).toThrow()

    // Re-provision to read the current row back without a raw client that no longer has the table.
    expect((db.select().from(pagesCollection.table).all() as Row[]).some((r) => r.id === row.id)).toBe(true)
  })
})

describe('rebuildFromRevisions honors the tombstone', () => {
  it('does not resurrect a record whose last revision is a tombstone', () => {
    const db = seed()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    remove(db, pagesCollection, row.id as number)

    const result = rebuildFromRevisions(db, pagesCollection, row.id as number)
    expect(result).toBeNull()

    const client = sqliteClientOf(db)
    expect(client.prepare('SELECT * FROM pages WHERE id = ?').get(row.id)).toBeUndefined()
  })

  it('still rebuilds normally when the last revision is a snapshot (behavior unchanged)', () => {
    const db = seed()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    const client = sqliteClientOf(db)
    client.prepare('DELETE FROM pages WHERE id = ?').run(row.id)

    const restored = rebuildFromRevisions(db, pagesCollection, row.id as number)
    expect(restored).toEqual(row)
  })
})

describe('rollback pipeline', () => {
  const rollback = (id: number, revision: number, role = 'admin') =>
    callPipelineRoute('POST', `/api/pages/rollback/${id}`, { role, body: { revision } })

  it('rolling back to revision 1 is append-only: [1..n, n+1] with n+1 deep-equal to revision 1, current row too', async () => {
    const db = seedForRoute()
    const created = await callPipelineRoute('POST', '/api/pages/createOne', { role: 'admin', body: { title: 'A', path: '/a', status: 'draft' } }) as Row
    await callPipelineRoute('POST', `/api/pages/updateOne/${created.id}`, { role: 'admin', body: { title: 'A v2' } })
    await callPipelineRoute('POST', `/api/pages/updateOne/${created.id}`, { role: 'admin', body: { title: 'A v3' } })

    const before = readRevisions(db, 'pages', created.id as number)
    expect(before.map((r) => r.revision)).toEqual([1, 2, 3])
    const rev1Snapshot = before[0]!.snapshot

    const notBefore = Date.now()
    await rollback(created.id as number, 1)

    const after = readRevisions(db, 'pages', created.id as number)
    expect(after.map((r) => r.revision)).toEqual([1, 2, 3, 4])

    // A rollback is a NEW write: `updatedAt` is stamped to now, not carried over from revision 1's own
    // moment — ground truth comes from an independent read of the row actually written, and we
    // additionally confirm it really did move forward, not just "whatever it was".
    const current = getOne(db, pagesCollection, created.id as number)
    expect(new Date(current.updatedAt as string | number | Date).getTime()).toBeGreaterThanOrEqual(notBefore)
    expect(after[3]!.snapshot).toEqual({ ...(rev1Snapshot as Row), updatedAt: current.updatedAt })
    expect(current).toEqual({ ...(rev1Snapshot as Row), updatedAt: current.updatedAt })
  })

  it('rolling back a deleted record (tombstone last) restores it — the sanctioned undo-delete', async () => {
    const db = seedForRoute()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    remove(db, pagesCollection, row.id as number)

    await rollback(row.id as number, 1)

    const client = sqliteClientOf(db)
    expect(client.prepare('SELECT * FROM pages WHERE id = ?').get(row.id)).toBeTruthy()
    const revisions = readRevisions(db, 'pages', row.id as number)
    expect(revisions).toHaveLength(3) // 1 (create), 2 (tombstone), 3 (rollback)
    const last = revisions[2]! as unknown as { tombstone: boolean }
    expect(last.tombstone).toBe(false)
  })

  it('rolling back TO a tombstone revision is a tagged failure, not a resurrection-by-accident', async () => {
    const db = seedForRoute()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    remove(db, pagesCollection, row.id as number)
    // revision 2 is the tombstone; rolling back to it should fail cleanly.
    await expect(rollback(row.id as number, 2)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('an unknown revision number is a tagged failure', async () => {
    const db = seedForRoute()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    await expect(rollback(row.id as number, 999)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('is admin-gated: anonymous is refused', async () => {
    const db = seedForRoute()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    await expect(rollback(row.id as number, 1, 'anonymous')).rejects.toMatchObject({ statusCode: 401 })
  })
})

describe('property: every write op is reversible via rollback', () => {
  // Deterministic seed, logged for reproducibility — Kestrel pins fast-check's own DEFAULT seed policy
  // (see decide.test.ts) is not enough on its own; an explicit seed makes a failing run replayable verbatim.
  const SEED = 20260823
  const NUM_RUNS = 15

  const titleArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0)
  const statusArb = fc.constantFrom('draft' as const, 'published' as const)
  // A hand-rolled generator over pages' own field types (text `title`, an auto `path`, and `status`),
  // not effect's Arbitrary.make: `Arbitrary.make` derives from an effect Schema, and the repo's collection
  // field defs are Zod-based (drizzle-zod), not effect Schema — there is no schema here for Arbitrary.make
  // to walk. fast-check (already an allowlisted dev dependency, used elsewhere in the repo — see
  // decide.test.ts) drives the randomness instead.
  let pathCounter = 0
  const uniquePath = (): string => `/prop-${SEED}-${pathCounter++}`

  it('a random create/update/delete sequence, rolled back to any prior snapshot revision, matches that snapshot exactly', async () => {
    await fc.assert(
      fc.asyncProperty(
        titleArb,
        fc.array(titleArb, { maxLength: 3 }),
        fc.boolean(),
        statusArb,
        async (createTitle, updateTitles, deleteAfter, status) => {
          const db = seedForRoute()
          const path = uniquePath()
          const created = create(db, pagesCollection, { title: createTitle, path, status }) as Row
          for (const t of updateTitles) update(db, pagesCollection, created.id as number, { title: t })
          if (deleteAfter) remove(db, pagesCollection, created.id as number)

          const all = readRevisions(db, 'pages', created.id as number)
          const snapshotRevisions = all.filter((r) => !(r as unknown as { tombstone: boolean }).tombstone)
          // At least revision 1 always exists as a non-tombstone snapshot to target.
          const target = snapshotRevisions[Math.floor(snapshotRevisions.length / 2)] ?? snapshotRevisions[0]!
          const revCountBefore = all.length

          await callPipelineRoute('POST', `/api/pages/rollback/${created.id}`, { role: 'admin', body: { revision: target.revision } })

          // A rollback is a NEW write: `updatedAt` moves to now, so the current row is compared to the
          // target snapshot modulo that one field (ground truth read independently) — and separately
          // pinned against the just-appended revision, which must describe the ACTUAL written row (kills
          // a rewind hiding inside the property, not just the example tests).
          const current = getOne(db, pagesCollection, created.id as number)
          expect(current).toEqual({ ...(target.snapshot as Row), updatedAt: current.updatedAt })

          const revsAfter = readRevisions(db, 'pages', created.id as number)
          expect(revsAfter).toHaveLength(revCountBefore + 1)
          expect(revsAfter[revsAfter.length - 1]!.snapshot).toEqual(current)
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    )
  })
})

describe('time-to-rollback measurement', () => {
  it('recordTimeToRollback appends one ndjson row with a recognizable timeToRollbackSec key to the given file', async () => {
    const { recordTimeToRollback } = await import('@kestrel/core')
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-rollback-metric-'))
    const file = join(dir, 'metrics.ndjson')

    recordTimeToRollback(file, 123)

    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const row = JSON.parse(lines[0]!) as { timeToRollbackSec?: number }
    expect(row.timeToRollbackSec).toBeCloseTo(0.123, 3)
  })

  it('a second call appends rather than overwrites — the file is append-only, like metrics.ndjson itself', async () => {
    const { recordTimeToRollback } = await import('@kestrel/core')
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-rollback-metric-'))
    const file = join(dir, 'metrics.ndjson')

    recordTimeToRollback(file, 100)
    recordTimeToRollback(file, 200)

    const lines = readFileSync(file, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
  })
})

describe('read model untouched; introspection sees the rollback pipeline', () => {
  it('a plain read after a rollback carries no revision/tombstone fields', async () => {
    const db = seedForRoute()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Row
    await callPipelineRoute('POST', `/api/pages/rollback/${row.id}`, { role: 'admin', body: { revision: 1 } })

    const read = getOne(db, pagesCollection, row.id as number)
    for (const forbidden of ['revision', 'snapshot', 'tombstone', 'schemaVersion', 'schema_version']) {
      expect(Object.keys(read)).not.toContain(forbidden)
    }
  })

  it('the composed pipeline index lists rollback for a collection with its ui declaration', () => {
    clearRegistry()
    clearPipelines()
    registerCollection(pagesCollection)
    const index = buildPipelineIndex() as (PipelineDescriptor & { ui?: { kind: string, confirm?: boolean } })[]
    const rollback = index.find((p) => p.collection === 'pages' && p.name === 'rollback')
    expect(rollback, 'rollback pipeline missing from the composed index for "pages"').toBeDefined()
    expect(rollback!.route).toEqual({ url: '/api/pages/rollback', method: 'POST' })
    expect(rollback!.gates.access).toEqual({ role: 'admin' })
    expect(rollback!.ui).toMatchObject({ kind: 'record', confirm: true })
  })
})

describe('a colliding restore is a tagged Conflict, not a raw driver error', () => {
  it('undo-delete after the unique slot was reused answers 409 with the real field, never a 500', async () => {
    const db = seedForRoute()
    const a = await callPipelineRoute('POST', '/api/pages/createOne', { role: 'admin', body: { title: 'A', path: '/collide', status: 'draft' } }) as Row
    await callPipelineRoute('POST', `/api/pages/deleteOne/${a.id}`, { role: 'admin' })
    // The path slot is free again — a second, unrelated record legitimately claims it.
    await callPipelineRoute('POST', '/api/pages/createOne', { role: 'admin', body: { title: 'B', path: '/collide', status: 'draft' } })
    void db

    await expect(rollbackPage(a.id as number, 1)).rejects.toMatchObject({
      statusCode: 409,
      data: { kind: 'duplicate' },
    })
  })
})

describe('rollback re-sanitizes richtext at the write seam, like every other persist kind', () => {
  function seedNotes(): BetterSQLite3Database {
    clearRegistry()
    const notes = buildCollection(defineCollection({
      name: 'notes',
      mode: 'multi',
      fields: { title: { type: 'text', required: true }, body: { type: 'richtext' } },
    }))
    const db = createTestDb()
    for (const stmt of renderSqlite(diffSchema(desiredSchema([notes.table, revisionsTable('notes')]), {}))) db.run(sql.raw(stmt))
    registerCollection(notes)
    ensureOutboxTable(sqliteClientOf(db), 'content')
    usePipelineRouteDb(db)
    return db
  }

  it('a restored snapshot with unsanitized richtext (only reachable by writing history directly) comes back sanitized', async () => {
    const db = seedNotes()
    const created = await callPipelineRoute('POST', '/api/notes/createOne', { role: 'admin', body: { title: 'x', body: '<p>hi</p>' } }) as Row
    const client = sqliteClientOf(db)
    // The write path never lets unsanitized richtext land — corrupting revision 1's own history row
    // directly is the only way to construct this scenario for the test.
    const raw = client.prepare(`SELECT snapshot FROM ${revisionsTableName('notes')} WHERE record_id = ? AND revision = 1`).get(created.id) as { snapshot: string }
    const corrupted = { ...(JSON.parse(raw.snapshot) as Row), body: '<script>alert(1)</script><p>hi</p>' }
    client.prepare(`UPDATE ${revisionsTableName('notes')} SET snapshot = ? WHERE record_id = ? AND revision = 1`).run(JSON.stringify(corrupted), created.id)

    await callPipelineRoute('POST', `/api/notes/rollback/${created.id}`, { role: 'admin', body: { revision: 1 } })

    const current = client.prepare('SELECT body FROM notes WHERE id = ?').get(created.id) as { body: string }
    expect(current.body).not.toContain('<script')
    expect(current.body).toContain('<p>hi</p>')
  })
})

describe('rollback validates the snapshot against the collection\'s CURRENT def', () => {
  it('a def-drifted snapshot (an invalid field under today\'s schema) is refused as ValidationFailed — nothing is written', async () => {
    const db = seedForRoute()
    const created = await callPipelineRoute('POST', '/api/pages/createOne', { role: 'admin', body: { title: 'A', path: '/i1', status: 'draft' } }) as Row
    const client = sqliteClientOf(db)
    // The write path never lets an invalid snapshot land — corrupting revision 1's own history row
    // directly is the only way to construct a "recorded under a since-drifted def" scenario for the test.
    const raw = client.prepare(`SELECT snapshot FROM ${revisionsTableName('pages')} WHERE record_id = ? AND revision = 1`).get(created.id) as { snapshot: string }
    const corrupted = { ...(JSON.parse(raw.snapshot) as Row), title: null }
    client.prepare(`UPDATE ${revisionsTableName('pages')} SET snapshot = ? WHERE record_id = ? AND revision = 1`).run(JSON.stringify(corrupted), created.id)

    await expect(rollbackPage(created.id as number, 1)).rejects.toMatchObject({ statusCode: 400 })

    expect(getOne(db, pagesCollection, created.id as number).title).toBe('A')
    expect(readRevisions(db, 'pages', created.id as number)).toHaveLength(1)
  })
})

describe('rollback runs the same status-transition/conditions gate as updateOne', () => {
  // Mirrors validate.status-transition.test.ts's own `articles` fixture: `subtitle` is required only once
  // `featured` is on, the guard `workflow.ts`'s transitions table asks about under 'conditionsValid'.
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

  it('a published snapshot that fails TODAY\'s conditions is denied via rollback exactly as an equivalent updateOne denies it', () => {
    clearRegistry()
    const v1 = buildCollection(defineCollection({
      name: 'articles', mode: 'multi', translatable: false, status: true,
      fields: { title: { type: 'text', required: true }, featured: { type: 'boolean' } },
    }))
    const db = createTestDb()
    for (const stmt of renderSqlite(diffSchema(desiredSchema([v1.table, revisionsTable('articles')]), {}))) db.run(sql.raw(stmt))
    registerCollection(v1)
    ensureOutboxTable(sqliteClientOf(db), 'content')

    // Recorded under a def with no `subtitle` field at all — a legitimate publish at the time.
    const row = create(db, v1, { title: 'x', featured: true, status: 'draft' }) as Row
    update(db, v1, row.id as number, { status: 'published' })

    // The def evolves: `subtitle` becomes required whenever `featured` is on. The physical column is
    // added additively (nullable — mirrors what a real migration produces for an existing populated
    // table), so the OLD row (featured, no subtitle) is now non-compliant under the new condition. The
    // stored history row is patched to carry an EMPTY (present, well-typed) `subtitle` — isolating this
    // test to the conditions gate specifically, distinct from a missing/mistyped key (see the "def-drifted
    // snapshot" test above, which already covers that case at the decode layer).
    sqliteClientOf(db).exec('ALTER TABLE articles ADD COLUMN subtitle text')
    const revClient = sqliteClientOf(db)
    const raw = revClient.prepare(`SELECT snapshot FROM ${revisionsTableName('articles')} WHERE record_id = ? AND revision = 2`).get(row.id) as { snapshot: string }
    const patched = { ...(JSON.parse(raw.snapshot) as Row), subtitle: '' }
    revClient.prepare(`UPDATE ${revisionsTableName('articles')} SET snapshot = ? WHERE record_id = ? AND revision = 2`).run(JSON.stringify(patched), row.id)
    clearRegistry()
    const v2 = articlesWithSubtitle()
    registerCollection(v2)

    // Denied via a plain record save (the self-pair published -> published re-runs the same guard) —
    // the conditions check itself produces the friendly message.
    expect(() => update(db, v2, row.id as number, { status: 'published', subtitle: '' })).toThrowError(
      expect.objectContaining({ issues: [{ path: ['subtitle'], message: 'This field is required.', code: undefined }] }),
    )

    // Denied via rollback to that same now-noncompliant published revision, identically — same field,
    // same message, nothing written.
    expect(() => runWrite('rollback', { collection: v2, db, id: row.id as number, input: { revision: 2 } })).toThrowError(
      expect.objectContaining({ issues: [{ path: ['subtitle'], message: 'This field is required.', code: undefined }] }),
    )
  })
})

describe('singletons may roll back', () => {
  it('rolls back a singleton by its row id — deletes are already blocked for singletons, so the tombstone path never arises here', async () => {
    clearRegistry()
    const settings = buildCollection(defineCollection({
      name: 'demoSettings', mode: 'single', translatable: false, fields: { siteName: { type: 'text' } },
    }))
    const db = createTestDb()
    for (const stmt of renderSqlite(diffSchema(desiredSchema([settings.table, revisionsTable('demoSettings')]), {}))) db.run(sql.raw(stmt))
    registerCollection(settings)
    ensureOutboxTable(sqliteClientOf(db), 'content')

    const v1 = await putSingleton(db, settings, undefined, { siteName: 'light' }) as Row
    await putSingleton(db, settings, undefined, { siteName: 'dark' })

    runWrite('rollback', { collection: settings, db, id: v1.id as number, input: { revision: 1 } })

    const current = sqliteClientOf(db).prepare('SELECT site_name FROM demoSettings WHERE id = ?').get(v1.id) as { site_name: string }
    expect(current.site_name).toBe('light')
  })
})
