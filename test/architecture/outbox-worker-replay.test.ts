import { describe, it, expect, afterEach } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { allCollections, clearOutboxHandlers, clearRegistry, create, ensureRevisionsTable, pollOnce, readOutbox, registerCollection, registerOutboxHandler } from '@michaelthielemann/kestrel-core'
import { pagesCollection } from '@michaelthielemann/kestrel-collections'

// `outbox-durability.test.ts` proves the STORAGE layer survives SIGKILL, with a hand-rolled child
// re-deriving the write shape. This proves the other half — that a row written by the REAL pipeline write
// path (`create()` -> `persistStep` -> `emitOutboxForUnit`, the exact code every real write runs) is still
// there, and gets REPLAYED by the poller's handler, after the writing connection is gone and a fresh one
// opens the same file.
//
// What this does NOT prove: OS-level SIGKILL durability for the real path specifically (only the hand-
// rolled child in `outbox-durability.test.ts` was actually SIGKILLed) — no TS-executing loader is a
// committed project dependency, so the real TS pipeline cannot run in a spawned child (same constraint
// documented there). Instead the writing connection is closed in-process and a brand new
// `better-sqlite3.Database` is opened on the same file, which exercises the same on-disk durability path
// (WAL checkpoint + reopen) without the OS actually killing the process.
const migrationsFolder = resolve(process.cwd(), 'server/database/migrations')

function openFileDb(path: string): BetterSQLite3Database {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  for (const c of allCollections()) ensureRevisionsTable(sqlite, c.def.name)
  return db
}

let tmpDir: string | undefined

afterEach(() => {
  clearRegistry()
  clearOutboxHandlers()
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

describe('outbox worker: replay after the writing connection is gone', () => {
  it('a row written by the real persist path is picked up and delivered once the poller runs against a reopened file', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kestrel-outbox-replay-'))
    const dbPath = join(tmpDir, 'test.sqlite')

    clearRegistry()
    registerCollection(pagesCollection)
    const writer = openFileDb(dbPath)
    const written = create(writer, pagesCollection, { title: 'Replay me', path: '/replay-me', status: 'draft' }) as Record<string, unknown>
    ;(writer as unknown as { $client: Database.Database }).$client.close()

    const reader = openFileDb(dbPath)
    const pendingBeforePoll = readOutbox(reader, 'content')
    expect(pendingBeforePoll).toHaveLength(1)
    expect(pendingBeforePoll[0]!.processedAt).toBeNull()

    const delivered: unknown[] = []
    registerOutboxHandler('replay-probe', { event: 'pages.created' }, async (envelope) => {
      delivered.push(envelope.payload)
    })

    const result = await pollOnce(reader, 'content')
    expect(result).toEqual({ processed: 1, deadLettered: 0, skipped: 0 })
    expect(delivered).toEqual([expect.objectContaining({ id: written.id })])

    const afterPoll = readOutbox(reader, 'content')
    expect(afterPoll[0]!.processedAt).not.toBeNull()

    // Idempotency of the poll itself: a second poll against the already-processed row delivers nothing
    // again — replay-after-restart must not become double-delivery-on-every-tick.
    const secondPoll = await pollOnce(reader, 'content')
    expect(secondPoll).toEqual({ processed: 0, deadLettered: 0, skipped: 0 })
    expect(delivered).toHaveLength(1)

    ;(reader as unknown as { $client: Database.Database }).$client.close()
  })
})
