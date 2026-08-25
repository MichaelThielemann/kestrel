import { describe, it, expect } from 'vitest'
import { runAsRenderer, isRendererContext } from '../../../src/server/utils/render-context.js'

describe('render-context', () => {
  it('isRendererContext is true only inside runAsRenderer — and propagates across awaits', async () => {
    expect(isRendererContext()).toBe(false)
    expect(runAsRenderer(() => isRendererContext())).toBe(true)
    const asyncResult = await runAsRenderer(async () => {
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 1))
      return isRendererContext()
    })
    expect(asyncResult).toBe(true)
    expect(isRendererContext()).toBe(false) // leaves no global state behind
  })
})
