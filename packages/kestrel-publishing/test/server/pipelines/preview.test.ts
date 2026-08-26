import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import { clearPipelines, clearRegistry, defineCollection, registerCollection, registerPipeline, toHttpError, buildCollection  } from '@michaelthielemann/kestrel-core'
import { runPipelineForEvent } from '@michaelthielemann/kestrel-access'
import { clearBlocks, registerBlock } from '@michaelthielemann/kestrel-fields'
import { callPipelineRoute } from '../../../../../test/helpers/pipeline-route.js'
import { buildPreviewPipelines } from '../../../src/server/pipelines/preview.js'

const pages = buildCollection(defineCollection({
  name: 'pages', mode: 'multi', translatable: false, pageLike: true, status: true, blocks: { enabled: true },
  fields: { title: { type: 'text' }, body: { type: 'richtext' } },
}))

/** A session whose principal carries an explicit `userId`, which is what a ticket is bound to. */
function eventFor(userId: string | null, role = 'admin'): H3Event {
  const event = createEvent(
    { method: 'POST', url: '/api/preview', headers: { 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: '203.0.113.1' } } as never,
    { setHeader() {} } as never,
  )
  event.context.principal = { userId, role } as never
  return event
}

type Ticket = { token: string; expiresAt: number }
type Read = { payload: { collection: string; id: number | null; values: Record<string, unknown> } } | null

const mint = (body: Record<string, unknown>, userId: string | null = 'u1'): Ticket =>
  runPipelineForEvent<Ticket>(eventFor(userId), { op: 'createPreview', input: body })
const read = (token: unknown, userId: string | null = 'u1', role = 'admin'): Read =>
  runPipelineForEvent<Read>(eventFor(userId, role), { op: 'preview', input: { token } })

let payload: Record<string, unknown>
beforeEach(() => {
  clearRegistry()
  clearPipelines()
  registerCollection(pages)
  for (const def of buildPreviewPipelines()) registerPipeline(def)
  payload = { collection: 'pages', id: 1, locale: 'en', values: { title: 'Unsaved', content: [{ type: 'hero' }] } }
})
afterEach(() => { clearRegistry(); clearPipelines() })

// This test calls the driver (runPipelineForEvent) directly, below the HTTP edge (core/server/api/[...path].ts)
// that alone translates a KestrelError into an h3 status — toHttpError is that same translation, imported
// directly instead of a second, hand-maintained copy of its status map.
function statusOf(fn: () => unknown): number | undefined {
  try {
    fn()
  } catch (error) {
    return (toHttpError(error) as { statusCode?: number }).statusCode
  }
  return undefined
}

describe('preview pipelines — carrying unsaved editor state to a real page render', () => {
  it('mints a ticket and reads the same payload back', () => {
    const { token, expiresAt } = mint(payload)
    expect(token).toMatch(/\S{16,}/)
    expect(expiresAt).toBeGreaterThan(Date.now())
    expect(read(token)).toMatchObject({ payload: { collection: 'pages', id: 1, values: { title: 'Unsaved' } } })
  })

  it('accepts a record that has never been saved (id: null)', () => {
    const { token } = mint({ ...payload, id: null })
    expect(read(token)).toMatchObject({ payload: { id: null } })
  })

  // Forward-looking: `derivePrincipal` gives every admin session the same owner today (see the module
  // docstring in preview-token.ts), so a real request can never present two distinct owners — this pins
  // the owner-mismatch mechanism a future per-user identity would rely on, not a boundary live today.
  it('refuses a read whose owner does not match the mint', () => {
    const { token } = mint(payload, 'u1')
    expect(read(token, 'u2')).toBe(null)
  })

  it('returns null for an unknown or missing token rather than an error page', () => {
    expect(read('nope')).toBe(null)
    expect(read(undefined)).toBe(null)
  })

  it('401s an unauthenticated caller on both halves', () => {
    expect(statusOf(() => runPipelineForEvent(eventFor(null, 'anonymous'), { op: 'createPreview', input: payload }))).toBe(401)
    expect(statusOf(() => read('x', null, 'anonymous'))).toBe(401)
  })

  it('401s a renderer principal on the mint — a read-only role may never write a ticket', () => {
    expect(statusOf(() => runPipelineForEvent(eventFor('renderer', 'renderer'), { op: 'createPreview', input: payload }))).toBe(401)
  })

  it('404s an unknown collection', () => {
    expect(statusOf(() => mint({ ...payload, collection: 'ghosts' }))).toBe(404)
  })

  it('400s a payload without a values object', () => {
    expect(statusOf(() => mint({ collection: 'pages', id: 1 }))).toBe(400)
    expect(statusOf(() => mint({ ...payload, values: 'nope' }))).toBe(400)
  })

  it('413s a payload too large to be an editor form (an in-memory store is not an upload target)', () => {
    expect(statusOf(() => mint({ ...payload, values: { blob: 'x'.repeat(3_000_000) } }))).toBe(413)
  })
})

describe('preview pipelines — sanitizes richtext on the way IN, so the ticket holds what a save would store', () => {
  const evil = '<p onclick="x">hi</p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">j</a>'
  const clean = '<p>hi</p><a>j</a>'

  beforeEach(() => {
    clearBlocks()
    registerBlock({ name: 'prose', fields: { body: { type: 'richtext' } } })
  })
  afterEach(() => clearBlocks())

  it('sanitizes a top-level richtext field before it is ever stored in the ticket', () => {
    const { token } = mint({ ...payload, values: { ...(payload.values as Record<string, unknown>), body: evil } })
    expect(read(token)!.payload.values.body).toBe(clean)
  })

  it('sanitizes richtext nested inside a block in the content tree', () => {
    const { token } = mint({
      ...payload,
      values: { ...(payload.values as Record<string, unknown>), content: [{ id: 'a', type: 'prose', props: { body: evil } }] },
    })
    const content = read(token)!.payload.values.content as Array<{ props: { body: string } }>
    expect(content[0]!.props.body).toBe(clean)
  })
})

describe('preview pipelines — the URLs the editor and the public page call', () => {
  it('mints over POST /api/createPreview and reads it back over GET /api/preview', async () => {
    const ticket = await callPipelineRoute('POST', '/api/createPreview', { role: 'admin', body: payload }) as Ticket
    const back = await callPipelineRoute('GET', `/api/preview?token=${ticket.token}`, { role: 'admin' }) as Read
    expect(back).toMatchObject({ payload: { collection: 'pages', id: 1 } })
  })

  it('gives each half exactly one verb', async () => {
    await expect(callPipelineRoute('POST', '/api/preview', { role: 'admin', body: {} })).rejects.toMatchObject({ statusCode: 405 })
    await expect(callPipelineRoute('GET', '/api/createPreview', { role: 'admin' })).rejects.toMatchObject({ statusCode: 405 })
  })
})
