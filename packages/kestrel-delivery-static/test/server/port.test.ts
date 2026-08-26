import { describe, it, expect, vi } from 'vitest'
import type { StorageDriver } from '@michaelthielemann/kestrel-core'
import type { PublishedSnapshot } from '@michaelthielemann/kestrel-contracts'
import { createStaticDeliveryPort, deliveryPortFor } from '../../src/server/port.js'

function snapshot(route: string, html = '<p/>'): PublishedSnapshot {
  return { route, locale: null, html, media: [], fingerprint: 'f', publishedAt: 0 } as unknown as PublishedSnapshot
}

function fakeDriver(): StorageDriver & { puts: Array<{ key: string; body: string; type: string }>; deletes: string[] } {
  const puts: Array<{ key: string; body: string; type: string }> = []
  const deletes: string[] = []
  return {
    puts,
    deletes,
    async put(key: string, bytes: Buffer | Uint8Array, type: string) { puts.push({ key, body: Buffer.from(bytes).toString(), type }) },
    async delete(key: string) { deletes.push(key) },
    async copy() {},
    publicUrl: (key: string) => `/${key}`,
  } as StorageDriver & { puts: Array<{ key: string; body: string; type: string }>; deletes: string[] }
}

describe('createStaticDeliveryPort', () => {
  it('publishSnapshot writes the snapshot html through the driver, keyed by route', async () => {
    const driver = fakeDriver()
    const port = createStaticDeliveryPort(driver)
    await port.publishSnapshot(snapshot('/about', '<h1>About</h1>'))
    expect(driver.puts).toHaveLength(1)
    expect(driver.puts[0]!.body).toBe('<h1>About</h1>')
  })

  it('removeRoutes deletes each route, pruning empty dirs', async () => {
    const driver = fakeDriver()
    const deleteSpy = vi.spyOn(driver, 'delete')
    const port = createStaticDeliveryPort(driver)
    await port.removeRoutes(['/a', '/b'])
    expect(driver.deletes.length).toBe(2)
    expect(deleteSpy).toHaveBeenCalledWith(expect.any(String), { pruneEmptyDirs: true })
  })

  it('rebuildAll writes every snapshot from the iterator', async () => {
    const driver = fakeDriver()
    const port = createStaticDeliveryPort(driver)
    async function* snapshots(): AsyncGenerator<PublishedSnapshot> {
      yield snapshot('/1')
      yield snapshot('/2')
    }
    await port.rebuildAll(snapshots())
    expect(driver.puts).toHaveLength(2)
  })
})

describe('deliveryPortFor', () => {
  it('returns the static (driver-backed) port for "static"', async () => {
    const driver = fakeDriver()
    const port = deliveryPortFor('static', driver)
    await port.publishSnapshot(snapshot('/x'))
    expect(driver.puts).toHaveLength(1)
  })

  it('returns the live (no-op) port for "live" — the driver is never touched', async () => {
    const driver = fakeDriver()
    const port = deliveryPortFor('live', driver)
    await port.publishSnapshot(snapshot('/x'))
    expect(driver.puts).toHaveLength(0)
  })
})
