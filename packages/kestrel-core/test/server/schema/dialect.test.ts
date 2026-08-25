import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { sqlite, postgres, resolveDialect, type Dialect } from '../../../src/server/schema/dialect.js'
import { renderSqlite } from '../../../src/server/schema/render-sqlite.js'
import { introspect } from '../../../src/server/schema/introspect.js'
import { diffSchema } from '../../../src/server/schema/diff.js'
import { syncSchema, planOps, type SyncDb } from '../../../src/server/schema/sync.js'
import { desiredSchema } from '../../../src/server/schema/desired.js'
import { buildTable, defineCollection } from '../../../src/index.js'

// better-sqlite3's `pragma()` returns `unknown`; `SyncDb` narrows it to `Row[]` (see introspect.ts) — cast at the crossing.
function asSyncDb(db: Database.Database): SyncDb {
  return db as unknown as SyncDb
}

const things = buildTable(defineCollection({
  name: 'things', mode: 'multi', translatable: false,
  fields: { slug: { type: 'text', required: true, unique: true }, title: { type: 'text' } },
}))
const ops = diffSchema(desiredSchema([things]), {})

describe('sqlite dialect', () => {
  it('identifies as sqlite', () => {
    expect(sqlite.name).toBe('sqlite')
  })

  it('render delegates to the SQLite renderer (same DDL)', () => {
    expect(sqlite.render(ops)).toEqual(renderSqlite(ops))
  })

  it('introspect delegates to the SQLite introspector (same snapshot)', () => {
    const db = new Database(':memory:')
    for (const stmt of renderSqlite(ops)) db.exec(stmt)
    expect(sqlite.introspect(asSyncDb(db))).toEqual(introspect(asSyncDb(db)))
    db.close()
  })

  it('quotes identifiers with backticks (doubling embedded backticks)', () => {
    expect(sqlite.quote('a`b')).toBe('`a``b`')
  })
})

describe('postgres slot (reserved, fail-loud)', () => {
  it('identifies as postgres', () => {
    expect(postgres.name).toBe('postgres')
  })

  it('render throws a clear not-implemented error', () => {
    expect(() => postgres.render(ops)).toThrow(/postgres/i)
  })

  it('introspect throws a clear not-implemented error', () => {
    const db = new Database(':memory:')
    expect(() => postgres.introspect(asSyncDb(db))).toThrow(/postgres/i)
    db.close()
  })

  it('quotes identifiers with double-quotes (the one part that is trivially correct)', () => {
    expect(postgres.quote('a"b')).toBe('"a""b"')
  })
})

describe('resolveDialect', () => {
  it('resolves the known dialects by name', () => {
    expect(resolveDialect('sqlite')).toBe(sqlite)
    expect(resolveDialect('postgres')).toBe(postgres)
  })

  it('throws a clear error naming the supported dialects for an unknown name', () => {
    expect(() => resolveDialect('mysql')).toThrow(/sqlite/)
  })
})

describe('sync threads the dialect (the seam)', () => {
  it('drives introspect + render through the injected dialect, producing identical output', () => {
    const db = new Database(':memory:')
    let introspectCalls = 0
    let renderCalls = 0
    const spy: Dialect = {
      name: 'spy',
      quote: sqlite.quote,
      introspect: (conn) => { introspectCalls++; return sqlite.introspect(conn) },
      render: (o) => { renderCalls++; return sqlite.render(o) },
    }
    const desired = desiredSchema([things])
    const { applied } = syncSchema(asSyncDb(db), desired, {}, spy)
    expect(introspectCalls).toBeGreaterThan(0)
    expect(renderCalls).toBeGreaterThan(0)
    expect(applied.some((s) => s.startsWith('CREATE TABLE `things`'))).toBe(true)
    // the dialect-default path produces the same DDL
    const fresh = new Database(':memory:')
    expect(syncSchema(asSyncDb(fresh), desired).applied).toEqual(applied)
    db.close(); fresh.close()
  })

  it('planOps reads the live schema through the injected dialect', () => {
    const db = new Database(':memory:')
    let introspectCalls = 0
    const spy: Dialect = {
      name: 'spy', quote: sqlite.quote, render: sqlite.render,
      introspect: (conn) => { introspectCalls++; return sqlite.introspect(conn) },
    }
    expect(planOps(asSyncDb(db), desiredSchema([things]), spy).length).toBeGreaterThan(0)
    expect(introspectCalls).toBe(1)
    db.close()
  })

  it('the postgres slot makes syncSchema fail loud rather than silently emit SQLite DDL', () => {
    const db = new Database(':memory:')
    expect(() => syncSchema(asSyncDb(db), desiredSchema([things]), {}, postgres)).toThrow(/postgres/i)
    db.close()
  })
})
