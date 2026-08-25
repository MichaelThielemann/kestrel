import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { Conflict, Forbidden, Locked, NotFound, Quarantined, Unauthorized, ValidationFailed } from '@kestrel/contracts'
import { callPipelineRoute, usePipelineRouteDb } from '../../../../test/helpers/pipeline-route'
import { buildCollection, clearPipelines, clearRegistry, defineCollection, desiredSchema, diffSchema, registerCollection, registerPipeline, renderSqlite, syncStep  } from '@kestrel/core'
const notes = buildCollection(defineCollection({
  name: 'notes', mode: 'multi', translatable: false, status: true,
  fields: { title: { type: 'text', required: true } },
}))

beforeEach(() => {
  clearRegistry()
  clearPipelines()
  const sqlite = new Database(':memory:')
  for (const stmt of renderSqlite(diffSchema(desiredSchema([notes.table]), {}))) sqlite.exec(stmt)
  usePipelineRouteDb(drizzle(sqlite))
  registerCollection(notes)
})
afterEach(() => { clearRegistry(); clearPipelines() })

/** A collection-less custom pipeline (`/api/<name>`) whose one step throws the given error — the shortest
 *  path from "a step raised a KestrelError value" to "what did the HTTP edge (core/server/api/[...path].ts)
 *  turn it into". */
function throwingPipeline(name: string, error: unknown): void {
  registerPipeline({ name, access: { role: 'admin' }, steps: [syncStep('boom', () => { throw error })] })
}

describe('the HTTP edge — a KestrelError value from a step maps to the right status', () => {
  it.each([
    ['NotFound', new NotFound({ collection: 'notes', id: 1 }), 404],
    ['Forbidden', new Forbidden({ reason: 'no grant' }), 403],
    ['Unauthorized', new Unauthorized({ reason: 'invalid credentials' }), 401],
    ['Conflict', new Conflict({ field: 'slug', value: 'taken' }), 409],
    ['ValidationFailed', new ValidationFailed({ issues: [{ path: ['title'], message: 'required' }] }), 400],
    ['Locked', new Locked({ until: '2026-01-01T00:00:00.000Z' }), 423],
    ['Quarantined', new Quarantined({ id: 1 }), 409],
  ] as const)('%s maps to %i', async (tag, error, status) => {
    throwingPipeline(tag, error)
    await expect(callPipelineRoute('POST', `/api/${tag}`, { role: 'admin' }))
      .rejects.toMatchObject({ statusCode: status })
  })

  it('carries the ValidationFailed issues through as the h3 error data', async () => {
    throwingPipeline('carriesIssues', new ValidationFailed({ issues: [{ path: ['title'], message: 'required' }] }))
    await expect(callPipelineRoute('POST', '/api/carriesIssues', { role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 400, statusMessage: 'required', data: [{ path: ['title'], message: 'required' }] })
  })

  it('a single-record NotFound composes "<collection> <id> not found"', async () => {
    throwingPipeline('singleNotFound', new NotFound({ collection: 'notes', id: 7 }))
    await expect(callPipelineRoute('POST', '/api/singleNotFound', { role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 404, statusMessage: 'notes 7 not found' })
  })

  it('a batch NotFound (ids) lists every missing id, not just the first', async () => {
    throwingPipeline('batchNotFound', new NotFound({ collection: 'notes', id: 1, ids: [1, 5, 9] }))
    await expect(callPipelineRoute('POST', '/api/batchNotFound', { role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 404, statusMessage: 'notes 1, 5, 9 not found' })
  })

  // A gate's own evaluator message is already a complete, user-facing sentence (pipeline-gates.ts's
  // exact wording) — messageFor must pass it through unprefixed, not prepend the tag name. `toBe`, not
  // `stringContaining`: a regression back to prefixing (`"Unauthorized: Authentication required"`, or
  // the nonsensical `"Forbidden: Forbidden"` the ip-allowlist gate's own message would produce) must fail
  // loudly, not slip past a substring check.
  it('a gate denial (missing auth) surfaces the access gate\'s own message, unprefixed', async () => {
    registerPipeline({ name: 'gateAuth', access: { role: 'admin' }, steps: [syncStep('boom', () => {})] })
    await expect(callPipelineRoute('POST', '/api/gateAuth', {}))
      .rejects.toMatchObject({ statusCode: 401, statusMessage: 'Authentication required' })
  })

  it('a gate denial (cross-origin write) surfaces the csrf gate\'s own message, unprefixed', async () => {
    registerPipeline({ name: 'gateCsrf', access: { role: 'admin' }, steps: [syncStep('boom', () => {})] })
    await expect(callPipelineRoute('POST', '/api/gateCsrf', { role: 'admin', secFetchSite: 'cross-site' }))
      .rejects.toMatchObject({ statusCode: 403, statusMessage: 'Cross-origin write rejected' })
  })

  it('the ip-allowlist gate\'s own message ("Forbidden") does not become the nonsense "Forbidden: Forbidden"', async () => {
    // Exercises messageFor directly with the exact reason the ip-allowlist gate's evaluator constructs
    // (`pipeline-gates.ts`'s evaluateIpAllowlistGate: `{ status: 403, message: 'Forbidden' }`) — wiring
    // the real ip-allowlist config through this harness would only re-prove the same messageFor branch
    // the two gate cases above already drive through the real gate path.
    throwingPipeline('gateIp', new Forbidden({ reason: 'Forbidden' }))
    await expect(callPipelineRoute('POST', '/api/gateIp', { role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 403, statusMessage: 'Forbidden' })
  })

  it('passes a non-KestrelError step failure through unchanged (an h3 error keeps its own status)', async () => {
    registerPipeline({
      name: 'rawH3',
      access: { role: 'admin' },
      steps: [syncStep('boom', () => {
        const e = new Error('nope') as Error & { statusCode: number }
        e.statusCode = 418
        throw e
      })],
    })
    await expect(callPipelineRoute('POST', '/api/rawH3', { role: 'admin' }))
      .rejects.toMatchObject({ statusCode: 418 })
  })
})
