import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createError } from 'h3'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { buildCollection } from '../../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../utils/defineCollection'
import { create, resolveTranslations } from '../../utils/crud'
import { requireCollection } from '../../utils/http'
import { clearRegistry, registerCollection } from '../../utils/registry'
import { desiredSchema } from '../../schema/desired'
import { diffSchema } from '../../schema/diff'
import { renderSqlite } from '../../schema/render-sqlite'

const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: true, pageLike: true,
  fields: { title: { type: 'text', required: true } },
}))
const notes = buildCollection(defineCollection({
  name: 'notes', mode: 'multi', translatable: false,
  fields: { title: { type: 'text', required: true } },
}))

// `context.params` is where Nitro puts the route params the real `requireCollection` reads via h3.
interface FakeEvent { query: Record<string, unknown>; context: { params: Record<string, string> } }

let db: ReturnType<typeof drizzle>

// The handler is a Nitro route: its auto-imported helpers are plain globals in a node test — bound to the
// REAL implementations so nothing here can pass against a stub the server does not have.
Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  createError,
  getQuery: (event: FakeEvent) => event.query,
  useDb: () => db,
  requireCollection,
  resolveTranslations,
})

// Calling the handler directly says nothing about the path ever reaching it: that the literal `translations`
// segment wins over the sibling `[id]` route is only provable on a real server → `test/e2e/api.test.ts`.
const handler = (await import('./translations.get')).default as unknown as (event: FakeEvent) => Record<string, number | null>
const get = (collection: string, query: Record<string, unknown>) => handler({ query, context: { params: { collection } } })

beforeEach(() => {
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([pages.table, notes.table]), {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  clearRegistry()
  registerCollection(pages)
  registerCollection(notes)
})
afterEach(() => clearRegistry())

describe('GET /api/{collection}/translations?group=', () => {
  it('resolves the group\'s locale → sibling id map without a record id', () => {
    const en = create(db, pages, { title: 'Home' }) as Record<string, unknown>
    const de = create(db, pages, { title: 'Start', locale: 'de', translationGroup: en.translationGroup as string }) as Record<string, unknown>
    expect(get('pages', { group: en.translationGroup })).toEqual({ en: en.id, de: de.id })
  })

  it('reports a locale with no sibling as null (what the "+ create" affordance keys off)', () => {
    const en = create(db, pages, { title: 'Only EN' }) as Record<string, unknown>
    expect(get('pages', { group: en.translationGroup })).toEqual({ en: en.id, de: null })
  })

  it('returns exactly the per-record map for the same group (one map builder, two entry points)', () => {
    const en = create(db, pages, { title: 'Home' }) as Record<string, unknown>
    create(db, pages, { title: 'Start', locale: 'de', translationGroup: en.translationGroup as string })
    expect(get('pages', { group: en.translationGroup })).toEqual(resolveTranslations(db, pages, en.id as number))
  })

  it('400s without a group rather than answering for an arbitrary one', () => {
    expect(() => get('pages', {})).toThrowError(expect.objectContaining({ statusCode: 400 }))
    expect(() => get('pages', { group: '  ' })).toThrowError(expect.objectContaining({ statusCode: 400 }))
  })

  it('404s for a group that has no rows', () => {
    create(db, pages, { title: 'Home' })
    expect(() => get('pages', { group: 'nope' })).toThrowError(expect.objectContaining({ statusCode: 404 }))
  })

  it('400s (never 500s) for a collection without translations — it has no group column at all', () => {
    create(db, notes, { title: 'Note' })
    expect(() => get('notes', { group: 'g1' })).toThrowError(/Translations are not enabled/)
  })

  it('404s for an unknown collection', () => {
    expect(() => get('nope', { group: 'g1' })).toThrowError(expect.objectContaining({ statusCode: 404 }))
  })
})
