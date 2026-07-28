import { describe, it, expect, vi, beforeEach } from 'vitest'

const publishFull = vi.fn(async () => ({ rendered: 1, pruned: 0 }))
vi.mock('../../utils/publish/publisher', () => ({
  publishFull,
  outputDriver: () => 'THE_DRIVER',
}))

class FakeDepsStore {
  persistence: unknown
  constructor(persistence: unknown) { this.persistence = persistence }
}
vi.mock('../../utils/publish/deps', () => ({ DepsStore: FakeDepsStore }))
vi.mock('../../utils/publish/deps-persistence', () => ({ createSqlitePersistence: (db: unknown) => ({ db }) }))

beforeEach(() => {
  vi.clearAllMocks()
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
})
