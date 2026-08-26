import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { clearFieldPopulators, clearRegistry, create, defineCollection, desiredSchema, diffSchema, getFieldPopulator, getResolvedKestrelConfig, outboxContent, registerCollection, renderSqlite, resetDbInstance, revisionsTable, setResolvedKestrelConfig, useDb, buildCollection  } from '@michaelthielemann/kestrel-core'
import type { FieldDef } from '@michaelthielemann/kestrel-core'
import { publicReadableResources, isPubliclyReadable } from '@michaelthielemann/kestrel-access'

const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: false, pageLike: true,
  fields: { title: { type: 'text', required: true } },
}))
// `authors` is deliberately non-pageLike: the negative fixture for the public-set check.
const authors = buildCollection(defineCollection({
  name: 'authors', mode: 'multi', translatable: false,
  fields: { name: { type: 'text', required: true }, email: { type: 'text' } },
}))

const postsDef = defineCollection({
  name: 'posts', mode: 'multi', translatable: false,
  fields: {
    author: { type: 'relation', relation: { collection: 'authors' } },
    related: { type: 'relation', relation: { collection: 'pages' } },
  },
})

let db: BetterSQLite3Database

// The plugin is a Nitro plugin: its auto-imported helpers are plain globals in a node test. The access
// helpers are bound to the REAL implementations so this proves the populator's public set IS the guard's.
// `useDb` is the package's real singleton (see beforeEach): the populator reads it internally too.
Object.assign(globalThis, {
  defineNitroPlugin: (fn: unknown) => fn,
  publicReadableResources,
  isPubliclyReadable,
})

const plugin = (await import('./02.register-relation-populate')).default as unknown as () => void

let authorId: number
let pageId: number

beforeEach(() => {
  clearRegistry()
  clearFieldPopulators()
  setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
  resetDbInstance()
  db = useDb() as unknown as BetterSQLite3Database
  const sqlite = (db as unknown as { $client: Database.Database }).$client
  for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, pages.table, authors.table, revisionsTable('pages'), revisionsTable('authors')]), {}))) sqlite.exec(stmt)
  registerCollection(pages)
  registerCollection(authors)
  authorId = (create(db, authors, { name: 'Ada', email: 'ada@example.com' }) as Record<string, unknown>).id as number
  pageId = (create(db, pages, { title: 'Home' }) as Record<string, unknown>).id as number
  plugin()
})
afterEach(() => {
  clearRegistry()
  clearFieldPopulators()
})

const relationField = (collection: string): FieldDef => ({ type: 'relation', relation: { collection } })

function expand(key: string, collection: string, bag: Record<string, unknown>, publicOnly?: boolean): Record<string, unknown> {
  getFieldPopulator('relation')!(bag, key, relationField(collection), { depth: 1, locale: 'en', def: postsDef, publicOnly }, 'columns')
  return bag
}

describe('02.register-relation-populate', () => {
  it('registers the relation field populator', () => {
    expect(getFieldPopulator('relation')).toBeTypeOf('function')
  })

  it('expands a relation into a non-pageLike collection for an unrestricted read', () => {
    const bag = expand('author', 'authors', { authorId })
    expect((bag.$author as Record<string, unknown>).email).toBe('ada@example.com')
  })

  it('withholds a relation into a collection outside the registry-driven public set', () => {
    const bag = expand('author', 'authors', { authorId }, true)
    expect('$author' in bag).toBe(false)
    expect(bag.authorId).toBe(authorId)
  })

  it('expands a relation into a pageLike collection under the same public-only read', () => {
    const bag = expand('related', 'pages', { relatedId: pageId }, true)
    expect((bag.$related as Record<string, unknown>).title).toBe('Home')
  })
})
