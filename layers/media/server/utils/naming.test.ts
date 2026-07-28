import { describe, it, expect } from 'vitest'
import { sanitizeFilename, sanitizeFolder, buildKey, suggestFreeName, withExtension, extensionOf } from './naming'

describe('naming', () => {
  it('sanitizeFilename strips unsafe chars + path bits, caps length', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('My Photo (1).JPG')).toBe('My_Photo_1_.JPG')
    expect(sanitizeFilename('a b.png')).toBe('a_b.png')
  })
  it('buildKey joins folder + name (no leading slash, normalized)', () => {
    expect(buildKey('seite-a', 'hero.webp')).toBe('seite-a/hero.webp')
    expect(buildKey('', 'hero.webp')).toBe('hero.webp')
    expect(buildKey('/x/', 'h.webp')).toBe('x/h.webp')
  })
  it('suggestFreeName appends -2, -3, … before the extension', () => {
    expect(suggestFreeName('hero.webp', (n) => n === 'hero.webp')).toBe('hero.webp')
    expect(suggestFreeName('hero.webp', (n) => n === 'hero-2.webp')).toBe('hero-2.webp')
  })
  it('suggestFreeName returns the first free slot when earlier suffixes are taken', () => {
    const taken = new Set(['hero.webp', 'hero-2.webp', 'hero-3.webp'])
    expect(suggestFreeName('hero.webp', (n) => !taken.has(n))).toBe('hero-4.webp')
  })
  it('sanitizeFolder drops ./.. segments (no traversal) and cleans segments', () => {
    expect(sanitizeFolder('../../etc')).toBe('etc')
    expect(sanitizeFolder('a/../b')).toBe('a/b')
    expect(sanitizeFolder('/seite-a/')).toBe('seite-a')
    expect(sanitizeFolder('a b/c')).toBe('a_b/c')
    expect(sanitizeFolder('')).toBe('')
  })
  it('buildKey never yields a traversal key even with a malicious folder', () => {
    expect(buildKey('../../etc', 'passwd')).toBe('etc/passwd')
  })
  it('sanitizeFilename falls back to "file" for bare ./.. names (no dot-only segments)', () => {
    expect(sanitizeFilename('.')).toBe('file')
    expect(sanitizeFilename('..')).toBe('file')
  })
  it('extensionOf returns the last extension, or empty for none/leading-dot', () => {
    expect(extensionOf('a.b.png')).toBe('png')
    expect(extensionOf('noext')).toBe('')
    expect(extensionOf('.hidden')).toBe('')
  })
  it('withExtension forces the extension from the trusted type, stripping the client one', () => {
    expect(withExtension('poc.html', 'pdf')).toBe('poc.pdf')
    expect(withExtension('photo', 'png')).toBe('photo.png')
    expect(withExtension('../../etc/passwd.html', 'pdf')).toBe('passwd.pdf')
    expect(withExtension('logo.svg', 'png')).toBe('logo.png')
  })
})
