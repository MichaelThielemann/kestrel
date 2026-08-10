import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createError } from 'h3'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { buildCollection } from '../../../../fields/server/utils/buildCollection'
import { defineCollection } from '../../utils/defineCollection'
import { create, getOne, getSingleton, list, parseFilter, putSingleton } from '../../utils/crud'
import { requireCollection, requireId } from '../../utils/http'
import { clearRegistry, registerCollection } from '../../utils/registry'
import { clearPopulator, registerPopulator, type PopulateCtx } from '../../utils/populate'
import { desiredSchema } from '../../schema/desired'
import { diffSchema } from '../../schema/diff'
import { renderSqlite } from '../../schema/render-sqlite'

const posts = buildCollection(defineCollection({
  name: 'posts', mode: 'multi', translatable: false,
  fields: { title: { type: 'text', required: true } },
}))
const settings = buildCollection(defineCollection({
  name: 'settings', mode: 'single', translatable: false,
  fields: { siteName: { type: 'text' } },
}))

interface FakeEvent {
  query: Record<string, unknown>
  context: { params: Record<string, string>; readScope?: string; principal?: { userId: string | null; role: string } }
}

let db: ReturnType<typeof drizzle>
const seen: PopulateCtx[] = []

// The handlers are Nitro routes: their auto-imported helpers are plain globals in a node test. Every read
// entry point is the REAL one, so this exercises the actual crud → populate threading.
Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  createError,
  getQuery: (event: FakeEvent) => event.query,
  useDb: () => db,
  requireCollection,
  requireId,
  list,
  getOne,
  getSingleton,
  parseFilter,
  // Published-only for EVERY role, so a flag that tracked the read scope instead of the role would be
  // indistinguishable here — the renderer/admin cases below would then fail.
  publishedOnlyForScope: () => true,
})

const listHandler = (await import('./index.get')).default as unknown as (event: FakeEvent) => unknown
const detailHandler = (await import('./[id].get')).default as unknown as (event: FakeEvent) => unknown

let postId: number

beforeEach(() => {
  clearRegistry()
  clearPopulator()
  seen.length = 0
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([posts.table, settings.table]), {}))) sqlite.exec(stmt)
  db = drizzle(sqlite)
  registerCollection(posts)
  registerCollection(settings)
  postId = (create(db, posts, { title: 'A' }) as Record<string, unknown>).id as number
  putSingleton(db, settings, undefined, { siteName: 'Kestrel' })
  registerPopulator((row, ctx) => { seen.push(ctx); return row })
})
afterEach(() => {
  clearRegistry()
  clearPopulator()
})

const eventFor = (collection: string, role: string | undefined, params: Record<string, string> = {}): FakeEvent => ({
  query: { depth: 1 },
  context: {
    params: { collection, ...params },
    readScope: 'published',
    principal: role ? { userId: null, role } : undefined,
  },
})

describe('read routes — public-only populate scope', () => {
  it('marks an anonymous list read public-only', () => {
    listHandler(eventFor('posts', 'anonymous'))
    expect(seen[0]?.publicOnly).toBe(true)
  })

  it('marks an anonymous detail read public-only', () => {
    detailHandler(eventFor('posts', 'anonymous', { id: String(postId) }))
    expect(seen[0]?.publicOnly).toBe(true)
  })

  it('marks an anonymous singleton read public-only', () => {
    listHandler(eventFor('settings', 'anonymous'))
    expect(seen[0]?.publicOnly).toBe(true)
  })

  // The renderer produces the static site: stripping its relation sidecars would silently empty the
  // generated HTML, so its read stays unrestricted even though it too is published-only.
  it('leaves a renderer read unrestricted', () => {
    listHandler(eventFor('posts', 'renderer'))
    detailHandler(eventFor('posts', 'renderer', { id: String(postId) }))
    expect(seen.map((c) => c.publicOnly)).toEqual([false, false])
  })

  it('leaves an admin read unrestricted', () => {
    listHandler(eventFor('posts', 'admin'))
    detailHandler(eventFor('posts', 'admin', { id: String(postId) }))
    expect(seen.map((c) => c.publicOnly)).toEqual([false, false])
  })

  // A principal-less request is a guard regression, never a trusted caller — it must fail the same
  // direction as the `publishedOnly` flag the handler derives beside it.
  it('treats a missing principal as public-only', () => {
    listHandler(eventFor('posts', undefined))
    detailHandler(eventFor('posts', undefined, { id: String(postId) }))
    expect(seen.map((c) => c.publicOnly)).toEqual([true, true])
  })
})
