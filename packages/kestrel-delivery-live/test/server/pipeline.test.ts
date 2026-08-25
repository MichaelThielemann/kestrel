import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Effect } from 'effect'

const isDeliveryLive = vi.fn(() => false)
const currentSnapshot = vi.fn()

vi.mock('@kestrel/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kestrel/core')>()
  return { ...actual, isDeliveryLive: () => isDeliveryLive() }
})
vi.mock('@kestrel/publishing', () => ({
  usePublishingDb: () => ({ db: {} }),
  currentSnapshot: (...args: unknown[]) => currentSnapshot(...args),
}))

describe('buildDeliveryLivePipelines', () => {
  beforeEach(() => {
    isDeliveryLive.mockReset().mockReturnValue(false)
    currentSnapshot.mockReset()
  })

  it('defines exactly one public, published-scope read pipeline named deliverySnapshot', async () => {
    const { buildDeliveryLivePipelines } = await import('../../src/server/pipeline.js')
    const pipelines = buildDeliveryLivePipelines()
    expect(pipelines).toHaveLength(1)
    expect(pipelines[0]).toMatchObject({
      name: 'deliverySnapshot',
      read: true,
      access: { public: true, scope: 'published', resource: '_delivery/snapshot' },
    })
  })

  it('is inert (404) under static delivery — switching modes never widens what an anonymous caller can read', async () => {
    const { buildDeliveryLivePipelines } = await import('../../src/server/pipeline.js')
    const step = buildDeliveryLivePipelines()[0]!.steps![0]!
    const ctx = { input: { route: '/x' }, facts: {}, output: undefined } as never
    await expect(Effect.runPromise(step.fn(ctx))).rejects.toThrow(/delivery-live is not enabled/)
    expect(currentSnapshot).not.toHaveBeenCalled()
  })

  it('404s when live but no snapshot exists for the route', async () => {
    isDeliveryLive.mockReturnValue(true)
    currentSnapshot.mockReturnValue(undefined)
    const { buildDeliveryLivePipelines } = await import('../../src/server/pipeline.js')
    const step = buildDeliveryLivePipelines()[0]!.steps![0]!
    const ctx = { input: { route: '/missing' }, facts: {}, output: undefined } as never
    await expect(Effect.runPromise(step.fn(ctx))).rejects.toThrow(/No published snapshot/)
  })

  it('writes the resolved snapshot to ctx.output when live and found', async () => {
    isDeliveryLive.mockReturnValue(true)
    const snap = { route: '/x', html: '<p/>', fingerprint: 'f' }
    currentSnapshot.mockReturnValue(snap)
    const { buildDeliveryLivePipelines } = await import('../../src/server/pipeline.js')
    const step = buildDeliveryLivePipelines()[0]!.steps![0]!
    const ctx = { input: { route: '/x' }, facts: {}, output: undefined } as { output: unknown }
    await Effect.runPromise(step.fn(ctx as never))
    expect(ctx.output).toBe(snap)
  })
})
