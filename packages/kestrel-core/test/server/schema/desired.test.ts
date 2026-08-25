import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { desiredSchema, desiredTable } from '../../../src/server/schema/desired.js'
import { introspect, type IntrospectDb } from '../../../src/server/schema/introspect.js'
import { diffSchema } from '../../../src/server/schema/diff.js'
import { renderSqlite } from '../../../src/server/schema/render-sqlite.js'
import { buildTable, defineCollection } from '../../../src/index.js'

// better-sqlite3's `pragma()` returns `unknown`; `IntrospectDb` narrows it to `Row[]` — cast at the crossing.
function asIntrospectDb(db: Database.Database): IntrospectDb {
  return db as unknown as IntrospectDb
}

const pagesTable = buildTable(defineCollection({
  name: 'pages', mode: 'multi', translatable: true, pageLike: true, seo: true, blocks: { enabled: true }, status: true,
  fields: { title: { type: 'text', required: true } },
}))

describe('desiredTable — getTableConfig → normalized shape', () => {
  const t = desiredTable(pagesTable)
  const col = (n: string) => t.columns.find((c) => c.name === n)
  const idx = (n: string) => t.indexes.find((i) => i.name === n)

  it('maps the id column to an autoincrement integer primary key', () => {
    expect(col('id')).toEqual({ name: 'id', type: 'integer', notNull: true, primaryKey: true, autoIncrement: true, default: null })
  })
  it('renders string and sql defaults to their DDL tokens', () => {
    expect(col('status')!.default).toBe("'draft'")
    expect(col('seo')!.default).toBe("'{}'")
    expect(col('content')!.default).toBe("'[]'")
  })
  it('carries declared indexes incl. uniqueness and the partial WHERE', () => {
    expect(idx('pages_group_locale')).toEqual({ name: 'pages_group_locale', table: 'pages', columns: ['translation_group', 'locale'], unique: true, where: null })
    expect(idx('pages_path_locale')).toEqual({ name: 'pages_path_locale', table: 'pages', columns: ['path', 'locale'], unique: true, where: 'path is not null' })
    expect(idx('pages_group')!.unique).toBe(false)
  })
})

describe('desiredTable — column-level .unique() becomes a named unique index', () => {
  const things = buildTable(defineCollection({
    name: 'things', mode: 'multi', translatable: false, fields: { slug: { type: 'text', required: true, unique: true } },
  }))
  it('synthesizes <table>_<col>_unique matching drizzle-kit naming', () => {
    expect(desiredTable(things).indexes).toContainEqual({ name: 'things_slug_unique', table: 'things', columns: ['slug'], unique: true, where: null })
  })
  it('round-trips: render → apply → introspect → no further diff (incl. the unique index)', () => {
    const desired = desiredSchema([things])
    const db = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desired, {}))) db.exec(stmt)
    expect(diffSchema(desired, introspect(asIntrospectDb(db)))).toEqual([])
    db.close()
  })
})

describe('desiredSchema — diverse field types round-trip (consumer collections)', () => {
  const widgets = buildTable(defineCollection({
    name: 'widgets', mode: 'multi', translatable: false,
    fields: {
      title: { type: 'text' },
      count: { type: 'number' },
      ratio: { type: 'number', options: { integer: false } },
      active: { type: 'boolean' },
      publishedAt: { type: 'datetime' },
      cover: { type: 'media' },
      tags: { type: 'choice', options: { multiple: true, choices: [{ value: 'a' }, { value: 'b' }] } },
      meta: { type: 'json' },
    },
  }))

  it('maps each field type to the right sqlite column type', () => {
    const cols = Object.fromEntries(desiredTable(widgets).columns.map((c) => [c.name, c.type]))
    expect(cols.count).toBe('integer')
    expect(cols.ratio).toBe('real')
    expect(cols.active).toBe('integer') // boolean stored as integer
    expect(cols.published_at).toBe('text')
    expect(cols.cover_id).toBe('integer') // single media → <name>_id
    expect(cols.tags).toBe('text') // multiple choice → json array
    expect(cols.meta).toBe('text')
  })

  it('round-trips with NO phantom rebuild — adapter and introspect agree on every column', () => {
    const desired = desiredSchema([widgets])
    const db = new Database(':memory:')
    for (const stmt of renderSqlite(diffSchema(desired, {}))) db.exec(stmt)
    expect(diffSchema(desired, introspect(asIntrospectDb(db)))).toEqual([])
    db.close()
  })

  it('surfaces a field renamedFrom hint as the column renamedFrom', () => {
    const def = defineCollection({ name: 'r', mode: 'multi', translatable: false, fields: { body: { type: 'text', renamedFrom: 'content' } } })
    expect(desiredTable(buildTable(def), def).columns.find((c) => c.name === 'body')?.renamedFrom).toBe('content')
  })
})
