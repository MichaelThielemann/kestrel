import { describe, it, expect } from 'vitest'
import { buildMediaValues, derivativeKey, withPreservedTranslations, type DerivativeManifest } from './record'

describe('buildMediaValues', () => {
  it('assembles a media row + derivative manifest from a processed upload', () => {
    const v = buildMediaValues({
      storageKey: 'seite-a/hero.webp', folder: 'seite-a', filename: 'hero.webp',
      mime: 'image/png', ext: 'png', size: 1234, checksum: 'abc',
      derived: { width: 800, height: 600, thumbhash: 'TH', variants: [{ name: 'w640', width: 640, height: 480, format: 'webp', mime: 'image/webp', bytes: Buffer.alloc(1) }] },
      translations: { en: { alt: 'Cat' } },
    })
    expect(v.storageKey).toBe('seite-a/hero.webp')
    expect(v.width).toBe(800)
    expect(v.thumbhash).toBe('TH')
    // manifest is name-keyed (`<name>.<format>`); height is the REAL output dim carried on the variant, and
    // the derivative key keeps the original's full extension so two same-stem uploads never share objects
    expect(v.derivatives).toEqual({ 'w640.webp': { key: 'seite-a/hero.webp-w640.webp', width: 640, height: 480, mime: 'image/webp' } })
    expect(v.translations).toEqual({ en: { alt: 'Cat' } })
  })

  it('derivative keys are collision-free across same-stem, different-extension uploads (logo.png vs logo.jpg)', () => {
    const variants = [{ name: 'w320', width: 320, height: 240, format: 'webp' as const, mime: 'image/webp', bytes: Buffer.alloc(1) }]
    const png = buildMediaValues({ storageKey: 'brand/logo.png', folder: 'brand', filename: 'logo.png', mime: 'image/png', ext: 'png', size: 1, checksum: 'a', derived: { width: 800, height: 600, thumbhash: 'T', variants } })
    const jpg = buildMediaValues({ storageKey: 'brand/logo.jpg', folder: 'brand', filename: 'logo.jpg', mime: 'image/jpeg', ext: 'jpg', size: 1, checksum: 'b', derived: { width: 800, height: 600, thumbhash: 'T', variants } })
    const keyOf = (v: Record<string, unknown>) => (v.derivatives as DerivativeManifest)['w320.webp'].key
    expect(keyOf(png)).not.toBe(keyOf(jpg)) // must NOT both be brand/logo-w320.webp
    expect(keyOf(png)).toBe('brand/logo.png-w320.webp')
    expect(keyOf(jpg)).toBe('brand/logo.jpg-w320.webp')
  })

  it('derivativeKey keeps the source extension in the stem (name-keyed) so it stays injective', () => {
    expect(derivativeKey('a/logo.png', 'w320', 'webp')).toBe('a/logo.png-w320.webp')
    expect(derivativeKey('a/logo.png', 'w320', 'webp')).not.toBe(derivativeKey('a/logo.jpg', 'w320', 'webp'))
  })
  it('writes the AI-disclosure columns ONLY when there is a value — so an overwrite never wipes them', () => {
    const bare = buildMediaValues({ storageKey: 'a/x.png', folder: 'a', filename: 'x.png', mime: 'image/png', ext: 'png', size: 1, checksum: 'c' })
    // absent from the update `set()` ⇒ a re-upload leaves an editor's existing disclosure untouched
    expect('aiSourceType' in bare).toBe(false)
    expect('aiNote' in bare).toBe(false)
    const tagged = buildMediaValues({
      storageKey: 'a/x.png', folder: 'a', filename: 'x.png', mime: 'image/png', ext: 'png', size: 1, checksum: 'c',
      aiSourceType: 'trainedAlgorithmicMedia', aiNote: 'Midjourney v7',
    })
    expect(tagged).toMatchObject({ aiSourceType: 'trainedAlgorithmicMedia', aiNote: 'Midjourney v7' })
  })

  it('handles a non-image (no derived) row with null dims + empty manifest', () => {
    const v = buildMediaValues({ storageKey: 'docs/x.pdf', folder: 'docs', filename: 'x.pdf', mime: 'application/pdf', ext: 'pdf', size: 9, checksum: 'd' })
    expect(v.width).toBeNull()
    expect(v.derivatives).toEqual({})
  })
})

describe('withPreservedTranslations (overwrite metadata preservation)', () => {
  const base = () => buildMediaValues({ storageKey: 'a/hero.webp', folder: 'a', filename: 'hero.webp', mime: 'image/webp', ext: 'webp', size: 1, checksum: 'c' })
  it('keeps existing per-locale metadata when the re-upload carries none', () => {
    const out = withPreservedTranslations(base(), { translations: { en: { alt: 'Cat' }, de: { alt: 'Katze' } } })
    expect(out.translations).toEqual({ en: { alt: 'Cat' }, de: { alt: 'Katze' } })
  })
  it('merges incoming primary-locale fields over the existing metadata, leaving other locales intact', () => {
    const withNew = buildMediaValues({ storageKey: 'a/hero.webp', folder: 'a', filename: 'hero.webp', mime: 'image/webp', ext: 'webp', size: 1, checksum: 'c', translations: { en: { alt: 'New' } } })
    const out = withPreservedTranslations(withNew, { translations: { en: { alt: 'Old', title: 'T' }, de: { alt: 'Katze' } } })
    expect(out.translations).toEqual({ en: { alt: 'New', title: 'T' }, de: { alt: 'Katze' } })
  })
  it('is a no-op ({} translations) when there is no existing row metadata', () => {
    const out = withPreservedTranslations(base(), undefined)
    expect(out.translations).toEqual({})
  })
})
