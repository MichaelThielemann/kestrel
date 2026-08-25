import { describe, it, expect, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDb } from '../../../../../test/helpers/db.js'
import { clearRegistry, defineCollection, registerCollection, buildCollection  } from '@kestrel/core'
import { clearBlocks, registerBlock, defineBlock } from '@kestrel/fields'
import { findMediaUsages, findMediaUsagesForMany } from '../../../src/server/utils/usages.js'

let db: ReturnType<typeof createTestDb>
beforeEach(() => { clearRegistry(); clearBlocks(); db = createTestDb() })

describe('findMediaUsages', () => {
  it('finds scalar <name>Id, number[] and block-content references to a media id', () => {
    const posts = buildCollection(defineCollection({
      name: 'posts2', mode: 'multi', translatable: false,
      blocks: { enabled: true },
      fields: { cover: { type: 'media' }, gallery: { type: 'media', options: { multiple: true } } },
    }))
    registerCollection(posts)
    registerBlock(defineBlock({ name: 'hero', fields: { image: { type: 'media' } } }))
    db.run(sql`CREATE TABLE posts2 (id integer PRIMARY KEY AUTOINCREMENT, cover_id integer, gallery text, content text, created_at integer NOT NULL, updated_at integer NOT NULL)`)
    db.run(sql`INSERT INTO posts2 (cover_id, gallery, content, created_at, updated_at) VALUES
      (7, '[2,7]', '[{"id":"a","type":"hero","props":{"image":7}}]', 0, 0),
      (1, '[2]',   '[]', 0, 0)`)

    const u = findMediaUsages(db, 7)
    // row 1 uses 7 three ways (cover, gallery, block) — at least the row+collection is reported
    expect(u.some((x) => x.collection === 'posts2' && x.recordId === 1)).toBe(true)
    expect(u.some((x) => x.collection === 'posts2' && x.recordId === 2)).toBe(false) // row 2 doesn't use 7
  })

  it('finds media ids nested in repeater and json columns (over-approximation)', () => {
    const widgets = buildCollection(defineCollection({
      name: 'widgets', mode: 'multi', translatable: false,
      fields: {
        rows: { type: 'repeater', options: { fields: { pic: { type: 'media' } } } },
        meta: { type: 'json' },
      },
    }))
    registerCollection(widgets)
    db.run(sql`CREATE TABLE widgets (id integer PRIMARY KEY AUTOINCREMENT, rows text, meta text, created_at integer NOT NULL, updated_at integer NOT NULL)`)
    db.run(sql`INSERT INTO widgets (rows, meta, created_at, updated_at) VALUES
      ('[{"pic":42}]', '{}', 0, 0),
      ('[]', '{"heroId":42}', 0, 0),
      ('[{"pic":1}]', '{}', 0, 0)`)

    const u = findMediaUsages(db, 42)
    expect(u.some((x) => x.collection === 'widgets' && x.recordId === 1 && x.field === 'rows')).toBe(true)
    expect(u.some((x) => x.collection === 'widgets' && x.recordId === 2 && x.field === 'meta')).toBe(true)
    expect(u.some((x) => x.recordId === 3)).toBe(false) // row 3 references id 1, not 42
  })

  it('finds a media id referenced only by the seo system column (the social image)', () => {
    const pages2 = buildCollection(defineCollection({
      name: 'pages2', mode: 'multi', translatable: false, pageLike: true, seo: true,
      fields: { title: { type: 'text' } },
    }))
    registerCollection(pages2)
    db.run(sql`CREATE TABLE pages2 (id integer PRIMARY KEY AUTOINCREMENT, path text, seo text NOT NULL DEFAULT '{}', title text, created_at integer NOT NULL, updated_at integer NOT NULL)`)
    db.run(sql`INSERT INTO pages2 (path, seo, title, created_at, updated_at) VALUES
      ('/a', '{"image":42}', 'A', 0, 0),
      ('/b', '{"title":"no image"}', 'B', 0, 0)`)

    expect(findMediaUsages(db, 42)).toEqual([{ collection: 'pages2', recordId: 1, field: 'seo.image' }])
    expect(findMediaUsages(db, 43)).toEqual([])
  })
})

