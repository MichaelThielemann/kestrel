import { describe, it, expect } from 'vitest'
import { diffSchema } from '../../../src/server/schema/diff.js'
import { renderSqlite } from '../../../src/server/schema/render-sqlite.js'
import type { ColumnShape, IndexShape, TableShape, SchemaSnapshot } from '../../../src/server/schema/model.js'

const col = (name: string, type: string, o: Partial<ColumnShape> = {}): ColumnShape =>
  ({ name, type, notNull: false, primaryKey: false, autoIncrement: false, default: null, ...o })
const idx = (name: string, table: string, columns: string[], o: Partial<IndexShape> = {}): IndexShape =>
  ({ name, table, columns, unique: false, where: null, ...o })
const table = (name: string, columns: ColumnShape[], indexes: IndexShape[] = []): TableShape =>
  ({ name, columns, indexes })
const snap = (...tables: TableShape[]): SchemaSnapshot =>
  Object.fromEntries(tables.map((t) => [t.name, t]))

const id = col('id', 'integer', { primaryKey: true, autoIncrement: true, notNull: true })

describe('diffSchema — additive', () => {
  it('a table missing from actual becomes create_table + a create_index per index', () => {
    const posts = table('posts', [id, col('title', 'text', { notNull: true })], [idx('posts_title', 'posts', ['title'])])
    expect(diffSchema(snap(posts), {})).toEqual([
      { type: 'create_table', table: posts },
      { type: 'create_index', index: posts.indexes[0] },
    ])
  })

  it('a column present only in desired becomes a single add_column', () => {
    const slug = col('slug', 'text')
    const desired = table('posts', [id, col('title', 'text'), slug])
    const actual = table('posts', [id, col('title', 'text')])
    expect(diffSchema(snap(desired), snap(actual))).toEqual([{ type: 'add_column', table: 'posts', column: slug }])
  })

  it('an index present only in desired becomes create_index; one only in actual becomes drop_index', () => {
    const add = idx('posts_a', 'posts', ['title'])
    const stale = idx('posts_old', 'posts', ['title'])
    const desired = table('posts', [id], [add])
    const actual = table('posts', [id], [stale])
    expect(diffSchema(snap(desired), snap(actual))).toEqual([
      { type: 'drop_index', index: stale },
      { type: 'create_index', index: add },
    ])
  })

  it('an index whose definition drifted (same name) is dropped then recreated', () => {
    const want = idx('posts_i', 'posts', ['a', 'b'], { unique: true })
    const have = idx('posts_i', 'posts', ['a'], { unique: true })
    const ops = diffSchema(snap(table('posts', [id], [want])), snap(table('posts', [id], [have])))
    expect(ops).toEqual([
      { type: 'drop_index', index: have },
      { type: 'create_index', index: want },
    ])
  })

  it('returns no ops for identical schemas', () => {
    const t = table('posts', [id, col('title', 'text', { notNull: true })], [idx('posts_title', 'posts', ['title'])])
    expect(diffSchema(snap(t), snap(t))).toEqual([])
  })

  it('emits ops in apply-safe phase order: create_table → add_column → drop_index → create_index', () => {
    const a = table('a', [id], [idx('a_id', 'a', ['id'])])
    const b = table('b', [id, col('name', 'text')], [idx('b_name', 'b', ['name'])])
    const actual = snap(table('b', [id], []))
    expect(diffSchema(snap(a, b), actual)).toEqual([
      { type: 'create_table', table: a },
      { type: 'add_column', table: 'b', column: col('name', 'text') },
      { type: 'create_index', index: a.indexes[0] },
      { type: 'create_index', index: b.indexes[0] },
    ])
  })
})

describe('diffSchema — destructive', () => {
  it('a table present only in actual becomes drop_table', () => {
    const a = table('a', [id])
    const gone = table('gone', [id, col('x', 'text')])
    expect(diffSchema(snap(a), snap(a, gone))).toEqual([{ type: 'drop_table', name: 'gone' }])
  })

  it('a drifted column definition (same name) triggers a rebuild copying the surviving columns', () => {
    const desired = table('posts', [id, col('title', 'text', { notNull: true })])
    const actual = table('posts', [id, col('title', 'integer')]) // type + notNull drifted
    expect(diffSchema(snap(desired), snap(actual))).toEqual([
      { type: 'rebuild_table', table: desired, copy: ['id', 'title'] },
    ])
  })

  it('a dropped column triggers a rebuild copying only the columns that remain', () => {
    const desired = table('posts', [id, col('title', 'text')])
    const actual = table('posts', [id, col('title', 'text'), col('legacy', 'text')])
    expect(diffSchema(snap(desired), snap(actual))).toEqual([
      { type: 'rebuild_table', table: desired, copy: ['id', 'title'] },
    ])
  })

  it('a rebuild absorbs a simultaneously-added column (copy = intersection only)', () => {
    const desired = table('posts', [id, col('added', 'text')])
    const actual = table('posts', [id, col('removed', 'text')])
    expect(diffSchema(snap(desired), snap(actual))).toEqual([
      { type: 'rebuild_table', table: desired, copy: ['id'] },
    ])
  })

  it('a purely additive change stays additive (no rebuild)', () => {
    const desired = table('posts', [id, col('title', 'text'), col('slug', 'text')])
    const actual = table('posts', [id, col('title', 'text')])
    expect(diffSchema(snap(desired), snap(actual))).toEqual([{ type: 'add_column', table: 'posts', column: col('slug', 'text') }])
  })

  it('orders additive ops before destructive ones', () => {
    const fresh = table('fresh', [id])
    const drift = table('drift', [id, col('v', 'text', { notNull: true })])
    const actual = snap(table('drift', [id, col('v', 'integer')]), table('legacy', [id]))
    expect(diffSchema(snap(fresh, drift), actual)).toEqual([
      { type: 'create_table', table: fresh },
      { type: 'rebuild_table', table: drift, copy: ['id', 'v'] },
      { type: 'drop_table', name: 'legacy' },
    ])
  })
})

