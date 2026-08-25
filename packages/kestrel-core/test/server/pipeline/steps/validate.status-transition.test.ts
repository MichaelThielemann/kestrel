import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { ValidationFailed } from '@kestrel/contracts'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { create, update, setStatusMany, putSingleton } from '../../../../src/server/utils/crud.js'
import { buildCollection } from '../../../../src/server/schema/buildCollection.js'
import { defineCollection } from '../../../../src/index.js'
import { desiredSchema } from '../../../../src/server/schema/desired.js'
import { outboxContent } from '../../../../src/server/database/outbox-content.js'
import { diffSchema } from '../../../../src/server/schema/diff.js'
import { renderSqlite } from '../../../../src/server/schema/render-sqlite.js'
import { revisionsTable } from '../../../../src/server/db/revisions.js'
import { assertStatusTransition } from '../../../../src/server/pipeline/steps/validate.js'
import type { Row } from '../../../../src/server/pipeline/steps/shared.js'

// A collection whose `subtitle` is required only once `featured` is on — buildCollection's
// applyConditions hook, the guard `workflow.ts`'s transitions table asks about under the
// 'conditionsValid' name.
const articles = buildCollection(defineCollection({
  name: 'articles', mode: 'multi', translatable: false, status: true,
  fields: {
    title: { type: 'text', required: true },
    featured: { type: 'boolean' },
    subtitle: { type: 'text', required: true, condition: { field: 'featured', is: true } },
  },
}))

function testDb() {
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, articles.table, revisionsTable('articles')]), {}))) sqlite.exec(stmt)
  return drizzle(sqlite)
}

const home = buildCollection(defineCollection({
  name: 'home', mode: 'single', translatable: false, status: true,
  fields: {
    featured: { type: 'boolean' },
    subtitle: { type: 'text', required: true, condition: { field: 'featured', is: true } },
  },
}))

function singletonDb() {
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, home.table, revisionsTable('home')]), {}))) sqlite.exec(stmt)
  return drizzle(sqlite)
}

describe('status-transition gate — updateOne (single-record save)', () => {
  it('publishing via a plain record save (draft -> published) is denied when the guard fails, reproducing '
    + 'the real field-level issue rather than a generic message', () => {
    const db = testDb()
    const row = create(db, articles, { title: 'x', featured: false, status: 'draft' }) as { id: number }
    // The same save turns `featured` on without a subtitle: the merged record fails the guard, and the
    // target is 'published' — a guarded row in `transitions` — so `assertStatusTransition` denies it.
    try {
      update(db, articles, row.id, { status: 'published', featured: true })
      expect.unreachable()
    } catch (err) {
      const failed = err as ValidationFailed
      expect(failed.issues).toEqual([{ path: ['subtitle'], message: 'This field is required.', code: undefined }])
    }
  })

  it('publishing via a plain record save succeeds once the guarded field is filled in', () => {
    const db = testDb()
    const row = create(db, articles, { title: 'x', featured: true, subtitle: 'sub', status: 'draft' }) as { id: number }
    const updated = update(db, articles, row.id, { status: 'published' }) as { status: string }
    expect(updated.status).toBe('published')
  })

  it('re-publishing an already-published row (self-transition) is gated the same as any other publish', () => {
    const db = testDb()
    const row = create(db, articles, { title: 'x', featured: true, subtitle: 'sub', status: 'published' }) as { id: number }
    expect(() => update(db, articles, row.id, { status: 'published', featured: true, subtitle: '' }))
      .toThrow(ValidationFailed)
  })

  it('unpublishing via a plain record save (published -> draft) is not exempt from the collection\'s own field '
    + 'validation — updateOne validates the whole record unconditionally, unlike the bulk status patch', () => {
    const db = testDb()
    const row = create(db, articles, { title: 'x', featured: false, status: 'published' }) as { id: number }
    expect(() => update(db, articles, row.id, { status: 'draft', featured: true }))
      .toThrow(ValidationFailed)
  })
})

describe('status-transition gate — updateMany / admin publish & unpublish (setStatusMany)', () => {
  it('bulk-publishing a batch with one row failing the guard rejects the whole batch (all-or-nothing)', () => {
    const db = testDb()
    const ok = create(db, articles, { title: 'a', status: 'draft' }) as { id: number }
    const bad = create(db, articles, { title: 'b', featured: false, status: 'draft' }) as { id: number }
    // Flip the bad row directly (bypassing the always-validating updateOne) so it enters the batch
    // already broken: featured on, subtitle empty.
    db.update(articles.table).set({ featured: true }).run()
    expect(() => setStatusMany(db, articles, [ok.id, bad.id], 'published')).toThrow(ValidationFailed)
  })

  it('bulk-publishing an already-published row (a self-transition) is a legal no-op, still guarded', () => {
    const db = testDb()
    const row = create(db, articles, { title: 'a', featured: true, subtitle: 'sub', status: 'published' }) as { id: number }
    const result = setStatusMany(db, articles, [row.id], 'published')
    expect(result.count).toBe(1)
  })

  it('bulk-unpublishing is never blocked by the guard, including an already-draft, currently-broken row (self-transition)', () => {
    const db = testDb()
    const row = create(db, articles, { title: 'a', featured: false, status: 'draft' }) as { id: number }
    // Break the row directly, bypassing updateOne's unconditional check — the only way a `featured` row
    // with an empty `subtitle` can exist, since every write path but this one always re-validates it.
    db.update(articles.table).set({ featured: true }).run()
    const result = setStatusMany(db, articles, [row.id], 'draft')
    expect(result.count).toBe(1)
  })
})

describe('status-transition gate — singleton PUT', () => {
  it('publishing a singleton via PUT is denied when the guard fails, naming the transition', async () => {
    const db = singletonDb()
    await putSingleton(db, home, undefined, { status: 'draft', featured: false })
    await expect(putSingleton(db, home, undefined, { status: 'published', featured: true }))
      .rejects.toThrow(ValidationFailed)
  })

  it('publishing a singleton via PUT succeeds once the guarded field is filled in', async () => {
    const db = singletonDb()
    await putSingleton(db, home, undefined, { status: 'draft', featured: true, subtitle: 'sub' })
    const updated = await putSingleton(db, home, undefined, { status: 'published' }) as { status: string }
    expect(updated.status).toBe('published')
  })
})

describe('assertStatusTransition — defensive branch (no real pipeline can reach this)', () => {
  it('denies and names the pair when `from` is not a value the closed Status union permits', () => {
    // No registered collection can hand this in: the `status` column is DB-enforced to 'draft' |
    // 'published'. Exercised directly against the export to prove the fallback fires and reports
    // correctly, rather than leaving it an untested, unreachable throw.
    const corrupted = { status: 'archived' } as unknown as Row
    // Effect.flip swaps success/failure — a defensive-branch test that expects THIS effect to fail reads
    // most directly as "flip it, then the failure is the success value".
    const failed = Effect.runSync(Effect.flip(assertStatusTransition(articles, corrupted, 'published', { ...corrupted, status: 'published' })))
    expect(failed).toBeInstanceOf(ValidationFailed)
    expect(failed.issues).toEqual([{ path: ['status'], message: "illegal transition from 'archived' to 'published'" }])
  })
})
