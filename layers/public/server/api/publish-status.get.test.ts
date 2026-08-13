import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { desiredSchema } from '../../../core/server/schema/desired'
import { diffSchema } from '../../../core/server/schema/diff'
import { renderSqlite } from '../../../core/server/schema/render-sqlite'

const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: false, pageLike: true, status: true, fields: { title: { type: 'text' } },
}))

interface FakeEvent { query: Record<string, unknown> }

let db: BetterSQLite3Database
let sqlite: Database.Database
let publishOnSave = false

Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  getQuery: (event: FakeEvent) => event.query,
  getCollection: (name: string) => (name === 'pages' ? pages : null),
  useDb: () => db,
  primaryLocale: () => 'en',
  prefixPrimaryLocale: () => false,
  useRuntimeConfig: () => ({ kestrel: { output: { driver: 'local', auto: true, publishOnSave } } }),
})

const handler = (await import('./publish-status.get')).default as unknown as (event: FakeEvent) => Record<string, unknown>
const get = (id: number) => handler({ query: { collection: 'pages', id: String(id) } })

/** `savedAt` in ms (the record's own stamp), `publishedAt` in whole seconds (publish_status's own unit). */
function seed(id: number, savedAt: number, publishedAt?: number): void {
  sqlite.prepare('INSERT INTO pages (id, path, status, title, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(id, `/p${id}`, 'published', `T${id}`, savedAt)
  if (publishedAt !== undefined) {
    sqlite.prepare("INSERT INTO publish_status (route, status, target, updated_at) VALUES (?, 'success', 'local', ?)")
      .run(`/p${id}`, publishedAt)
  }
}

beforeEach(() => {
  publishOnSave = false
  sqlite = new Database(':memory:')
  const desired = desiredSchema([pages.table], new Map([['pages', pages.def]]) as never)
  for (const stmt of renderSqlite(diffSchema(desired, {}))) sqlite.exec(stmt)
  sqlite.exec('CREATE TABLE publish_status (route TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, error TEXT, target TEXT NOT NULL, updated_at INTEGER NOT NULL)')
  db = drizzle(sqlite)
})

describe('GET /api/publish-status — unpublished changes', () => {
  it('flags a record that was saved after its page was last published', () => {
    seed(1, 60_000, 10) // saved at 60s, published at 10s
    expect(get(1)).toMatchObject({ route: '/p1', status: 'success', pending: true })
  })

  it('does not flag a page whose publish is current', () => {
    seed(2, 10_000, 60)
    expect(get(2)).toMatchObject({ pending: false })
  })

  it('does not flag a page that was never published (nothing to fall behind)', () => {
    seed(3, 10_000)
    expect(get(3)).toMatchObject({ route: '/p3', status: null, pending: false })
  })

  // With `output.publishOnSave` a save republishes on its own, so "saved since the last publish" is a
  // republish in flight — the lamp must keep showing that, not an "Outdated" the user cannot act on.
  it('never flags unpublished changes when the consumer opted out of the split', () => {
    publishOnSave = true
    seed(4, 60_000, 10)
    expect(get(4)).toMatchObject({ pending: false, publishOnSave: true })
  })
})
