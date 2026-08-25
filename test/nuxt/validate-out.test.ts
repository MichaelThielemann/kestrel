import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { callPipelineRoute, usePipelineRouteDb } from '../helpers/pipeline-route'
import { buildCollection, buildIntrospectionPipelines, clearFieldPopulators, clearPipelines, clearPopulator, clearRegistry, create, defineCollection, desiredSchema, diffSchema, getCollection, getOne, outboxContent, registerCollection, registerFieldPopulator, registerPipeline, registerPopulator, renderSqlite, revisionsTable  } from '@kestrel/core'
import type { PipelineDescriptor } from '@kestrel/core'
import { buildFieldTreePopulator } from '@kestrel/fields'
import { buildRelationFieldPopulator, skipMissing } from '@kestrel/collections'
// A `number` field lets a raw SQL write store a non-numeric string without tripping SQLite's NOT NULL
// constraint (unlike a required text column, which SQLite itself refuses to null out) — the select
// schema (createSelectSchema, z.number()) rejects the string on read, which is the quarantine trigger.
const notes = buildCollection(defineCollection({
  name: 'notes', mode: 'multi', translatable: false,
  fields: { title: { type: 'text', required: true }, views: { type: 'number' } },
}))

const authors = buildCollection(defineCollection({
  name: 'authors', mode: 'multi', translatable: false,
  fields: { name: { type: 'text', required: true }, rating: { type: 'number' } },
}))

// pageLike + status ⇒ publicly readable (published-only for anonymous), which is what makes the
// admin-vs-public parity test reachable by both roles.
const posts = buildCollection(defineCollection({
  name: 'posts', mode: 'multi', translatable: false, pageLike: true, status: true,
  fields: {
    title: { type: 'text', required: true },
    slug: { type: 'slug', unique: true, options: { from: 'title' } },
    views: { type: 'number' },
    author: { type: 'relation', relation: { collection: 'authors' } },
  },
}))

let db: ReturnType<typeof drizzle>
let sqlite: Database.Database

/** Corrupts a stored row directly at the SQL level — the exact scenario validateOut exists to catch:
 *  a row that was valid on write but no longer matches its collection's select schema on read. */
function corrupt(table: string, column: string, id: number, value: string): void {
  sqlite.exec(`UPDATE ${table} SET ${column} = '${value}' WHERE id = ${id}`)
}

