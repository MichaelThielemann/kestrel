import { describe, it, expect, beforeEach } from 'vitest'
import { createError } from 'h3'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { populateRow } from '../../../core/server/utils/populate'
import { withResolveScope, resolveBudgetFor } from '../../../core/server/utils/resolve-scope'
import { defineCollection } from '../../../core/server/utils/defineCollection'

const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: false, pageLike: true, status: true, fields: { title: { type: 'text' } },
}))

interface FakeEvent { context: Record<string, unknown>; query?: Record<string, unknown> }

let body: Record<string, unknown>

Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  populateRow,
  withResolveScope,
  resolveBudgetFor,
  primaryLocale: () => 'en',
  createError,
  readBody: async () => body,
  getQuery: (event: FakeEvent) => event.query ?? {},
  requireAdmin: (event: FakeEvent) => {
    if (!event.context.principal) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  },
  getCollection: (name: string) => (name === 'pages' ? pages : null),
})

const mintHandler = (await import('./preview.post')).default as unknown as (event: FakeEvent) => Promise<{ token: string; expiresAt: number }>
const readHandler = (await import('./preview.get')).default as unknown as (event: FakeEvent) => { payload: unknown } | null

const session = (userId: string | null) => ({ context: { principal: { userId, role: 'admin' } } })
const mint = (b: Record<string, unknown>, userId: string | null = 'u1') => { body = b; return mintHandler(session(userId)) }
const read = (token: string, userId: string | null = 'u1') => readHandler({ ...session(userId), query: { token } })

let payload: Record<string, unknown>
beforeEach(() => {
  payload = { collection: 'pages', id: 1, locale: 'en', values: { title: 'Unsaved', content: [{ type: 'hero' }] } }
})

async function statusOf(fn: () => unknown | Promise<unknown>): Promise<number | undefined> {
  try { await fn() } catch (error) { return (error as { statusCode?: number }).statusCode }
  return undefined
}

describe('/api/preview — carrying unsaved editor state to a real page render', () => {
  it('mints a ticket and reads the same payload back', async () => {
    const { token, expiresAt } = await mint(payload)
    expect(token).toMatch(/\S{16,}/)
    expect(expiresAt).toBeGreaterThan(Date.now())
    expect(read(token)).toMatchObject({ payload: { collection: 'pages', id: 1, values: { title: 'Unsaved' } } })
  })

  it('accepts a record that has never been saved (id: null)', async () => {
    const { token } = await mint({ ...payload, id: null })
    expect(read(token)).toMatchObject({ payload: { id: null } })
  })

  it('does not hand a ticket to another admin session', async () => {
    const { token } = await mint(payload, 'u1')
    expect(read(token, 'u2')).toBe(null)
  })

  it('returns null for an unknown or missing token rather than an error page', () => {
    expect(read('nope')).toBe(null)
    expect(readHandler({ ...session('u1'), query: {} })).toBe(null)
  })

  it('401s an unauthenticated caller on both halves', async () => {
    body = payload
    expect(await statusOf(() => mintHandler({ context: {} }))).toBe(401)
    expect(await statusOf(() => readHandler({ context: {}, query: { token: 'x' } }))).toBe(401)
  })

  it('404s an unknown collection', async () => {
    expect(await statusOf(() => mint({ ...payload, collection: 'ghosts' }))).toBe(404)
  })

  it('400s a payload without a values object', async () => {
    expect(await statusOf(() => mint({ collection: 'pages', id: 1 }))).toBe(400)
    expect(await statusOf(() => mint({ ...payload, values: 'nope' }))).toBe(400)
  })

  it('413s a payload too large to be an editor form (an in-memory store is not an upload target)', async () => {
    expect(await statusOf(() => mint({ ...payload, values: { blob: 'x'.repeat(3_000_000) } }))).toBe(413)
  })
})
