import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getFieldPopulator, clearFieldPopulators } from '../../../core/server/utils/populate'
import type { FieldDef } from '../../../core/server/utils/defineCollection'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { registerCollection, clearRegistry } from '../../../core/server/utils/registry'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { create } from '../../../core/server/utils/crud'
import { desiredSchema } from '../../../core/server/schema/desired'
import { diffSchema } from '../../../core/server/schema/diff'
import { renderSqlite } from '../../../core/server/schema/render-sqlite'
import { publicReadableResources } from '../../../access/server/utils/public-resources'
import { isPubliclyReadable } from '../../../access/server/utils/policy'

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

let db: ReturnType<typeof drizzle>

// The plugin is a Nitro plugin: its auto-imported helpers are plain globals in a node test. The access
// helpers are bound to the REAL implementations so this proves the populator's public set IS the guard's.
Object.assign(globalThis, {
  defineNitroPlugin: (fn: unknown) => fn,
  useDb: () => db,
  publicReadableResources,
  isPubliclyReadable,
})

const plugin = (await import('./02.register-relation-populate')).default as unknown as () => void

let authorId: number
let pageId: number

beforeEach(() => {
  clearRegistry()
  clearFieldPopulators()
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([pages.table, authors.table]), {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
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
