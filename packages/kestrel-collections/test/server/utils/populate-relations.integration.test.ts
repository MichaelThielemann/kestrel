import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { clearFieldPopulators, clearPopulator, clearRegistry, create, defineCollection, desiredSchema, diffSchema, getCollection, getOne, outboxContent, populateRow, registerCollection, registerFieldPopulator, registerPopulator, renderSqlite, revisionsTable, buildCollection  } from '@michaelthielemann/kestrel-core'
import { buildFieldTreePopulator } from '@michaelthielemann/kestrel-fields'
import { buildMediaFieldPopulator } from '@michaelthielemann/kestrel-media'
import { buildRelationFieldPopulator, skipMissing } from '../../../src/server/utils/populate-relations.js'
import type { ResolvedMedia } from '@michaelthielemann/kestrel-media'

// End-to-end with a REAL sqlite + the REAL getOne wiring (the plugin's resolveRecord), proving the relation
// populator composes with getOne's recursion (nested media resolves), respects the depth cycle-guard, and
// tolerates a stale id — the things a fake resolver can't prove.
const authors = buildCollection(defineCollection({
  name: 'authors', mode: 'multi', translatable: false,
  fields: {
    name: { type: 'text', required: true },
    photo: { type: 'media' },
    dossier: { type: 'relation', relation: { collection: 'dossiers' } },
  },
}))

// The second hop of a public → public → non-public chain.
const dossiers = buildCollection(defineCollection({
  name: 'dossiers', mode: 'multi', translatable: false,
  fields: { note: { type: 'text', required: true } },
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
let dossierId: number

// create()/getOne() take the narrower `BetterSQLite3Database<Record<string, never>>` DB type
// internal to @michaelthielemann/kestrel-core; the test's plain drizzle() instance is structurally compatible.
function asDb(db: ReturnType<typeof drizzle>): Parameters<typeof create>[0] {
  return db as unknown as Parameters<typeof create>[0]
}

beforeEach(() => {
  clearRegistry()
  clearPopulator()
  clearFieldPopulators()
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, authors.table, dossiers.table, revisionsTable('authors'), revisionsTable('dossiers')]), {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  registerCollection(authors)
  registerCollection(dossiers)
  const dossier = create(asDb(db), dossiers, { note: 'unlisted' }) as Record<string, unknown>
  dossierId = dossier.id as number
  const ada = create(asDb(db), authors, { name: 'Ada', dossierId }) as Record<string, unknown>
  adaId = ada.id as number
  // Set the media FK column directly (avoids create()'s single-ref input-key mapping); the fake resolver
  // turns id 42 into a $media entry when the author is populated at depth ≥ 1.
  sqlite.exec(`UPDATE authors SET photo_id = 42 WHERE id = ${adaId}`)

  registerPopulator(buildFieldTreePopulator())
  registerFieldPopulator('media', buildMediaFieldPopulator(fakeMedia))
  // Uses the REAL skipMissing (not a bare catch-all) — it recognizes getOne's actual failure shape
  // (a tagged NotFound) as the skip signal, and the same wiring the production plugin uses.
  registerFieldPopulator('relation', buildRelationFieldPopulator((collection, id, depth, locale, publicOnly) => {
    const built = getCollection(collection)
    if (!built) return null
    return skipMissing(() => getOne(asDb(db), built, id, depth, locale, true, publicOnly) as Record<string, unknown>)
  }, (collection) => collection === 'authors'))
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

  it('expands the nested $dossier hop for an unrestricted read', () => {
    const out = populateRow({ id: 1, authorId: adaId }, { depth: 3, locale: 'en', def: postsDef })
    const author = out.$author as Record<string, unknown>
    expect((author.$dossier as Record<string, unknown>).note).toBe('unlisted')
  })

  it('stops a public-only read at the first non-public hop of a public → public → non-public chain', () => {
    const out = populateRow({ id: 1, authorId: adaId }, { depth: 3, locale: 'en', def: postsDef, publicOnly: true })
    const author = out.$author as Record<string, unknown>
    expect(author.name).toBe('Ada')
    expect('$dossier' in author).toBe(false)
    expect(author.dossierId).toBe(dossierId)
  })
})
