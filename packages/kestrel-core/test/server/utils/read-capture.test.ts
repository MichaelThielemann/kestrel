import { describe, it, expect } from 'vitest'
import { captureRead, withReadCapture } from '../../../src/server/utils/read-capture.js'

describe('read-capture', () => {
  it('collects collection + record tags during a capture run', async () => {
    const { result, tags } = await withReadCapture(async () => {
      captureRead('speakers')      // list(speakers)      -> collection tag
      captureRead('speakers', 7)   // getOne(speakers, 7) -> record tag
      captureRead('settings')      // getSingleton        -> collection tag
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(tags.sort()).toEqual(['settings', 'speakers', 'speakers:7'])
  })

  it('captureRead is a no-op outside a capture run (no throw, nothing leaks)', () => {
    expect(() => captureRead('x', 1)).not.toThrow()
  })

  it('captures nested/async reads — AsyncLocalStorage propagates across awaits (the render path)', async () => {
    const { tags } = await withReadCapture(async () => {
      await Promise.resolve()
      captureRead('a')
      await new Promise((r) => setTimeout(r, 1))
      captureRead('b', 2)
    })
    expect(tags.sort()).toEqual(['a', 'b:2'])
  })
})
