import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { clearRegistry, desiredSchema, diffSchema, getResolvedKestrelConfig, registerCollection, renderSqlite, resetDbInstance, setResolvedKestrelConfig, useDb } from '@michaelthielemann/kestrel-core'
import { patternToRegexSource, redirectsCollection as redirects } from '@michaelthielemann/kestrel-publishing'

// A server route driven by auto-imports; stub them as globals (the seam the Nitro build provides) so the
// handler runs as a plain function.
let sqlite: Database.Database
let handler: (event: unknown) => unknown
let renderRedirects: (read: () => unknown) => string
const headers: Record<string, string> = {}

const save = (rules: unknown) =>
  sqlite.prepare('INSERT INTO redirects (singleton_key, rules, created_at, updated_at) VALUES (?, ?, 0, 0)')
    .run('redirects', JSON.stringify(rules))

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (h: (event: unknown) => unknown) => h)
  vi.stubGlobal('setHeader', (_e: unknown, k: string, v: string) => { headers[k] = v })
  const mod = await import('./redirects.json.get')
  handler = mod.default as (event: unknown) => unknown
  renderRedirects = mod.renderRedirects
})

beforeEach(() => {
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
  resetDbInstance()
  const db = useDb() as unknown as BetterSQLite3Database
  sqlite = (db as unknown as { $client: Database.Database }).$client
  for (const stmt of renderSqlite(diffSchema(desiredSchema([redirects.table]), {}))) sqlite.exec(stmt)
  clearRegistry()
  registerCollection(redirects)
})

const parse = () => JSON.parse(handler({}) as string) as unknown[]

describe('the /redirects.json route', () => {
  it('serves the compiled rules as JSON', () => {
    save([{ from: '/blog/*', to: '/artikel/$1', status: '301' }])
    expect(parse()).toEqual([{ pattern: patternToRegexSource('/blog/*'), target: '/artikel/$1', status: 301 }])
    expect(headers['content-type']).toBe('application/json; charset=utf-8')
  })

  it('serves `[]` when the singleton has never been saved', () => {
    expect(handler({})).toBe('[]')
  })

  it('serves `[]` when the collection is not registered at all', () => {
    clearRegistry()
    expect(handler({})).toBe('[]')
  })

  it('preserves authored order — the edge takes the first match', () => {
    save([{ from: '/a', to: '/1' }, { from: '/b', to: '/2' }])
    expect(parse().map((r) => (r as { target: string }).target)).toEqual(['/1', '/2'])
  })
})

describe('the /redirects.json route — an unreadable table', () => {
  const throwing = (message: string) => () => { throw new Error(message) }

  it('serves `[]` only when the table is provably absent — a consumer generating before `db:migrate`', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(renderRedirects(throwing('no such table: redirects'))).toBe('[]')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('rethrows any other read failure — `[]` would overwrite the live artifact with "no redirects"', () => {
    expect(() => renderRedirects(throwing('SQLITE_IOERR: disk I/O error'))).toThrow(/disk I\/O/)
    expect(() => renderRedirects(throwing('no such column: rules'))).toThrow(/no such column/)
  })

  it('drops an unpublishable stored rule but still publishes the rest', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = JSON.parse(renderRedirects(() => [{ from: '/a', to: '/b' }, { from: '/x', to: '/y/${1}' }])) as unknown[]
    expect(body).toHaveLength(1)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('the /redirects.json route — a missing table through the real handler', () => {
  beforeEach(() => { sqlite.exec('DROP TABLE redirects') })

  it('serves `[]` rather than a 500 that would cost the deploy its reconcile', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(handler({})).toBe('[]')
    warn.mockRestore()
  })
})
