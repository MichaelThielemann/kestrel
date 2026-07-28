import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { create, getOne } from '../../../core/server/utils/crud'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { desiredSchema } from '../../../core/server/schema/desired'
import { diffSchema } from '../../../core/server/schema/diff'
import { renderSqlite } from '../../../core/server/schema/render-sqlite'
import { registerCollection, getCollection, clearRegistry } from '../../../core/server/utils/registry'
import {
  registerPopulator, clearPopulator, registerFieldPopulator, clearFieldPopulators, populateRow,
} from '../../../core/server/utils/populate'
import { buildFieldTreePopulator } from '../../../fields/server/utils/field-populate'
import { buildMediaFieldPopulator } from '../../../media/server/utils/populate'
import { buildRelationFieldPopulator } from './populate-relations'
import type { ResolvedMedia } from '../../../media/server/utils/resolve'

// End-to-end with a REAL sqlite + the REAL getOne wiring (the plugin's resolveRecord), proving the relation
// populator composes with getOne's recursion (nested media resolves), respects the depth cycle-guard, and
// tolerates a stale id — the things a fake resolver can't prove.
const authors = buildCollection(defineCollection({
  name: 'authors', mode: 'multi', translatable: false,
  fields: { name: { type: 'text', required: true }, photo: { type: 'media' } },
}))

const fakeMedia = (id: number, _locale: string): ResolvedMedia | null =>
  ({ id, src: `/u/${id}.jpg` } as ResolvedMedia)

// A `posts`-shaped def with a relation to authors. We only need its `fields` for the walker — no table.
const postsDef = defineCollection({
  name: 'posts', mode: 'multi', translatable: false,
  fields: { author: { type: 'relation', relation: { collection: 'authors' } } },
})

let db: ReturnType<typeof drizzle>
let adaId: number

beforeEach(() => {
  clearRegistry()
  clearPopulator()
  clearFieldPopulators()
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([authors.table]), {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  registerCollection(authors)
  const ada = create(db, authors, { name: 'Ada' }) as Record<string, unknown>
  adaId = ada.id as number
  // Set the media FK column directly (avoids create()'s single-ref input-key mapping); the fake resolver
  // turns id 42 into a $media entry when the author is populated at depth ≥ 1.
  sqlite.exec(`UPDATE authors SET photo_id = 42 WHERE id = ${adaId}`)

  registerPopulator(buildFieldTreePopulator())
  registerFieldPopulator('media', buildMediaFieldPopulator(fakeMedia))
  registerFieldPopulator('relation', buildRelationFieldPopulator((collection, id, depth, locale) => {
    const built = getCollection(collection)
    if (!built) return null
    try { return getOne(db, built, id, depth, locale, true) as Record<string, unknown> }
    catch { return null } // stale / deleted / draft → skip
  }))
})
afterEach(() => {
  clearRegistry()
  clearPopulator()
  clearFieldPopulators()
})

describe('relation populator — end-to-end with real getOne', () => {
  it('expands $author with the related record AND its own media populated at depth ≥ 2', () => {
    const out = populateRow({ id: 1, authorId: adaId }, { depth: 2, locale: 'en', def: postsDef })
    const author = out.$author as Record<string, unknown>
    expect(author.name).toBe('Ada')
    expect((author.$media as Record<string, unknown>).photo).toEqual({ id: 42, src: '/u/42.jpg' })
  })

  it('fetches the related record but leaves it RAW at depth 1 (related read runs at depth 0)', () => {
    const out = populateRow({ id: 1, authorId: adaId }, { depth: 1, locale: 'en', def: postsDef })
    const author = out.$author as Record<string, unknown>
    expect(author.name).toBe('Ada')
    expect(author.$media).toBeUndefined()
  })

  it('sets $author to null for a stale id (getOne 404 → skipped, not thrown)', () => {
    const out = populateRow({ id: 1, authorId: 9999 }, { depth: 2, locale: 'en', def: postsDef })
    expect(out.$author).toBeNull()
  })
})
