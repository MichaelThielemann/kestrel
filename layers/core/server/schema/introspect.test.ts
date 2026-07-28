import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { introspect } from './introspect'
import { renderSqlite } from './render-sqlite'
import { diffSchema } from './diff'
import type { ColumnShape, IndexShape, TableShape, SchemaSnapshot } from './model'

const col = (name: string, type: string, o: Partial<ColumnShape> = {}): ColumnShape =>
  ({ name, type, notNull: false, primaryKey: false, autoIncrement: false, default: null, ...o })
const idx = (name: string, table: string, columns: string[], o: Partial<IndexShape> = {}): IndexShape =>
  ({ name, table, columns, unique: false, where: null, ...o })
const table = (name: string, columns: ColumnShape[], indexes: IndexShape[] = []): TableShape =>
  ({ name, columns, indexes })
const snap = (...tables: TableShape[]): SchemaSnapshot =>
  Object.fromEntries(tables.map((t) => [t.name, t]))
const id = col('id', 'integer', { primaryKey: true, autoIncrement: true, notNull: true })

/** Build a fresh in-memory DB by applying the DDL that renderSqlite produces for `desired` vs empty. */
function applied(...tables: TableShape[]): Database.Database {
  const db = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(snap(...tables), {}))) db.exec(stmt)
  return db
}

describe('introspect (sqlite)', () => {
  it('reads columns: pk/autoincrement, notNull, default token, nullable', () => {
    const db = applied(table('posts', [
      id,
      col('title', 'text', { notNull: true }),
      col('status', 'text', { notNull: true, default: "'draft'" }),
      col('slug', 'text'),
    ]))
    const cols = introspect(db).posts.columns
    const by = (n: string) => cols.find((c) => c.name === n)
    expect(by('id')).toEqual({ name: 'id', type: 'integer', notNull: true, primaryKey: true, autoIncrement: true, default: null })
    expect(by('status')).toEqual({ name: 'status', type: 'text', notNull: true, primaryKey: false, autoIncrement: false, default: "'draft'" })
    expect(by('slug')!.notNull).toBe(false)
    db.close()
  })

  it('reads explicit indexes incl. UNIQUE + partial WHERE; column order preserved', () => {
    const db = applied(table('pages',
      [id, col('path', 'text'), col('locale', 'text', { notNull: true }), col('translation_group', 'text', { notNull: true })],
      [
        idx('pages_group_locale', 'pages', ['translation_group', 'locale'], { unique: true }),
        idx('pages_path_locale', 'pages', ['path', 'locale'], { unique: true, where: 'path is not null' }),
        idx('pages_group', 'pages', ['translation_group']),
      ],
    ))
    const idxs = introspect(db).pages.indexes
    const by = (n: string) => idxs.find((i) => i.name === n)
    expect(by('pages_path_locale')).toEqual({ name: 'pages_path_locale', table: 'pages', columns: ['path', 'locale'], unique: true, where: 'path is not null' })
    expect(by('pages_group')).toEqual({ name: 'pages_group', table: 'pages', columns: ['translation_group'], unique: false, where: null })
    expect(idxs).toHaveLength(3)
    db.close()
  })

  it('ignores sqlite internal tables (e.g. sqlite_sequence from AUTOINCREMENT)', () => {
    const db = applied(table('posts', [id, col('title', 'text', { notNull: true })]))
    expect(Object.keys(introspect(db))).toEqual(['posts'])
    db.close()
  })

  it('round-trip: applying a desired schema then re-diffing against it yields no further ops', () => {
    const pages = table('pages',
      [
        id,
        col('locale', 'text', { notNull: true }),
        col('translation_group', 'text', { notNull: true }),
        col('path', 'text'),
        col('title', 'text', { notNull: true }),
        col('status', 'text', { notNull: true, default: "'draft'" }),
        col('seo', 'text', { notNull: true, default: "'{}'" }),
        col('content', 'text', { notNull: true, default: "'[]'" }),
      ],
      [
        idx('pages_group_locale', 'pages', ['translation_group', 'locale'], { unique: true }),
        idx('pages_path_locale', 'pages', ['path', 'locale'], { unique: true, where: 'path is not null' }),
        idx('pages_group', 'pages', ['translation_group']),
      ],
    )
    const db = applied(pages)
    expect(diffSchema(snap(pages), introspect(db))).toEqual([])
    db.close()
  })

  it('returns an empty snapshot for an empty database', () => {
    const db = new Database(':memory:')
    expect(introspect(db)).toEqual({})
    db.close()
  })
})
