import { describe, it, expect } from 'vitest'
import { renderSqlite } from '../../../src/server/schema/render-sqlite.js'
import type { ColumnShape, IndexShape, TableShape } from '../../../src/server/schema/model.js'

const col = (name: string, type: string, o: Partial<ColumnShape> = {}): ColumnShape =>
  ({ name, type, notNull: false, primaryKey: false, autoIncrement: false, default: null, ...o })
const idx = (name: string, table: string, columns: string[], o: Partial<IndexShape> = {}): IndexShape =>
  ({ name, table, columns, unique: false, where: null, ...o })

describe('renderSqlite', () => {
  it('create_table: id is PRIMARY KEY AUTOINCREMENT; DEFAULT precedes NOT NULL', () => {
    const t: TableShape = {
      name: 'pages',
      columns: [
        col('id', 'integer', { primaryKey: true, autoIncrement: true, notNull: true }),
        col('title', 'text', { notNull: true }),
        col('status', 'text', { notNull: true, default: "'draft'" }),
      ],
      indexes: [],
    }
    expect(renderSqlite([{ type: 'create_table', table: t }])).toEqual([
      'CREATE TABLE `pages` (\n'
      + '  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n'
      + '  `title` text NOT NULL,\n'
      + "  `status` text DEFAULT 'draft' NOT NULL\n"
      + ');',
    ])
  })

  it('create_index: UNIQUE flag + partial WHERE; columns quoted and comma-joined', () => {
    expect(renderSqlite([{ type: 'create_index', index: idx('pages_path_locale', 'pages', ['path', 'locale'], { unique: true, where: 'path is not null' }) }]))
      .toEqual(['CREATE UNIQUE INDEX `pages_path_locale` ON `pages` (`path`,`locale`) WHERE path is not null;'])
    expect(renderSqlite([{ type: 'create_index', index: idx('posts_group', 'posts', ['translation_group']) }]))
      .toEqual(['CREATE INDEX `posts_group` ON `posts` (`translation_group`);'])
  })

  it('drop_index: DROP INDEX IF EXISTS', () => {
    expect(renderSqlite([{ type: 'drop_index', index: idx('posts_old', 'posts', ['x']) }]))
      .toEqual(['DROP INDEX IF EXISTS `posts_old`;'])
  })

  it('add_column: same column clause as a table column (nullable + notNull-with-default)', () => {
    expect(renderSqlite([{ type: 'add_column', table: 'posts', column: col('slug', 'text') }]))
      .toEqual(['ALTER TABLE `posts` ADD COLUMN `slug` text;'])
    expect(renderSqlite([{ type: 'add_column', table: 'posts', column: col('status', 'text', { notNull: true, default: "'draft'" }) }]))
      .toEqual(["ALTER TABLE `posts` ADD COLUMN `status` text DEFAULT 'draft' NOT NULL;"])
  })

  it('drop_table: DROP TABLE', () => {
    expect(renderSqlite([{ type: 'drop_table', name: 'gone' }])).toEqual(['DROP TABLE `gone`;'])
  })

  it('rename_column: ALTER TABLE RENAME COLUMN', () => {
    expect(renderSqlite([{ type: 'rename_column', table: 'posts', from: 'content', to: 'body' }]))
      .toEqual(['ALTER TABLE `posts` RENAME COLUMN `content` TO `body`;'])
  })

  it('rebuild_table transforms: single↔multiple shape conversion in the copy SELECT', () => {
    const t: TableShape = { name: 'gal', columns: [col('cover', 'text', { notNull: true, default: "'[]'" })], indexes: [] }
    const out = renderSqlite([{ type: 'rebuild_table', table: t, copy: ['cover'], transforms: { cover: { from: 'cover_id', type: 'wrap' } } }])
    expect(out).toContain("INSERT INTO `__kestrel_new_gal` (`cover`) SELECT CASE WHEN `cover_id` IS NULL THEN '[]' ELSE json_array(`cover_id`) END FROM `gal`;")
    const narrow = renderSqlite([{ type: 'rebuild_table', table: { name: 'gal', columns: [col('cover_id', 'integer')], indexes: [] }, copy: ['cover_id'], transforms: { cover_id: { from: 'cover', type: 'unwrap' } } }])
    expect(narrow).toContain("INSERT INTO `__kestrel_new_gal` (`cover_id`) SELECT json_extract(`cover`, '$[0]') FROM `gal`;")
  })

  it('rebuild_table: create-temp → copy → drop → rename → recreate indexes', () => {
    const posts: TableShape = {
      name: 'posts',
      columns: [
        col('id', 'integer', { primaryKey: true, autoIncrement: true, notNull: true }),
        col('title', 'text', { notNull: true }),
      ],
      indexes: [idx('posts_title', 'posts', ['title'])],
    }
    expect(renderSqlite([{ type: 'rebuild_table', table: posts, copy: ['id', 'title'] }])).toEqual([
      'DROP TABLE IF EXISTS `__kestrel_new_posts`;',
      'CREATE TABLE `__kestrel_new_posts` (\n  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n  `title` text NOT NULL\n);',
      'INSERT INTO `__kestrel_new_posts` (`id`, `title`) SELECT `id`, `title` FROM `posts`;',
      "INSERT INTO sqlite_sequence (name, seq) SELECT '__kestrel_new_posts', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = '__kestrel_new_posts');",
      "UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'posts'), 0)) WHERE name = '__kestrel_new_posts';",
      'DROP TABLE `posts`;',
      'ALTER TABLE `__kestrel_new_posts` RENAME TO `posts`;',
      'CREATE INDEX `posts_title` ON `posts` (`title`);',
    ])
  })

  it('rebuild_table with no surviving columns skips the data copy', () => {
    const t: TableShape = { name: 'x', columns: [col('id', 'integer', { primaryKey: true, autoIncrement: true, notNull: true })], indexes: [] }
    expect(renderSqlite([{ type: 'rebuild_table', table: t, copy: [] }])).toEqual([
      'DROP TABLE IF EXISTS `__kestrel_new_x`;',
      'CREATE TABLE `__kestrel_new_x` (\n  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL\n);',
      "INSERT INTO sqlite_sequence (name, seq) SELECT '__kestrel_new_x', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = '__kestrel_new_x');",
      "UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'x'), 0)) WHERE name = '__kestrel_new_x';",
      'DROP TABLE `x`;',
      'ALTER TABLE `__kestrel_new_x` RENAME TO `x`;',
    ])
  })

  it('escapes embedded backticks in identifiers', () => {
    expect(renderSqlite([{ type: 'drop_table', name: 'a`b' }])).toEqual(['DROP TABLE `a``b`;'])
  })
})
