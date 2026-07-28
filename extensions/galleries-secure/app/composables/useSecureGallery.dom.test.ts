import { describe, it, expect, vi } from 'vitest'
import { effectScope } from 'vue'

// `unlockRef` does the WebCrypto key derivation; a non-secure context (plain http, broken TLS termination)
// leaves `crypto.subtle` undefined there, which throws. That must not escape `unlock()` unhandled.
vi.mock('../utils/gallery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/gallery')>()
  return { ...actual, unlockRef: vi.fn() }
})

import { useSecureGallery, type GalleryViewRef } from './useSecureGallery'
import { unlockRef } from '../utils/gallery'

const ref0: GalleryViewRef = { v: 2, galleryId: 'g', saltB64: 'c2FsdA==', verify: { iv: 'a', data: 'b' }, base: '/x' }

describe('useSecureGallery.unlock — key-derivation failure must resolve, not hang', () => {
  it('goes to state "error" (not stuck in "unlocking") when unlockRef throws', async () => {
    vi.mocked(unlockRef).mockRejectedValueOnce(new TypeError('crypto.subtle is undefined'))
    const scope = effectScope()
    const { state, error, unlock } = scope.run(() => useSecureGallery(() => ref0))!
    const ok = await unlock('whatever')
    expect(ok).toBe(false)
    expect(state.value).toBe('error')
    expect(error.value).toBeTruthy()
    scope.stop()
  })
})
