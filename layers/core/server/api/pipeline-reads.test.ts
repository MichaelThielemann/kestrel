import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { callPipelineRoute, usePipelineRouteDb } from '../../../../test/helpers/pipeline-route'
import { buildCollection, clearPipelines, clearPopulator, clearRegistry, create, defineCollection, desiredSchema, diffSchema, outboxContent, putSingleton, registerCollection, registerPopulator, renderSqlite, resolveTranslations, revisionsTable  } from '@kestrel/core'
import type { PopulateCtx } from '@kestrel/core'
// pageLike ⇒ its read pipelines declare public published-only access, which is what makes an anonymous
// read of this collection reach the handler at all.
const posts = buildCollection(defineCollection({
  name: 'posts', mode: 'multi', translatable: false, pageLike: true, status: true,
  fields: { title: { type: 'text', required: true }, slug: { type: 'slug', unique: true, options: { from: 'title' } } },
}))
const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: true, pageLike: true,
  fields: { title: { type: 'text', required: true } },
}))
const articles = buildCollection(defineCollection({
  name: 'articles', mode: 'multi', translatable: true, pageLike: true, status: true,
  fields: { title: { type: 'text', required: true } },
}))
const notes = buildCollection(defineCollection({
  name: 'notes', mode: 'multi', translatable: false,
  fields: { title: { type: 'text', required: true } },
}))
const settings = buildCollection(defineCollection({
  name: 'settings', mode: 'single', translatable: false,
  fields: { siteName: { type: 'text' } },
}))

let db: ReturnType<typeof drizzle>
let postId: number
const seen: PopulateCtx[] = []

