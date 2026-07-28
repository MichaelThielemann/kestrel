import { describe, it, expect } from 'vitest'
import { mergeTranslations } from './translations'

describe('mergeTranslations', () => {
  it('merges patched fields within a locale without wiping its siblings', () => {
    const cur = { en: { alt: 'a', title: 't' }, de: { alt: 'd' } }
    expect(mergeTranslations(cur, { en: { alt: 'a2' } })).toEqual({ en: { alt: 'a2', title: 't' }, de: { alt: 'd' } })
  })
  it('adds a brand-new locale and tolerates a null/absent current map', () => {
    expect(mergeTranslations(null, { en: { alt: 'x' } })).toEqual({ en: { alt: 'x' } })
    expect(mergeTranslations({ en: { alt: 'a' } }, { de: { alt: 'd' } })).toEqual({ en: { alt: 'a' }, de: { alt: 'd' } })
  })
  it('ignores malformed input (non-object per-locale values or current/patch) instead of persisting garbage', () => {
    expect(mergeTranslations({ en: { alt: 'a' } }, { de: 'oops' } as never)).toEqual({ en: { alt: 'a' } })
    expect(mergeTranslations({ en: { alt: 'a' } }, { de: ['x'] } as never)).toEqual({ en: { alt: 'a' } })
    expect(mergeTranslations(['x'] as never, { en: { alt: 'a' } })).toEqual({ en: { alt: 'a' } })
  })
})
