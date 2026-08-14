import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createError } from 'h3'
import { buildCollection } from '../../../fields/server/utils/buildCollection'
import { populateRow } from '../../../core/server/utils/populate'
import { withResolveScope, resolveBudgetFor } from '../../../core/server/utils/resolve-scope'
import { defineCollection } from '../../../core/server/utils/defineCollection'
import { registerBlock, clearBlocks } from '../../../fields/server/utils/defineBlock'
import { requireAdmin } from '../../../access/server/utils/require-admin'

const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: false, pageLike: true, status: true, blocks: { enabled: true },
  fields: { title: { type: 'text' }, body: { type: 'richtext' } },
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
  requireAdmin,
  getCollection: (name: string) => (name === 'pages' ? pages : null),
})

const mintHandler = (await import('./preview.post')).default as unknown as (event: FakeEvent) => Promise<{ token: string; expiresAt: number }>
const readHandler = (await import('./preview.get')).default as unknown as (event: FakeEvent) => { payload: unknown } | null

const session = (userId: string | null) => ({ context: { principal: { userId, role: 'admin' } } })
const mint = (b: Record<string, unknown>, userId: string | null = 'u1') => { body = b; return mintHandler(session(userId)) }
const read = (token: string, userId: string | null = 'u1') => readHandler({ ...session(userId), query: { token } })

const rendererSession = { context: { principal: { userId: 'renderer', role: 'renderer' } } }

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

  // Forward-looking: `derivePrincipal` gives every admin session the same owner today (see the module
  // docstring in preview-token.ts), so a real request can never present two distinct owners — this pins
  // the owner-mismatch mechanism a future per-user identity would rely on, not a boundary live today.
  it('refuses a read whose owner does not match the mint', async () => {
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

  it('401s a renderer principal on both halves — read-only role, not merely "some principal present"', async () => {
    body = payload
    expect(await statusOf(() => mintHandler(rendererSession))).toBe(401)
    expect(await statusOf(() => readHandler({ ...rendererSession, query: { token: 'x' } }))).toBe(401)
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

describe('/api/preview — sanitizes richtext on the way IN, so the ticket holds what a save would store', () => {
  const evil = '<p onclick="x">hi</p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">j</a>'
  const clean = '<p>hi</p><a>j</a>'

  beforeEach(() => {
    clearBlocks()
    registerBlock({ name: 'prose', fields: { body: { type: 'richtext' } } })
  })
  afterEach(() => clearBlocks())

  it('sanitizes a top-level richtext field before it is ever stored in the ticket', async () => {
    const { token } = await mint({ ...payload, values: { ...payload.values, body: evil } })
    const result = read(token) as { payload: { values: Record<string, unknown> } }
    expect(result.payload.values.body).toBe(clean)
  })

  it('sanitizes richtext nested inside a block in the content tree', async () => {
    const { token } = await mint({
      ...payload,
      values: { ...payload.values, content: [{ id: 'a', type: 'prose', props: { body: evil } }] },
    })
    const result = read(token) as { payload: { values: { content: Array<{ props: { body: string } }> } } }
    expect(result.payload.values.content[0]!.props.body).toBe(clean)
  })
})
