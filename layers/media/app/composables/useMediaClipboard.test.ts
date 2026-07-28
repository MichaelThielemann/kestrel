import { describe, it, expect, beforeEach } from 'vitest'
import { useMediaClipboard } from './useMediaClipboard'

describe('useMediaClipboard', () => {
  beforeEach(() => useMediaClipboard().clear())
  it('cut/copy set the mode + items, clear empties, and state is a shared singleton', () => {
    const a = useMediaClipboard()
    expect(a.isEmpty.value).toBe(true)
    a.cut([{ type: 'file', id: 1 }])
    expect(a.clipboard.value).toEqual({ mode: 'cut', items: [{ type: 'file', id: 1 }] })
    expect(a.isEmpty.value).toBe(false)
    expect(a.count.value).toBe(1)
    const b = useMediaClipboard() // same singleton
    expect(b.clipboard.value?.mode).toBe('cut')
    b.copy([{ type: 'folder', path: 'p' }, { type: 'file', id: 2 }])
    expect(a.clipboard.value).toEqual({ mode: 'copy', items: [{ type: 'folder', path: 'p' }, { type: 'file', id: 2 }] })
    expect(a.count.value).toBe(2)
    a.clear()
    expect(a.isEmpty.value).toBe(true)
  })
})
