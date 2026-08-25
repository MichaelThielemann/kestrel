import { describe, it, expect, afterEach } from 'vitest'
import { setRenderRouteLive, renderRouteLive, clearRenderRouteLive } from '../../../../src/server/utils/publish/render-seam.js'

afterEach(() => { clearRenderRouteLive() })

describe('render-seam — set/get/clear', () => {
  it('throws before setRenderRouteLive has ever been called', () => {
    expect(() => renderRouteLive('/x')).toThrow(/renderRouteLive\(\) called before setRenderRouteLive\(\)/)
  })

  it('the throw message names the real remedy (setRenderRouteLive at point-of-use), not a module-load side effect', () => {
    expect(() => renderRouteLive('/x')).toThrow(/must call setRenderRouteLive\(renderRouteLive\) itself/)
  })

  it('renders through the wired implementation once set', async () => {
    setRenderRouteLive(async (route) => ({ body: Buffer.from(route), status: 200 }))
    const result = await renderRouteLive('/a')
    expect(result).toEqual({ body: Buffer.from('/a'), status: 200 })
  })

  it('clearRenderRouteLive resets the seam back to the throw state', async () => {
    setRenderRouteLive(async () => ({ body: null, status: 200 }))
    await expect(renderRouteLive('/x')).resolves.toBeDefined()
    clearRenderRouteLive()
    expect(() => renderRouteLive('/x')).toThrow(/renderRouteLive\(\) called before setRenderRouteLive\(\)/)
  })
})
