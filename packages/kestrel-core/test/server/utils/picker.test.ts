import { describe, it, expect, beforeEach } from 'vitest'
import { pickerOptions } from '../../../src/server/utils/picker.js'
import { create } from '../../../src/server/utils/crud.js'
import { createTestDb } from '../../../../../test/helpers/db.js'
import { ensureRevisionsTable } from '../../../src/server/db/revisions.js'
import { sqliteClientOf } from '../../../src/server/db/outbox.js'
import posts from '../../../../../server/collections/posts.js'
import { mediaCollection as media } from '@michaelthielemann/kestrel-media'

let db: ReturnType<typeof createTestDb>
beforeEach(() => {
  db = createTestDb()
  ensureRevisionsTable(sqliteClientOf(db), 'posts')
  ensureRevisionsTable(sqliteClientOf(db), 'media')
})

const mediaRow = (key: string, filename: string) =>
  create(db, media, { storageKey: key, filename, mime: 'image/png', ext: 'png', size: 1 }) as { id: number }

describe('pickerOptions', () => {
  it('uses the first text field as the label', () => {
    const row = create(db, posts, { title: 'Hello' }) as { id: number }
    const r = pickerOptions(db, posts, {})
    expect(r.data).toEqual([{ id: row.id, label: 'Hello' }])
  })

  it('honors an explicit text label field over the first text field', () => {
    mediaRow('k1', 'photo.png')
    expect(pickerOptions(db, media, {}).data[0]!.label).toBe('k1') // fallback = first text (storageKey)
    expect(pickerOptions(db, media, { label: 'filename' }).data[0]!.label).toBe('photo.png')
  })

  it('falls back to the first text field when the requested label is not a text field', () => {
    create(db, posts, { title: 'Hi' })
    // posts.body is richtext (not text) → falls back to title
    expect(pickerOptions(db, posts, { label: 'body' }).data[0]!.label).toBe('Hi')
  })

  it('searches the label field with LIKE', () => {
    create(db, posts, { title: 'Apple' })
    create(db, posts, { title: 'Banana' })
    const r = pickerOptions(db, posts, { search: 'ana' })
    expect(r.data.map((d) => d.label)).toEqual(['Banana'])
    expect(r.total).toBe(1)
  })

  it('resolves specific ids to labels', () => {
    const a = create(db, posts, { title: 'A' }) as { id: number }
    const b = create(db, posts, { title: 'B' }) as { id: number }
    create(db, posts, { title: 'C' })
    const r = pickerOptions(db, posts, { ids: [a.id, b.id] })
    expect(r.data.map((d) => d.label).sort()).toEqual(['A', 'B'])
  })

  it('resolves more than 100 ids (a many-relation selection is not silently truncated)', () => {
    const ids = Array.from({ length: 150 }, (_, i) => (create(db, posts, { title: `T${i}` }) as { id: number }).id)
    const r = pickerOptions(db, posts, { ids })
    expect(r.data.length).toBe(150)
  })

  it('paginates with a total count', () => {
    for (let i = 0; i < 30; i++) create(db, posts, { title: `T${String(i).padStart(2, '0')}` })
    const r = pickerOptions(db, posts, { perPage: 10, page: 2 })
    expect(r.data.length).toBe(10)
    expect(r).toMatchObject({ total: 30, page: 2, perPage: 10 })
  })

  it('resolves on a non-translatable collection without a locale filter', () => {
    mediaRow('z1', 'a.png')
    mediaRow('z2', 'b.png')
    expect(pickerOptions(db, media, { search: 'z2', label: 'storageKey' }).data.map((d) => d.label)).toEqual(['z2'])
  })

  it('falls back to #id when the label value is blank (a required combobox must never show an empty label)', () => {
    // Blank labels are legal for non-required label fields (and legacy/API rows); raw insert mirrors that.
    db.insert(posts.table).values({ path: '/blank', locale: 'en', translationGroup: 'g1', title: '' }).run()
    db.insert(posts.table).values({ path: '/spaces', locale: 'en', translationGroup: 'g2', title: '   ' }).run()
    const r = pickerOptions(db, posts, { ids: [1, 2] })
    expect(r.data.map((d) => d.label).sort()).toEqual(['#1', '#2'])
  })

  it('treats a present-but-empty ids list as an explicit empty result', () => {
    create(db, posts, { title: 'A' })
    expect(pickerOptions(db, posts, { ids: [] })).toEqual({ data: [], total: 0, page: 1, perPage: 0 })
  })

  it('clamps NaN page/perPage to the defaults', () => {
    for (let i = 0; i < 3; i++) create(db, posts, { title: `T${i}` })
    const r = pickerOptions(db, posts, { page: NaN, perPage: NaN })
    expect(r).toMatchObject({ page: 1, perPage: 25 })
    expect(r.data.length).toBe(3)
  })

  it('resolves ids regardless of the request locale (a stored PK is locale-absolute)', () => {
    const de = create(db, posts, { title: 'Zorn', locale: 'de' }) as { id: number }
    // resolving the de row's PK while editing in en must still yield its label, not an empty fallback
    const r = pickerOptions(db, posts, { ids: [de.id], locale: 'en' })
    expect(r.data).toEqual([{ id: de.id, label: 'Zorn' }])
  })

  it('treats LIKE metacharacters in the search term literally', () => {
    create(db, posts, { title: 'a_b' })
    create(db, posts, { title: 'aXb' })
    create(db, posts, { title: 'a1b' })
    expect(pickerOptions(db, posts, { search: 'a_b' }).data.map((d) => d.label)).toEqual(['a_b'])
  })

  it('publishedOnly hides drafts in list AND id-resolution modes (no draft-title leak to a published-scope read)', () => {
    const pub = create(db, posts, { title: 'Pub', status: 'published' }) as { id: number }
    const draft = create(db, posts, { title: 'Draft', status: 'draft' }) as { id: number }
    // list/search mode
    expect(pickerOptions(db, posts, { publishedOnly: true }).data.map((d) => d.label)).toEqual(['Pub'])
    // id-resolution mode: a draft id resolves to nothing under published scope
    expect(pickerOptions(db, posts, { ids: [pub.id, draft.id], publishedOnly: true }).data.map((d) => d.label)).toEqual(['Pub'])
    // admin scope (default) still sees both
    expect(pickerOptions(db, posts, {}).data.map((d) => d.label).sort()).toEqual(['Draft', 'Pub'])
  })
})