describe('diffSchema — renames', () => {
  it('renames a column in place (data-preserving) when nothing else changed — no rebuild', () => {
    const desired = table('posts', [id, col('body', 'text', { renamedFrom: 'content' })])
    const actual = table('posts', [id, col('content', 'text')])
    expect(diffSchema(snap(desired), snap(actual))).toEqual([
      { type: 'rename_column', table: 'posts', from: 'content', to: 'body' },
    ])
  })

  it('renames first, then rebuilds when the rename coincides with a dropped column (copy uses the new name)', () => {
    const desired = table('posts', [id, col('body', 'text', { renamedFrom: 'content' })])
    const actual = table('posts', [id, col('content', 'text'), col('legacy', 'text')])
    expect(diffSchema(snap(desired), snap(actual))).toEqual([
      { type: 'rename_column', table: 'posts', from: 'content', to: 'body' },
      { type: 'rebuild_table', table: desired, copy: ['id', 'body'] },
    ])
  })

  it('treats renamedFrom as a new column when the old name is absent', () => {
    const desired = table('posts', [id, col('body', 'text', { renamedFrom: 'gone' })])
    const actual = table('posts', [id])
    expect(diffSchema(snap(desired), snap(actual))).toEqual([
      { type: 'add_column', table: 'posts', column: col('body', 'text', { renamedFrom: 'gone' }) },
    ])
  })

  it('a field re-using a name just freed by a rename is still created (not mistaken for the renamed-away column)', () => {
    const newTitle = col('title', 'text')
    const desired = table('posts', [id, col('headline', 'text', { renamedFrom: 'title' }), newTitle])
    const actual = table('posts', [id, col('title', 'text')])
    expect(diffSchema(snap(desired), snap(actual))).toEqual([
      { type: 'rename_column', table: 'posts', from: 'title', to: 'headline' },
      { type: 'add_column', table: 'posts', column: newTitle },
    ])
  })
})

describe('diff + render reproduces a known migration (pages)', () => {
  it('renders the committed pages CREATE TABLE + indexes from a desired-vs-empty diff', () => {
    const pages = table(
      'pages',
      [
        id,
        col('locale', 'text', { notNull: true }),
        col('translation_group', 'text', { notNull: true }),
        col('path', 'text'),
        col('title', 'text', { notNull: true }),
        col('status', 'text', { notNull: true, default: "'draft'" }),
        col('seo', 'text', { notNull: true, default: "'{}'" }),
        col('content', 'text', { notNull: true, default: "'[]'" }),
        col('created_at', 'integer', { notNull: true }),
        col('updated_at', 'integer', { notNull: true }),
      ],
      [
        idx('pages_group_locale', 'pages', ['translation_group', 'locale'], { unique: true }),
        idx('pages_path_locale', 'pages', ['path', 'locale'], { unique: true, where: 'path is not null' }),
        idx('pages_group', 'pages', ['translation_group']),
      ],
    )
    expect(renderSqlite(diffSchema(snap(pages), {}))).toEqual([
      'CREATE TABLE `pages` (\n'
      + '  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n'
      + '  `locale` text NOT NULL,\n'
      + '  `translation_group` text NOT NULL,\n'
      + '  `path` text,\n'
      + '  `title` text NOT NULL,\n'
      + "  `status` text DEFAULT 'draft' NOT NULL,\n"
      + "  `seo` text DEFAULT '{}' NOT NULL,\n"
      + "  `content` text DEFAULT '[]' NOT NULL,\n"
      + '  `created_at` integer NOT NULL,\n'
      + '  `updated_at` integer NOT NULL\n'
      + ');',
      'CREATE UNIQUE INDEX `pages_group_locale` ON `pages` (`translation_group`,`locale`);',
      'CREATE UNIQUE INDEX `pages_path_locale` ON `pages` (`path`,`locale`) WHERE path is not null;',
      'CREATE INDEX `pages_group` ON `pages` (`translation_group`);',
    ])
  })
})
