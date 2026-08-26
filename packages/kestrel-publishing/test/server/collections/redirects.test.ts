import { describe, it, expect, beforeEach } from 'vitest'
import type { ValidationFailed } from '@michaelthielemann/kestrel-contracts'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { clearPipelines, desiredSchema, diffSchema, getSingleton, outboxContent, putSingleton, renderSqlite, revisionsTable } from '@michaelthielemann/kestrel-core'
import built from '../../../src/server/collections/redirects.js'

const rules = (v: unknown) => built.insert.safeParse({ rules: v })

describe('redirects collection', () => {
  it('is a non-translatable built-in singleton', () => {
    expect(built.def.mode).toBe('single')
    expect(built.def.builtin).toBe(true)
    expect(built.def.translatable).toBeFalsy()
    expect(built.def.pageLike).toBeFalsy()
  })

  it('offers exactly the four supported statuses, defaulting to 301', () => {
    const status = (built.def.fields.rules as { options: { fields: Record<string, { options?: { choices?: { value: string }[] }; default?: unknown }> } })
      .options.fields.status!
    expect(status.options!.choices!.map((c) => c.value)).toEqual(['301', '302', '307', '308'])
    expect(status.default).toBe('301')
  })

  it('accepts an empty rule list — zero redirects is a supported state', () => {
    expect(rules([]).success).toBe(true)
  })

  it('accepts a well-formed row', () => {
    expect(rules([{ from: '/blog/*', to: '/artikel/$1', status: '301' }]).success).toBe(true)
  })

  it('rejects a row with a blank source or target', () => {
    expect(rules([{ from: '', to: '/b', status: '301' }]).success).toBe(false)
    expect(rules([{ from: '/a', to: '   ', status: '301' }]).success).toBe(false)
    expect(rules([{ to: '/b', status: '301' }]).success).toBe(false)
  })

  it('rejects a status outside the four choices', () => {
    expect(rules([{ from: '/a', to: '/b', status: '303' }]).success).toBe(false)
  })
})

describe('redirects collection — pre-write rule validation', () => {
  const issues = (rules: unknown) => built.applyConditions!({ rules }).issues

  it('passes a compilable rule set', () => {
    expect(issues([{ from: '/blog/*', to: '/artikel/$1', status: '301' }])).toEqual([])
    expect(issues([])).toEqual([])
    expect(issues(undefined)).toEqual([])
  })

  it('reports an uncompilable rule against the repeater field, naming the row', () => {
    expect(issues([{ from: '/blog/*', to: '/artikel/$2', status: '301' }])).toEqual([
      { path: ['rules'], message: expect.stringMatching(/^Row 1: /) },
    ])
  })

  it('rejects a target scheme that would turn a redirect into a hazard', () => {
    expect(issues([{ from: '/a', to: 'javascript:alert(1)', status: '301' }])).toHaveLength(1)
  })
})

describe('redirects collection — through the real singleton write', () => {
  let db: ReturnType<typeof drizzle>

  beforeEach(() => {
    const sqlite = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, built.table, revisionsTable(built.def.name)]), {}))) sqlite.exec(stmt)
    db = drizzle(sqlite)
    clearPipelines()
  })

  const asDb = (d: typeof db): BetterSQLite3Database => d as unknown as BetterSQLite3Database
  const put = (body: unknown) => putSingleton(asDb(db), built, undefined, body)
  const read = () => getSingleton(asDb(db), built, undefined, false, 0, false) as Record<string, unknown>

  it('rejects an uncompilable rule on CREATE, before any row exists', async () => {
    await expect(put({ rules: [{ from: '/blog/*', to: '/artikel/$2', status: '301' }] }))
      .rejects.toMatchObject({ _tag: 'ValidationFailed' } as ValidationFailed)
    expect(read()).toBeNull()
  })

  it('rejects one on UPDATE too, leaving the stored rules untouched', async () => {
    await put({ rules: [{ from: '/a', to: '/b', status: '301' }] })
    await expect(put({ rules: [{ from: '/a?x=1', to: '/b', status: '301' }] }))
      .rejects.toMatchObject({ _tag: 'ValidationFailed' } as ValidationFailed)
    expect(read().rules).toEqual([{ from: '/a', to: '/b', status: '301' }])
  })

  it('round-trips a valid rule set in authored order', async () => {
    await put({ rules: [{ from: '/b/**', to: 'https://neu.example.com/$1', status: '308' }, { from: '/a', to: '/1', status: '302' }] })
    expect(read().rules).toEqual([
      { from: '/b/**', to: 'https://neu.example.com/$1', status: '308' },
      { from: '/a', to: '/1', status: '302' },
    ])
  })
})
