import { describe, it, expect } from 'vitest'
import { Schema } from 'effect'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { EventEnvelope } from '@michaelthielemann/kestrel-contracts'
import { createTestDb } from '../helpers/db'
import { OwnershipViolation, clearRegistry, create, ensureOutboxTable, outboxTableName, readOutbox, registerCollection, remove, update, useContentDbFor } from '@michaelthielemann/kestrel-core'
import { pagesCollection } from '@michaelthielemann/kestrel-collections'
import postsCollection from '../../server/collections/posts'

/**
 * Contract tests for the transactional outbox.
 *
 * Surface under test:
 *   outboxTableName(module) => `outbox_${module}`
 *   ensureOutboxTable(sqlite, module) => idempotent CREATE TABLE IF NOT EXISTS, columns:
 *     id INTEGER PK, envelope TEXT/json, aggregate_key TEXT, sequence INTEGER, processed_at TEXT NULL,
 *     attempts INTEGER, dead INTEGER
 *   readOutbox(db, module) => OutboxRow[] ordered by id ascending, `envelope` already decoded against
 *     `EventEnvelope` (Schema.decodeUnknownSync) — a malformed row throws instead of surfacing raw JSON.
 *
 * A `pages`/`posts` write is a content-module write, so its envelope lands in `outbox_content` — content
 * owns the collection tables, so it owns the outbox that records their changes.
 *
 * Event-name convention: `<collection>.created` (before === null), `<collection>.updated` (before && after),
 *   `<collection>.deleted` (after === null); version 1. payload = the last known row state (`after ?? before`).
 */

function sqliteClientOf(db: BetterSQLite3Database): Database.Database {
  return (db as unknown as { $client: Database.Database }).$client
}

function seed(): BetterSQLite3Database {
  clearRegistry()
  registerCollection(pagesCollection)
  registerCollection(postsCollection)
  const db = createTestDb()
  ensureOutboxTable(sqliteClientOf(db), 'content')
  return db
}

const decodeEnvelope = Schema.decodeUnknownSync(EventEnvelope)
const encodeEnvelope = Schema.encodeSync(EventEnvelope)

describe('outbox: createOne — envelope shape and timing', () => {
  it('leaves exactly one outbox row whose envelope decodes with the right aggregate/causation', () => {
    const db = seed()
    const before = new Date().toISOString()
    const row = create(db, pagesCollection, { title: 'Hello', path: '/hello', status: 'draft' }) as Record<string, unknown>
    const after = new Date().toISOString()

    const rows = readOutbox(db, 'content')
    expect(rows).toHaveLength(1)
    const envelope = rows[0]!.envelope
    // pins the on-disk shape too, not just the in-memory decode readOutbox already performed
    expect(() => decodeEnvelope(JSON.parse(JSON.stringify(encodeEnvelope(envelope))))).not.toThrow()

    expect(envelope.aggregate).toEqual({ collection: 'pages', recordId: row.id })
    expect(envelope.causation).toEqual({ pipeline: 'createOne', op: 'createOne' })
    expect(typeof envelope.correlationId).toBe('string')
    expect(envelope.correlationId.length).toBeGreaterThan(0)
    expect(envelope.sequence).toBe(1)

    // No independent Date.now() read: occurredAt is bracketed by timestamps taken around the call.
    const occurredIso = encodeEnvelope(envelope).occurredAt
    expect(occurredIso >= before).toBe(true)
    expect(occurredIso <= after).toBe(true)
  })

  it('updateOne emits occurredAt identical to the record updatedAt — same facts.now source', () => {
    const db = seed()
    const row = create(db, pagesCollection, { title: 'Hello', path: '/hello', status: 'draft' }) as Record<string, unknown>
    const updated = update(db, pagesCollection, row.id as number, { title: 'Hello v2' }) as Record<string, unknown>

    const rows = readOutbox(db, 'content')
    expect(rows).toHaveLength(2)
    const updateEnvelope = rows[1]!.envelope
    const updatedAtIso = new Date(updated.updatedAt as string | number | Date).toISOString()
    expect(encodeEnvelope(updateEnvelope).occurredAt).toBe(updatedAtIso)
  })
})

