import { describe, it, expect, vi, beforeEach } from 'vitest'

const currentSnapshot = vi.fn()

vi.mock('@kestrel/publishing', () => ({
  usePublishingDb: () => ({ db: {} }),
  currentSnapshot: (...args: unknown[]) => currentSnapshot(...args),
}))

describe('renderRoute', () => {
  beforeEach(() => currentSnapshot.mockReset())

  it('returns a 404 with a null body when no snapshot exists for the route', async () => {
    currentSnapshot.mockReturnValue(undefined)
    const { renderRoute } = await import('../../src/server/render-route.js')
    expect(renderRoute('/never-published')).toEqual({ body: null, status: 404 })
  })

  it('returns the snapshot html as a 200 buffer when one exists', async () => {
    currentSnapshot.mockReturnValue({ html: '<h1>hi</h1>' })
    const { renderRoute } = await import('../../src/server/render-route.js')
    const res = renderRoute('/about')
    expect(res.status).toBe(200)
    expect(res.body?.toString()).toBe('<h1>hi</h1>')
  })
})