describe('findMediaUsagesForMany', () => {
  it('buckets every requested id, including ones with no usage', () => {
    const posts = buildCollection(defineCollection({
      name: 'posts2', mode: 'multi', translatable: false,
      blocks: { enabled: true },
      fields: { cover: { type: 'media' }, gallery: { type: 'media', options: { multiple: true } } },
    }))
    registerCollection(posts)
    registerBlock(defineBlock({ name: 'hero', fields: { image: { type: 'media' } } }))
    db.run(sql`CREATE TABLE posts2 (id integer PRIMARY KEY AUTOINCREMENT, cover_id integer, gallery text, content text, created_at integer NOT NULL, updated_at integer NOT NULL)`)
    db.run(sql`INSERT INTO posts2 (cover_id, gallery, content, created_at, updated_at) VALUES
      (7, '[2,7]', '[{"id":"a","type":"hero","props":{"image":9}}]', 0, 0),
      (1, '[2]',   '[]', 0, 0)`)

    const r = findMediaUsagesForMany(db, [7, 9, 99])
    expect(Object.keys(r).map(Number).sort((a, b) => a - b)).toEqual([7, 9, 99])
    expect(r[7]).toEqual([
      { collection: 'posts2', recordId: 1, field: 'cover' },
      { collection: 'posts2', recordId: 1, field: 'gallery' },
    ])
    expect(r[9]).toEqual([{ collection: 'posts2', recordId: 1, field: 'content' }])
    expect(r[99]).toEqual([])
  })

  it('reports a record referencing the same id twice in one column only once', () => {
    const widgets = buildCollection(defineCollection({
      name: 'widgets', mode: 'multi', translatable: false,
      fields: { meta: { type: 'json' }, gallery: { type: 'media', options: { multiple: true } } },
    }))
    registerCollection(widgets)
    db.run(sql`CREATE TABLE widgets (id integer PRIMARY KEY AUTOINCREMENT, meta text, gallery text, created_at integer NOT NULL, updated_at integer NOT NULL)`)
    db.run(sql`INSERT INTO widgets (meta, gallery, created_at, updated_at) VALUES ('{"a":5,"b":5}', '[5,5]', 0, 0)`)

    expect(findMediaUsagesForMany(db, [5])[5]).toEqual([
      { collection: 'widgets', recordId: 1, field: 'meta' },
      { collection: 'widgets', recordId: 1, field: 'gallery' },
    ])
  })

  it('handles more ids than SQLite\'s bound-parameter limit (a folder-sized bulk delete)', () => {
    const posts = buildCollection(defineCollection({
      name: 'posts2', mode: 'multi', translatable: false,
      fields: { cover: { type: 'media' }, gallery: { type: 'media', options: { multiple: true } }, meta: { type: 'json' } },
    }))
    registerCollection(posts)
    db.run(sql`CREATE TABLE posts2 (id integer PRIMARY KEY AUTOINCREMENT, cover_id integer, gallery text, meta text, created_at integer NOT NULL, updated_at integer NOT NULL)`)
    db.run(sql`INSERT INTO posts2 (cover_id, gallery, meta, created_at, updated_at) VALUES (40000, '[39999]', '{"a":39998}', 0, 0)`)

    const ids = Array.from({ length: 40000 }, (_, i) => i + 1)
    const r = findMediaUsagesForMany(db, ids)
    expect(Object.keys(r)).toHaveLength(40000)
    expect(r[40000]).toEqual([{ collection: 'posts2', recordId: 1, field: 'cover' }])
    expect(r[39999]).toEqual([{ collection: 'posts2', recordId: 1, field: 'gallery' }])
    expect(r[39998]).toEqual([{ collection: 'posts2', recordId: 1, field: 'meta' }])
    expect(r[1]).toEqual([])
  })
})
