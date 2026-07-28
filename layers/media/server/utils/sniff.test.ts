import { describe, it, expect } from 'vitest'
import { sniffMime, resolveAllowedMimes, DEFAULT_ALLOWED_MIME, extForMime } from './sniff'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
const SVG_DOCTYPE = Buffer.from('<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
const SVG_COMMENT = Buffer.from('<!-- Generator: Acme 1.0 -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')

describe('sniffMime', () => {
  it('detects PNG from magic bytes', async () => { expect(await sniffMime(PNG)).toBe('image/png') })
  it('detects SVG (text-based) as image/svg+xml', async () => { expect(await sniffMime(SVG)).toBe('image/svg+xml') })
  it('detects SVG that leads with a DOCTYPE or a comment (not only a bare <svg / xml decl)', async () => {
    expect(await sniffMime(SVG_DOCTYPE)).toBe('image/svg+xml')
    expect(await sniffMime(SVG_COMMENT)).toBe('image/svg+xml')
  })
  it('does not mistake HTML that leads with a DOCTYPE for SVG', async () => {
    // (generic XML is caught earlier by the magic-byte sniff as application/xml, so it never reaches the SVG
    // heuristic; HTML is not, so the heuristic itself must not false-positive on a leading DOCTYPE.)
    expect(await sniffMime(Buffer.from('<!DOCTYPE html><html><body></body></html>'))).toBeNull()
  })
  it('returns null for unrecognized bytes', async () => { expect(await sniffMime(Buffer.from('not a real file'))).toBeNull() })
  it('DEFAULT_ALLOWED_MIME includes png/jpeg/webp/gif/avif/pdf/svg', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'application/pdf', 'image/svg+xml']) {
      expect(DEFAULT_ALLOWED_MIME.has(m)).toBe(true)
    }
  })
})

describe('resolveAllowedMimes', () => {
  it('empty/absent → the built-in default (incl. the new formats)', () => {
    const d = resolveAllowedMimes(undefined)
    expect(d).toBe(DEFAULT_ALLOWED_MIME)
    expect(d.has('image/png')).toBe(true)
    expect(d.has('application/pdf')).toBe(true)
    expect(d.has('video/mp4')).toBe(true)
    expect(d.has('audio/flac')).toBe(true)
    expect(d.has('audio/x-m4a')).toBe(true) // typical m4a → file-type emits x-m4a, not audio/mp4
    expect(d.has('audio/ogg; codecs=opus')).toBe(true)
    expect(d.has('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true)
    expect(d.has('application/vnd.oasis.opendocument.text')).toBe(true)
    expect(resolveAllowedMimes('')).toBe(DEFAULT_ALLOWED_MIME)
  })
  it('a non-empty list overrides the default exactly (trimmed)', () => {
    const s = resolveAllowedMimes(' image/png , application/pdf ,')
    expect([...s].sort()).toEqual(['application/pdf', 'image/png'])
    expect(s.has('video/mp4')).toBe(false)
  })
  it('the default excludes executable/text/font types', () => {
    for (const m of ['text/html', 'application/javascript', 'image/svg+xml; bad', 'font/woff2', 'application/zip', 'text/plain']) {
      // svg+xml IS allowed; html/js/zip/woff2/plain are NOT in the default
      if (m === 'image/svg+xml; bad') continue
      expect(DEFAULT_ALLOWED_MIME.has(m)).toBe(false)
    }
    expect(DEFAULT_ALLOWED_MIME.has('image/svg+xml')).toBe(true)
  })
})

describe('extForMime (new formats)', () => {
  it('maps the new MIMEs', () => {
    expect(extForMime('video/mp4')).toBe('mp4')
    expect(extForMime('audio/flac')).toBe('flac')
    expect(extForMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx')
    expect(extForMime('application/octet-stream')).toBe('bin') // unknown → bin
  })
})
