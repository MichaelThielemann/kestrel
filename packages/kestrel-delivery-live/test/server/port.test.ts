import { describe, it, expect } from 'vitest'
import type { PublishedSnapshot } from '@michaelthielemann/kestrel-contracts'
import { createLiveDeliveryPort } from '../../src/server/port.js'

function snapshot(route: string): PublishedSnapshot {
  return { route, locale: null, html: '<p/>', media: [], fingerprint: 'f', publishedAt: 0 } as unknown as PublishedSnapshot
}

describe('createLiveDeliveryPort', () => {
  it('publishSnapshot resolves without writing anywhere (published_snapshots is already the persistence)', async () => {
    const port = createLiveDeliveryPort()
    await expect(port.publishSnapshot(snapshot('/x'))).resolves.toBeUndefined()
  })

  it('removeRoutes resolves without touching a driver', async () => {
    const port = createLiveDeliveryPort()
    await expect(port.removeRoutes(['/a', '/b'])).resolves.toBeUndefined()
  })

  it('rebuildAll drains the iterator fully instead of returning early', async () => {
    const port = createLiveDeliveryPort()
    let drained = 0
    async function* snapshots(): AsyncGenerator<PublishedSnapshot> {
      for (let i = 0; i < 3; i++) {
        drained++
        yield snapshot(`/${i}`)
      }
    }
    await port.rebuildAll(snapshots())
    expect(drained).toBe(3)
  })
})
