import { describe, it, expect, beforeEach } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { createTestDb } from '../../../../../test/helpers/db.js'
import { clearRegistry, readOutbox, registerCollection } from '@kestrel/core'
import mediaCollection, { media as mediaTable } from '../../../src/server/collections/media.js'
import { useMediaDbFor, type MediaDb } from '../../../src/server/db/media-db.js'
import { emitMediaOutbox, NO_PIPELINE_CTX } from '../../../src/server/utils/media-write.js'

let db: BetterSQLite3Database

beforeEach(() => {
  clearRegistry()
  registerCollection(mediaCollection)
  db = createTestDb()
})

// A raw insert, deliberately bypassing core CRUD's own persist/emitOutbox — the seed row itself must carry
// no outbox row of its own, or a test asserting on "the envelope emitMediaOutbox wrote" could actually be
// looking at the seed's real CRUD envelope instead.
function seed(storageKey: string): { id: number; storageKey: string } {
  const cols = getTableColumns(mediaTable) as Record<string, never>
  const row = db.insert(mediaTable).values({
    storageKey, filename: storageKey, mime: 'image/png', ext: 'png', size: 1,
  } as never).returning({ id: cols.id }).get() as { id: number }
  return { id: row.id, storageKey }
}

describe('emitMediaOutbox: connection resolution (structural, not a coincidentally-current global)', () => {
  it('resolves directly off a raw BetterSQLite3Database ($client)', () => {
    const row = seed('a.png')
    emitMediaOutbox(db as unknown as MediaDb, null, { id: row.id }, NO_PIPELINE_CTX)
    const rows = readOutbox(db, 'content').filter((r) => r.envelope.aggregate.recordId === row.id)
    expect(rows.length).toBe(1)
  })

  it('resolves off a MediaDb built via useMediaDbFor/makeModuleDb', () => {
    const row = seed('b.png')
    const mediaDb = useMediaDbFor(db).db
    emitMediaOutbox(mediaDb, null, { id: row.id }, NO_PIPELINE_CTX)
    const rows = readOutbox(db, 'content').filter((r) => r.envelope.aggregate.recordId === row.id)
    expect(rows.length).toBe(1)
  })

  it('throws for a db object that is neither a raw connection nor a registered adapter', () => {
    expect(() => emitMediaOutbox({} as MediaDb, null, { id: 1 }, NO_PIPELINE_CTX)).toThrow(/cannot resolve/)
  })
})

describe('emitMediaOutbox: atomicity, reverse direction (row-write failure rolls the envelope back)', () => {
  it('an envelope written earlier in a transaction is gone once a LATER statement in the same transaction throws', () => {
    const row = seed('c.png')
    const mediaDb = useMediaDbFor(db).db

    expect(() => {
      mediaDb.transaction((tx) => {
        emitMediaOutbox(mediaDb, null, { id: row.id }, NO_PIPELINE_CTX)
        // Same connection, still inside the open transaction: the envelope this call just inserted is
        // already visible to a read on that connection, proving it landed before the forced failure below.
        const visible = readOutbox(db, 'content').some((r) => r.envelope.aggregate.recordId === row.id)
        expect(visible).toBe(true)
        // A genuine row-write failure (UNIQUE(storage_key) violation), not a mocked primitive — forces the
        // whole transaction, envelope insert included, to roll back.
        tx.insert(mediaTable).values({
          storageKey: row.storageKey, filename: 'dup', mime: 'image/png', ext: 'png', size: 1,
        } as never).run()
      })
    }).toThrow()

    const survives = readOutbox(db, 'content').some((r) => r.envelope.aggregate.recordId === row.id)
    expect(survives).toBe(false)
  })
})
