import { describe, it, expect, vi, beforeEach } from 'vitest'

// The bug this pins (see render-seam.ts's own TSDoc): setRenderRouteLive() must be called BEFORE
// publishFull() — not merely "at some point during the run". `callOrder` is the evidence; the ordering IS
// the content of the fix, not just that both happened.
const callOrder: string[] = []
const publishFull = vi.fn(async () => {
  callOrder.push('publishFull')
  return { rendered: 1, pruned: 0 }
})
const setRenderRouteLive = vi.fn(() => {
  callOrder.push('setRenderRouteLive')
})

class FakeDepsStore {
  persistence: unknown
  constructor(persistence: unknown) { this.persistence = persistence }
}

// publisher/deps/deps-persistence all live in @michaelthielemann/kestrel-publishing — one mock covers all
// three (vi.mock only takes one factory per specifier), preserving every OTHER real export (incl.
// usePublishingDb, which run.ts also imports and this test does not stub) via importOriginal.
vi.mock('@michaelthielemann/kestrel-publishing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publishFull,
  outputDriver: () => 'THE_DRIVER',
  DepsStore: FakeDepsStore,
  createSqlitePersistence: (db: unknown) => ({ db }),
  setRenderRouteLive,
}))
// run.ts calls `setRenderRouteLive(renderRouteLive)` explicitly (see its own comment) before every run —
// the real renderRouteLive reaches for `nitropack/runtime`, which a node test has no build graph for; a
// stub function is all this test needs (publishFull itself is mocked above, so it is never actually called).
vi.mock('../../utils/publish/render-live', () => ({ renderRouteLive: () => Promise.resolve({ body: null, status: 200 }) }))

beforeEach(() => {
  vi.clearAllMocks()
  callOrder.length = 0
  Object.assign(globalThis, {
    defineTask: (def: unknown) => def,
    useDb: () => 'THE_DB',
  })
})

describe('publish:run task', () => {
  it('passes a durable DepsStore so the run prunes routes that left the published set', async () => {
    const task = (await import('./run')).default
    await task.run()
    expect(publishFull).toHaveBeenCalledTimes(1)
    const [driver, deps] = publishFull.mock.calls[0]
    expect(driver).toBe('THE_DRIVER')
    expect(deps).toBeInstanceOf(FakeDepsStore)
  })

  it('calls setRenderRouteLive BEFORE publishFull — the ordering is the bug this fixes, not just that both happen', async () => {
    const task = (await import('./run')).default
    await task.run()
    expect(setRenderRouteLive).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual(['setRenderRouteLive', 'publishFull'])
  })
})