beforeEach(async () => {
  clearRegistry()
  clearPipelines()
  clearPopulator()
  seen.length = 0
  const sqlite = new Database(':memory:')
  const collections = [posts, pages, articles, notes, settings]
  for (const stmt of renderSqlite(diffSchema(desiredSchema([outboxContent, ...collections.map((c) => c.table), ...collections.map((c) => revisionsTable(c.def.name))]), {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  usePipelineRouteDb(db)
  for (const c of [posts, pages, articles, notes, settings]) registerCollection(c)
  postId = (create(db, posts, { title: 'A', status: 'published' }) as Record<string, unknown>).id as number
  await putSingleton(db, settings, undefined, { siteName: 'Kestrel' })
  registerPopulator((row, ctx) => { seen.push(ctx); return row })
})
afterEach(() => { clearRegistry(); clearPipelines(); clearPopulator() })

const list = (collection: string, role?: string) => callPipelineRoute('GET', `/api/${collection}/readMany?depth=1`, { role })
const detail = (collection: string, id: number, role?: string) => callPipelineRoute('GET', `/api/${collection}/readOne/${id}?depth=1`, { role })

describe('read routes — public-only populate scope', () => {
  it('marks an anonymous list read public-only', async () => {
    await list('posts', 'anonymous')
    expect(seen[0]?.publicOnly).toBe(true)
  })

  it('marks an anonymous detail read public-only', async () => {
    await detail('posts', postId, 'anonymous')
    expect(seen[0]?.publicOnly).toBe(true)
  })

  // The renderer produces the static site: stripping its relation sidecars would silently empty the
  // generated HTML, so its read stays unrestricted even though it too is published-only.
  it('leaves a renderer read unrestricted', async () => {
    await list('posts', 'renderer')
    await detail('posts', postId, 'renderer')
    expect(seen.map((c) => c.publicOnly)).toEqual([false, false])
  })

  it('leaves an admin read unrestricted', async () => {
    await list('posts', 'admin')
    await detail('posts', postId, 'admin')
    expect(seen.map((c) => c.publicOnly)).toEqual([false, false])
  })

  it('leaves an admin singleton read unrestricted', async () => {
    await callPipelineRoute('GET', '/api/settings/readOne?depth=1', { role: 'admin' })
    expect(seen[0]?.publicOnly).toBe(false)
  })

  // A principal-less request resolves to anonymous, never to a trusted caller — it must fail the same
  // direction as the read scope the gate resolves beside it.
  it('treats a missing principal as public-only', async () => {
    await list('posts')
    await detail('posts', postId)
    expect(seen.map((c) => c.publicOnly)).toEqual([true, true])
  })
})

describe('read routes — access gate', () => {
  it('refuses an anonymous read of a collection that is not publicly routable', async () => {
    await expect(callPipelineRoute('GET', '/api/settings/readOne', { role: 'anonymous' })).rejects.toThrowError(/Authentication required/)
    expect(seen).toHaveLength(0)
  })

  it('scopes an anonymous read to published rows and an admin read to all of them', async () => {
    create(db, posts, { title: 'Draft', status: 'draft' })
    const anonymous = await list('posts', 'anonymous') as { total: number }
    const admin = await list('posts', 'admin') as { total: number }
    expect(anonymous.total).toBeLessThan(admin.total)
  })

  // The tooling reads enumerate draft ids, so a public read grant on the collection must not reach them.
  it('refuses an anonymous tooling read even on a publicly readable collection', async () => {
    for (const path of ['/api/posts/options', '/api/pages/translations?group=g', `/api/posts/deadRefs/${postId}`]) {
      await expect(callPipelineRoute('GET', path, { role: 'anonymous' })).rejects.toMatchObject({ statusCode: 401 })
    }
  })
})

describe('GET /api/{collection}/options', () => {
  it('resolves more than 100 ids in one request instead of truncating', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => (create(db, notes, { title: `T${i}` }) as { id: number }).id)
    const r = await callPipelineRoute('GET', `/api/notes/options?ids=${ids.join(',')}`, { role: 'admin' }) as { data: unknown[] }
    expect(r.data.length).toBe(150)
  })

  it('400s (never silently truncates) an ids list over the shared bulk cap', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1)
    await expect(callPipelineRoute('GET', `/api/notes/options?ids=${ids.join(',')}`, { role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('GET /api/{collection}/translations', () => {
  const byGroup = (collection: string, group: unknown) =>
    callPipelineRoute('GET', `/api/${collection}/translations${group === undefined ? '' : `?group=${group}`}`, { role: 'admin' })

  it('resolves the group\'s locale → sibling id map without a record id', async () => {
    const en = create(db, pages, { title: 'Home' }) as Record<string, unknown>
    const de = create(db, pages, { title: 'Start', locale: 'de', translationGroup: en.translationGroup as string }) as Record<string, unknown>
    await expect(byGroup('pages', en.translationGroup)).resolves.toEqual({ en: en.id, de: de.id })
  })

  it('reports a locale with no sibling as null (what the "+ create" affordance keys off)', async () => {
    const en = create(db, pages, { title: 'Only EN' }) as Record<string, unknown>
    await expect(byGroup('pages', en.translationGroup)).resolves.toEqual({ en: en.id, de: null })
  })

  it('returns exactly the per-record map for the same group (one map builder, two entry points)', async () => {
    const en = create(db, pages, { title: 'Home' }) as Record<string, unknown>
    create(db, pages, { title: 'Start', locale: 'de', translationGroup: en.translationGroup as string })
    await expect(byGroup('pages', en.translationGroup)).resolves.toEqual(resolveTranslations(db, pages, en.id as number))
    await expect(callPipelineRoute('GET', `/api/pages/translations/${en.id}`, { role: 'admin' }))
      .resolves.toEqual(resolveTranslations(db, pages, en.id as number))
  })

  it('400s without a group rather than answering for an arbitrary one', async () => {
    await expect(byGroup('pages', undefined)).rejects.toMatchObject({ statusCode: 400 })
    await expect(byGroup('pages', '%20%20')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s for a group that has no rows', async () => {
    create(db, pages, { title: 'Home' })
    await expect(byGroup('pages', 'nope')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('400s (never 500s) for a collection without translations — it has no group column at all', async () => {
    create(db, notes, { title: 'Note' })
    await expect(byGroup('notes', 'g1')).rejects.toThrowError(/Translations are not enabled/)
  })

  it('404s for an unknown collection', async () => {
    await expect(byGroup('nope', 'g1')).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('GET /api/{collection}/deadRefs/{id}', () => {
  it('answers with the record\'s stale-reference list', async () => {
    await expect(callPipelineRoute('GET', `/api/posts/deadRefs/${postId}`, { role: 'admin' })).resolves.toEqual([])
  })

  it('400s without a record id', async () => {
    await expect(callPipelineRoute('GET', '/api/posts/deadRefs', { role: 'admin' })).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('read routes — published-scope sidecars', () => {
  it('hides a draft sibling from $translations on an anonymous read but shows it to the admin', async () => {
    const en = create(db, articles, { title: 'EN live', status: 'published' }) as Record<string, unknown>
    const de = create(db, articles, { title: 'DE draft', locale: 'de', translationGroup: en.translationGroup as string }) as Record<string, unknown>

    const anon = await list('articles', 'anonymous') as { data: Array<Record<string, unknown>> }
    expect(anon.data.find((r) => r.id === en.id)!.$translations).toEqual({ en: en.id, de: null })

    const admin = await list('articles', 'admin') as { data: Array<Record<string, unknown>> }
    expect(admin.data.find((r) => r.id === en.id)!.$translations).toEqual({ en: en.id, de: de.id })
  })
})
