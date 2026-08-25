import { describe, it, expect, beforeEach } from 'vitest'
import type { ValidationFailed } from '@kestrel/contracts'
import { sql } from 'drizzle-orm'
import { getSingleton, putSingleton, update, remove } from '../../../src/server/utils/crud.js'
import { buildCollection } from '../../../src/server/schema/buildCollection.js'
import { clearPopulator, defineCollection, registerPopulator } from '../../../src/index.js'
import { createTestDb } from '../../../../../test/helpers/db.js'
import { ensureRevisionsTable } from '../../../src/server/db/revisions.js'
import { sqliteClientOf } from '../../../src/server/db/outbox.js'

const settingsCollection = buildCollection(defineCollection({
  name: 'settings', mode: 'single', translatable: true, fields: { siteName: { type: 'text' } },
}))

let db: ReturnType<typeof createTestDb>
beforeEach(() => {
  db = createTestDb()
  ensureRevisionsTable(sqliteClientOf(db), 'settings')
})

describe('crud — singletons', () => {
  it('returns null when not yet set', () => {
    expect(getSingleton(db, settingsCollection, 'en')).toBeNull()
  })

  it('upserts per locale and reads back', async () => {
    const en = await putSingleton(db, settingsCollection, 'en', { siteName: 'light' }) as Record<string, unknown>
    expect(en.singletonKey).toBe('settings')
    expect(en.locale).toBe('en')

    const updated = await putSingleton(db, settingsCollection, 'en', { siteName: 'dark' }) as Record<string, unknown>
    expect(updated.id).toBe(en.id) // same row, upserted
    expect(updated.siteName).toBe('dark')

    const de = await putSingleton(db, settingsCollection, 'de', { siteName: 'blue' }) as Record<string, unknown>
    expect(de.id).not.toBe(en.id) // separate row per locale

    expect((getSingleton(db, settingsCollection, 'en') as Record<string, unknown>).id).toBe(en.id)
  })

  it('first PUT omitting a hard-required field is a clean 400, not a NOT NULL 500', async () => {
    const cfg = buildCollection(defineCollection({
      name: 'branding', mode: 'single', translatable: false, fields: { logoText: { type: 'text', required: true } },
    }))
    db.run(sql`CREATE TABLE branding (id integer PRIMARY KEY AUTOINCREMENT, singleton_key text NOT NULL, logo_text text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)`)
    ensureRevisionsTable(sqliteClientOf(db), 'branding')
    await expect(putSingleton(db, cfg, undefined, {})).rejects.toThrowError(expect.objectContaining({ _tag: 'ValidationFailed' }) as ValidationFailed)
    // once the required field is supplied it saves
    expect((await putSingleton(db, cfg, undefined, { logoText: 'Acme' }) as Record<string, unknown>).logoText).toBe('Acme')
  })

  it('runs the populate pipeline for singleton reads at depth > 0 (media/relations resolve like any collection)', async () => {
    registerPopulator((row, ctx) => ({ ...row, _p: ctx.depth }))
    try {
      await putSingleton(db, settingsCollection, 'en', { siteName: 'x' })
      expect((getSingleton(db, settingsCollection, 'en', false, 0) as Record<string, unknown>)._p).toBeUndefined()
      expect((getSingleton(db, settingsCollection, 'en', false, 2) as Record<string, unknown>)._p).toBe(2)
    } finally {
      clearPopulator()
    }
  })

  it('publishedOnly hides a non-published single-mode collection from anonymous reads', async () => {
    const homepage = buildCollection(defineCollection({
      name: 'homepage', mode: 'single', translatable: true, status: true,
      fields: { body: { type: 'text' } },
    }))
    db.run(sql`CREATE TABLE homepage (
      id integer PRIMARY KEY AUTOINCREMENT,
      locale text NOT NULL,
      singleton_key text NOT NULL,
      status text NOT NULL DEFAULT 'draft',
      body text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )`)
    ensureRevisionsTable(sqliteClientOf(db), 'homepage')

    await putSingleton(db, homepage, 'en', { status: 'draft', body: 'wip' })
    expect(getSingleton(db, homepage, 'en', true)).toBeNull() // anonymous: published-only
    expect(getSingleton(db, homepage, 'en')).not.toBeNull() // admin still sees the draft

    await putSingleton(db, homepage, 'en', { status: 'published', body: 'live' })
    expect(getSingleton(db, homepage, 'en', true)).not.toBeNull() // now visible
  })

  it('auto-generates a slug field from its `from` source, like create() does for regular collections', async () => {
    const cfg = buildCollection(defineCollection({
      name: 'homecfg', mode: 'single', translatable: false,
      fields: { title: { type: 'text' }, slug: { type: 'slug', options: { from: 'title' } } },
    }))
    db.run(sql`CREATE TABLE homecfg (id integer PRIMARY KEY AUTOINCREMENT, singleton_key text NOT NULL, title text, slug text, created_at integer NOT NULL, updated_at integer NOT NULL)`)
    ensureRevisionsTable(sqliteClientOf(db), 'homecfg')
    const row = await putSingleton(db, cfg, undefined, { title: 'Hello World' }) as Record<string, unknown>
    expect(row.slug).toBe('hello-world')
  })

  it('maps a UNIQUE-constraint failure to a 409, like create()/update() do', async () => {
    const cfg = buildCollection(defineCollection({
      name: 'uniqcfg', mode: 'single', translatable: true, fields: { code: { type: 'text', unique: true } },
    }))
    db.run(sql`CREATE TABLE uniqcfg (id integer PRIMARY KEY AUTOINCREMENT, singleton_key text NOT NULL, locale text NOT NULL, code text UNIQUE, created_at integer NOT NULL, updated_at integer NOT NULL)`)
    ensureRevisionsTable(sqliteClientOf(db), 'uniqcfg')
    await putSingleton(db, cfg, 'en', { code: 'x' })
    // a different locale row is a separate insert — the globally-unique `code` column collides at the DB
    await expect(putSingleton(db, cfg, 'de', { code: 'x' }))
      .rejects.toThrowError(expect.objectContaining({ _tag: 'Conflict', field: 'code', value: 'x' }))
  })

  it('rejects update/remove on a singleton via the generic id routes (405)', async () => {
    const en = await putSingleton(db, settingsCollection, 'en', { siteName: 'a' }) as Record<string, unknown>
    expect(() => update(db, settingsCollection, en.id as number, { siteName: 'b' })).toThrowError(/singleton|405/i)
    expect(() => remove(db, settingsCollection, en.id as number)).toThrowError(/singleton|405/i)
  })
})