beforeEach(() => {
  clearRegistry()
  clearPipelines()
  clearPopulator()
  clearFieldPopulators()
  sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([
    outboxContent, notes.table, authors.table, posts.table,
    revisionsTable('notes'), revisionsTable('authors'), revisionsTable('posts'),
  ]), {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  usePipelineRouteDb(db)
  for (const c of [notes, authors, posts]) registerCollection(c)
  registerPopulator(buildFieldTreePopulator())
  registerFieldPopulator('relation', buildRelationFieldPopulator((collection, id, depth, locale, publicOnly) => {
    const built = getCollection(collection)
    if (!built) return null
    return skipMissing(() => getOne(db, built, id, depth, locale, true, publicOnly) as Record<string, unknown>)
  }, () => true))
})
afterEach(() => { clearRegistry(); clearPipelines(); clearPopulator(); clearFieldPopulators() })

describe('readOne — quarantine shape', () => {
  it('replaces a row that fails its select schema with exactly {id, $quarantined: true}', async () => {
    const row = create(db, notes, { title: 'Good', views: 3 }) as Record<string, unknown>
    corrupt('notes', 'views', row.id as number, 'nope')

    const out = await callPipelineRoute('GET', `/api/notes/readOne/${row.id}`, { role: 'admin' }) as Record<string, unknown>

    expect(Object.keys(out).sort()).toEqual(['$quarantined', 'id'])
    expect(out).toEqual({ id: row.id, $quarantined: true })
  })

  it('leaves a valid row byte-identical to what readOne returns today', async () => {
    const row = create(db, notes, { title: 'Fine', views: 7 }) as Record<string, unknown>

    const out = await callPipelineRoute('GET', `/api/notes/readOne/${row.id}`, { role: 'admin' }) as Record<string, unknown>

    expect(out).toEqual(row)
    expect('$quarantined' in out).toBe(false)
  })
})

describe('readMany — mixed list', () => {
  it('quarantines only the invalid row, counts it, and leaves the valid rows untouched', async () => {
    const a = create(db, notes, { title: 'A', views: 1 }) as Record<string, unknown>
    const b = create(db, notes, { title: 'B', views: 2 }) as Record<string, unknown>
    const c = create(db, notes, { title: 'C', views: 3 }) as Record<string, unknown>
    corrupt('notes', 'views', b.id as number, 'nope')

    const out = await callPipelineRoute('GET', '/api/notes/readMany', { role: 'admin' }) as {
      data: Record<string, unknown>[]
      total: number
      quarantinedCount: number
    }

    expect(out.quarantinedCount).toBe(1)
    expect(out.total).toBe(3)
    expect(out.data.find((r) => r.id === a.id)).toEqual(a)
    expect(out.data.find((r) => r.id === c.id)).toEqual(c)
    // Quarantined rows stay VISIBLE in the data array — they are not dropped, just withheld in shape.
    const quarantined = out.data.find((r) => r.id === b.id)!
    expect(quarantined).toEqual({ id: b.id, $quarantined: true })
  })

  it('reports quarantinedCount: 0 and no $quarantined anywhere when every row is valid', async () => {
    create(db, notes, { title: 'A', views: 1 })
    create(db, notes, { title: 'B', views: 2 })

    const out = await callPipelineRoute('GET', '/api/notes/readMany', { role: 'admin' }) as {
      data: Record<string, unknown>[]
      quarantinedCount: number
    }

    expect(out.quarantinedCount).toBe(0)
    expect(JSON.stringify(out.data)).not.toContain('$quarantined')
  })
})

describe('admin vs public parity', () => {
  it('quarantines the same published row identically for an admin and an anonymous reader', async () => {
    const row = create(db, posts, { title: 'Post', status: 'published' }) as Record<string, unknown>
    corrupt('posts', 'views', row.id as number, 'nope')

    const admin = await callPipelineRoute('GET', `/api/posts/readOne/${row.id}`, { role: 'admin' })
    const anon = await callPipelineRoute('GET', `/api/posts/readOne/${row.id}`, { role: 'anonymous' })

    expect(admin).toEqual({ id: row.id, $quarantined: true })
    expect(anon).toEqual({ id: row.id, $quarantined: true })
  })

  it('reports the same quarantinedCount to both roles on a published list', async () => {
    const good = create(db, posts, { title: 'Good', status: 'published' }) as Record<string, unknown>
    const bad = create(db, posts, { title: 'Bad', status: 'published' }) as Record<string, unknown>
    corrupt('posts', 'views', bad.id as number, 'nope')
    void good

    const admin = await callPipelineRoute('GET', '/api/posts/readMany', { role: 'admin' }) as { quarantinedCount: number }
    const anon = await callPipelineRoute('GET', '/api/posts/readMany', { role: 'anonymous' }) as { quarantinedCount: number }

    expect(admin.quarantinedCount).toBe(1)
    expect(anon.quarantinedCount).toBe(1)
  })
})

describe('populated relation sidecars', () => {
  it('replaces an invalid relation target with the quarantine shape inside the $<field> sidecar', async () => {
    const author = create(db, authors, { name: 'Ada', rating: 5 }) as Record<string, unknown>
    corrupt('authors', 'rating', author.id as number, 'nope')
    const post = create(db, posts, { title: 'Has author', status: 'published', authorId: author.id }) as Record<string, unknown>

    const out = await callPipelineRoute('GET', `/api/posts/readOne/${post.id}?depth=1`, { role: 'admin' }) as Record<string, unknown>

    // The outer row's own fields are all valid, so it is untouched — only the nested sidecar quarantines.
    expect(out.id).toBe(post.id)
    expect('$quarantined' in out).toBe(false)
    expect(out.$author).toEqual({ id: author.id, $quarantined: true })
  })

  it('leaves a valid relation target fully populated in the sidecar', async () => {
    const author = create(db, authors, { name: 'Ada', rating: 5 }) as Record<string, unknown>
    const post = create(db, posts, { title: 'Has author', status: 'published', authorId: author.id }) as Record<string, unknown>

    const out = await callPipelineRoute('GET', `/api/posts/readOne/${post.id}?depth=1`, { role: 'admin' }) as Record<string, unknown>

    expect(out.$author).toEqual(author)
  })
})

describe('introspection — GET /api/_pipelines', () => {
  const list = async () => {
    for (const def of buildIntrospectionPipelines()) registerPipeline(def)
    return (await callPipelineRoute('GET', '/api/_pipelines', { role: 'admin' }) as { pipelines: PipelineDescriptor[] }).pipelines
  }

  it('lists a sealed validateOut as the last step of readOne, after fetch → populate', async () => {
    const pipelines = await list()
    const readOne = pipelines.find((p) => p.collection === 'notes' && p.name === 'readOne')!
    expect(readOne.steps.map((s) => s.name)).toEqual(['fetch', 'populate', 'validateOut'])
    const validateOut = readOne.steps.find((s) => s.name === 'validateOut')!
    expect(validateOut).toMatchObject({ sealed: true })
  })

  it('lists a sealed validateOut as the last step of readMany, after parseQuery → fetch → attachMeta → populate', async () => {
    const pipelines = await list()
    const readMany = pipelines.find((p) => p.collection === 'notes' && p.name === 'readMany')!
    expect(readMany.steps.map((s) => s.name)).toEqual(['parseQuery', 'fetch', 'attachMeta', 'populate', 'validateOut'])
    const validateOut = readMany.steps.find((s) => s.name === 'validateOut')!
    expect(validateOut).toMatchObject({ sealed: true })
  })
})
