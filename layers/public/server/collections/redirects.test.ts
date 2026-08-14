import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { putSingleton, getSingleton } from '../../../core/server/utils/crud'
import { clearWriteListeners } from '../../../core/server/utils/write-events'
import { desiredSchema } from '../../../core/server/schema/desired'
import { diffSchema } from '../../../core/server/schema/diff'
import { renderSqlite } from '../../../core/server/schema/render-sqlite'
import built from './redirects'

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
    for (const stmt of renderSqlite(diffSchema(desiredSchema([built.table]), {}))) sqlite.exec(stmt)
    db = drizzle(sqlite)
    clearWriteListeners()
  })

  const put = (body: unknown) => putSingleton(db, built, undefined, body)
  const read = () => getSingleton(db, built, undefined, false, 0, false) as Record<string, unknown>

  it('rejects an uncompilable rule on CREATE, before any row exists', () => {
    expect(() => put({ rules: [{ from: '/blog/*', to: '/artikel/$2', status: '301' }] }))
      .toThrowError(expect.objectContaining({ statusCode: 400 }))
    expect(read()).toBeNull()
  })

  it('rejects one on UPDATE too, leaving the stored rules untouched', () => {
    put({ rules: [{ from: '/a', to: '/b', status: '301' }] })
    expect(() => put({ rules: [{ from: '/a?x=1', to: '/b', status: '301' }] }))
      .toThrowError(expect.objectContaining({ statusCode: 400 }))
    expect(read().rules).toEqual([{ from: '/a', to: '/b', status: '301' }])
  })

  it('round-trips a valid rule set in authored order', () => {
    put({ rules: [{ from: '/b/**', to: 'https://neu.example.com/$1', status: '308' }, { from: '/a', to: '/1', status: '302' }] })
    expect(read().rules).toEqual([
      { from: '/b/**', to: 'https://neu.example.com/$1', status: '308' },
      { from: '/a', to: '/1', status: '302' },
    ])
  })
})