describe('outbox: atomicity (load-bearing)', () => {
  it('a write whose persist fails (unique conflict) leaves zero rows for that write', () => {
    const db = seed()
    create(db, pagesCollection, { title: 'A', path: '/dup', status: 'draft' })
    expect(() => create(db, pagesCollection, { title: 'B', path: '/dup', status: 'draft' })).toThrow()

    const rows = readOutbox(db, 'content')
    expect(rows).toHaveLength(1) // only the first, successful write
  })

  it('a forced outbox-insert failure rolls back the record write too — same transaction', () => {
    const db = seed()
    const client = sqliteClientOf(db)
    client.exec(`DROP TABLE ${outboxTableName('content')}`)

    const before = (db.select().from(pagesCollection.table).all() as unknown[]).length
    expect(() => create(db, pagesCollection, { title: 'X', path: '/x', status: 'draft' })).toThrow()
    const after = (db.select().from(pagesCollection.table).all() as unknown[]).length

    expect(after).toBe(before) // the record insert must not have survived the outbox failure
  })
})

describe('outbox: sequence — gapless, monotonic, per aggregate', () => {
  it('three writes to the same aggregate get sequences 1, 2, 3', () => {
    const db = seed()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Record<string, unknown>
    update(db, pagesCollection, row.id as number, { title: 'A2' })
    update(db, pagesCollection, row.id as number, { title: 'A3' })

    const rows = readOutbox(db, 'content')
    const forRecord = rows
      .filter((r) => r.envelope.aggregate.recordId === row.id)
      .sort((a, b) => a.id - b.id)
    expect(forRecord.map((r) => r.envelope.sequence)).toEqual([1, 2, 3])
    expect(forRecord.map((r) => r.sequence)).toEqual([1, 2, 3]) // the raw column mirrors the envelope
  })

  it('interleaved writes to two aggregates stay gapless and monotonic independently', () => {
    const db = seed()
    const a = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Record<string, unknown>
    const b = create(db, postsCollection, { title: 'B', status: 'draft' }) as Record<string, unknown>
    update(db, pagesCollection, a.id as number, { title: 'A2' })
    update(db, postsCollection, b.id as number, { title: 'B2' })
    update(db, pagesCollection, a.id as number, { title: 'A3' })

    const rows = readOutbox(db, 'content')
    const seqFor = (collection: string, recordId: number) => rows
      .filter((r) => r.envelope.aggregate.collection === collection && r.envelope.aggregate.recordId === recordId)
      .sort((x, y) => x.id - y.id)
      .map((r) => r.envelope.sequence)

    expect(seqFor('pages', a.id as number)).toEqual([1, 2, 3])
    expect(seqFor('posts', b.id as number)).toEqual([1, 2])
  })
})

describe('outbox: create/update/delete each emit', () => {
  it('createOne, updateOne, deleteOne each leave a distinct envelope for the same aggregate', () => {
    const db = seed()
    const row = create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' }) as Record<string, unknown>
    update(db, pagesCollection, row.id as number, { title: 'A2' })
    remove(db, pagesCollection, row.id as number)

    const rows = readOutbox(db, 'content').sort((x, y) => x.id - y.id)
    expect(rows).toHaveLength(3)
    const [created, updated, deleted] = rows.map((r) => r.envelope)

    for (const e of [created, updated, deleted]) expect(e!.aggregate).toEqual({ collection: 'pages', recordId: row.id })
    expect(created!.name).toBe('pages.created')
    expect(updated!.name).toBe('pages.updated')
    expect(deleted!.name).toBe('pages.deleted')
    expect(new Set([created!.name, updated!.name, deleted!.name]).size).toBe(3)
    expect(deleted!.payload).toEqual(expect.objectContaining({ id: row.id })) // last known state (before), never null
  })
})

describe('outbox: ownership', () => {
  it('a foreign module cannot reach another module\'s outbox through the content adapter', () => {
    const db = seed()
    create(db, pagesCollection, { title: 'A', path: '/a', status: 'draft' })
    const client = sqliteClientOf(db)
    ensureOutboxTable(client, 'media') // a second module's outbox — content must never own this

    const svc = useContentDbFor(db)
    expect(svc.tables[outboxTableName('content')]).toBeDefined() // content DOES own its own outbox table

    expect(() => svc.db.prepare(`SELECT * FROM ${outboxTableName('media')}`).all()).toThrow(OwnershipViolation)
  })
})
