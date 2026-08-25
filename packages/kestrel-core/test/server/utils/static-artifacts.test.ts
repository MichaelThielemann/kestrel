import { describe, it, expect } from 'vitest'
import { contentTypeFor, precompressedEncoding, cacheControlFor } from '../../../src/server/utils/static-artifacts.js'

describe('contentTypeFor', () => {
  it('maps common static extensions and falls back to octet-stream', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('a/b/app.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('chunk.mjs')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('hero.webp')).toBe('image/webp')
    expect(contentTypeFor('sitemap.xml')).toBe('application/xml; charset=utf-8')
    expect(contentTypeFor('weird.bin')).toBe('application/octet-stream')
  })

  it('covers wasm, media, fonts and documents that may sit under public/', () => {
    expect(contentTypeFor('app.wasm')).toBe('application/wasm')
    expect(contentTypeFor('clip.mp4')).toBe('video/mp4')
    expect(contentTypeFor('clip.webm')).toBe('video/webm')
    expect(contentTypeFor('theme.mp3')).toBe('audio/mpeg')
    expect(contentTypeFor('doc.pdf')).toBe('application/pdf')
    expect(contentTypeFor('data.csv')).toBe('text/csv; charset=utf-8')
    expect(contentTypeFor('brand.otf')).toBe('font/otf')
    expect(contentTypeFor('legacy.eot')).toBe('application/vnd.ms-fontobject')
  })

  it('strips a .br/.gz compression suffix and returns the underlying asset type', () => {
    expect(contentTypeFor('_nuxt/app.DEADBEEF.js.br')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('_nuxt/entry.CAFEBABE.css.gz')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('logo.svg.br')).toBe('image/svg+xml')
    expect(contentTypeFor('archive.br')).toBe('application/octet-stream')
  })

  it('does NOT strip the suffix when told no Content-Encoding will be sent (a standalone archive)', () => {
    // No sibling `catalog.json` exists, so this ships as-is with no Content-Encoding header — labelling
    // it `application/json` would make a browser try to parse raw gzip bytes as JSON text.
    expect(contentTypeFor('catalog.json.gz', false)).toBe('application/octet-stream')
    expect(contentTypeFor('backup.tar.gz', false)).toBe('application/octet-stream')
  })
})

describe('precompressedEncoding', () => {
  it('tags a sidecar whose uncompressed base is present in the same dir', () => {
    expect(precompressedEncoding('app.js.br', ['app.js', 'app.js.br'])).toBe('br')
    expect(precompressedEncoding('app.css.gz', ['app.css', 'app.css.gz'])).toBe('gzip')
  })
  it('leaves a standalone archive (no uncompressed base) unencoded so browsers do not corrupt it', () => {
    expect(precompressedEncoding('backup.tar.gz', ['backup.tar.gz'])).toBeUndefined()
    expect(precompressedEncoding('data.gz', ['data.gz'])).toBeUndefined()
  })
  it('returns undefined for a non-compressed file', () => {
    expect(precompressedEncoding('app.js', ['app.js'])).toBeUndefined()
  })
})

describe('cacheControlFor', () => {
  const IMMUTABLE = 'public, max-age=31536000, immutable'
  const REVALIDATE = 'public, max-age=0, must-revalidate'
  it('marks content-hashed _nuxt assets immutable + long-lived', () => {
    expect(cacheControlFor('_nuxt/app.D3adB33f.js')).toBe(IMMUTABLE)
    expect(cacheControlFor('_nuxt/builds/meta/x.json')).toBe(IMMUTABLE)
  })
  it("does NOT mark the app manifest (_nuxt/builds/latest.json) immutable — its stable URL's content changes per build", () => {
    expect(cacheControlFor('_nuxt/builds/latest.json')).toBe(REVALIDATE)
  })
  it('marks html, sitemap and robots must-revalidate (stable URL, content changes per deploy)', () => {
    expect(cacheControlFor('index.html')).toBe(REVALIDATE)
    expect(cacheControlFor('blog/my-post/index.html')).toBe(REVALIDATE)
    expect(cacheControlFor('sitemap.xml')).toBe(REVALIDATE)
    expect(cacheControlFor('robots.txt')).toBe(REVALIDATE)
    expect(cacheControlFor('llms.txt')).toBe(REVALIDATE)
    expect(cacheControlFor('llms-full.txt')).toBe(REVALIDATE)
    // The edge polls redirects.json; a cached copy would keep serving withdrawn redirects.
    expect(cacheControlFor('redirects.json')).toBe(REVALIDATE)
  })
  it('does not force revalidation on some other json', () => {
    expect(cacheControlFor('data/redirects.json.bak')).toBeUndefined()
    expect(cacheControlFor('manifest.json')).toBeUndefined()
  })
  it('leaves other (non-hashed) assets without an explicit policy — host default', () => {
    expect(cacheControlFor('favicon.ico')).toBeUndefined()
    expect(cacheControlFor('images/hero.webp')).toBeUndefined()
    expect(cacheControlFor('feed.xml')).toBeUndefined() // a non-sitemap xml is not forced to revalidate
    expect(cacheControlFor('notes.txt')).toBeUndefined() // only llms.txt is special, not every .txt
  })
})
