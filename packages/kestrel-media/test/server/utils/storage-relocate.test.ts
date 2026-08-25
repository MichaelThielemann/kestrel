import { describe, it, expect } from 'vitest'
import { planObjectRelocation } from '../../../src/server/utils/storage-relocate.js'
import type { DerivativeManifest } from '../../../src/server/utils/record.js'

const derivatives: DerivativeManifest = {
  '320.webp': { key: 'pages/hero.jpg-320.webp', width: 320, height: 240, mime: 'image/webp' },
  '640.webp': { key: 'pages/hero.jpg-640.webp', width: 640, height: 480, mime: 'image/webp' },
}

describe('planObjectRelocation', () => {
  it('recomputes the storageKey, derivative keys, and the copy list for a move', () => {
    const plan = planObjectRelocation({ storageKey: 'pages/hero.jpg', derivatives }, 'archive/2026', 'hero.jpg')
    expect(plan.storageKey).toBe('archive/2026/hero.jpg')
    // derivative keys keep the source extension in the stem (collision-free), tracking the new storageKey
    expect(plan.derivatives['320.webp'].key).toBe('archive/2026/hero.jpg-320.webp')
    expect(plan.derivatives['640.webp'].key).toBe('archive/2026/hero.jpg-640.webp')
    expect(plan.derivatives['320.webp']).toMatchObject({ width: 320, height: 240, mime: 'image/webp' })
    expect(plan.copies).toEqual([
      { src: 'pages/hero.jpg', dst: 'archive/2026/hero.jpg' },
      { src: 'pages/hero.jpg-320.webp', dst: 'archive/2026/hero.jpg-320.webp' },
      { src: 'pages/hero.jpg-640.webp', dst: 'archive/2026/hero.jpg-640.webp' },
    ])
  })
  it('handles a rename (new filename, same folder) and a row with no derivatives', () => {
    const plan = planObjectRelocation({ storageKey: 'a/old.png', derivatives: null }, 'a', 'new.png')
    expect(plan.storageKey).toBe('a/new.png')
    expect(plan.copies).toEqual([{ src: 'a/old.png', dst: 'a/new.png' }])
    expect(plan.derivatives).toEqual({})
  })
  it('handles a root-level target (empty folder)', () => {
    const plan = planObjectRelocation({ storageKey: 'a/x.png', derivatives: null }, '', 'x.png')
    expect(plan.storageKey).toBe('x.png')
  })
})
