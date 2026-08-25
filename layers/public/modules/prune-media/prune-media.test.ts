import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { referencedKeys, planMediaPrune, pruneUnreferencedMedia, mediaOwnedKeys } from './prune-media'

describe('referencedKeys', () => {
  it('extracts img src, a href and css url() keys under the prefix', () => {
    const text = '<img src="/uploads/a/hero.webp"><a href="/uploads/docs/spec.pdf">x</a>'
      + '.b{background:url(/uploads/bg/tile.png)}'
    expect(referencedKeys(text, '/uploads')).toEqual(new Set(['a/hero.webp', 'docs/spec.pdf', 'bg/tile.png']))
  })

  it('splits a srcset list (comma + width/pixel descriptors)', () => {
    const text = '<source srcset="/uploads/p-w320.webp 320w, /uploads/p-w640.webp 640w, /uploads/p-2x.webp 2x">'
    expect(referencedKeys(text, '/uploads')).toEqual(new Set(['p-w320.webp', 'p-w640.webp', 'p-2x.webp']))
  })

  it('stops the key at a query string or fragment', () => {
    const text = 'url(/uploads/a.webp?v=9) and "/uploads/b.webp#frag"'
    expect(referencedKeys(text, '/uploads')).toEqual(new Set(['a.webp', 'b.webp']))
  })

  it('is boundary-safe and honours a custom baseUrl', () => {
    const text = '<img src="/assets/other.webp"><img src="/myuploads/x.webp"><img src="/media/x/y.webp">'
    expect(referencedKeys(text, '/uploads')).toEqual(new Set()) // /myuploads/ must not match /uploads
    expect(referencedKeys(text, '/media')).toEqual(new Set(['x/y.webp']))
  })
})

describe('planMediaPrune', () => {
  it('returns the files not in the referenced set', () => {
    const files = ['a/keep.webp', 'a/orphan.webp', 'gone/x.webp']
    expect(planMediaPrune(files, new Set(['a/keep.webp']))).toEqual(['a/orphan.webp', 'gone/x.webp'])
  })
  it('prunes nothing when everything is referenced', () => {
    expect(planMediaPrune(['a.webp', 'b.webp'], new Set(['a.webp', 'b.webp']))).toEqual([])
  })
  it('with ownedKeys, only prunes media-library-owned files — non-owned blobs are never candidates', () => {
    const files = ['a/orphan.webp', 'galleries-secure/g1/x.bin', 'galleries-secure/g1/index.json']
    const owned = new Set(['a/orphan.webp', 'a/keep.webp'])
    // the two gallery blobs are unreferenced but NOT media-owned → kept; only the owned orphan is pruned
    expect(planMediaPrune(files, new Set(), owned)).toEqual(['a/orphan.webp'])
  })
})

describe('mediaOwnedKeys', () => {
  it('collects originals + every derivative key across rows', () => {
    const rows = [
      { storageKey: 'a/hero.webp', derivatives: { 'w320.webp': { key: 'a/hero.webp-w320.webp' }, 'w640.webp': { key: 'a/hero.webp-w640.webp' } } },
      { storageKey: 'docs/x.pdf', derivatives: null },
    ]
    expect(mediaOwnedKeys(rows)).toEqual(new Set(['a/hero.webp', 'a/hero.webp-w320.webp', 'a/hero.webp-w640.webp', 'docs/x.pdf']))
  })
})

describe('pruneUnreferencedMedia (integration)', () => {
  it('deletes baked media nothing references and keeps what the pages reference', () => {
    const publicDir = mkdtempSync(join(tmpdir(), 'kestrel-prune-'))
    try {
      writeFileSync(join(publicDir, 'index.html'),
        '<img src="/uploads/a/keep.webp"><source srcset="/uploads/a/keep-w640.webp 640w">')
      mkdirSync(join(publicDir, 'blog'), { recursive: true })
      writeFileSync(join(publicDir, 'blog', 'index.html'), '<a href="/uploads/docs/paper.pdf">d</a>')
      writeFileSync(join(publicDir, 'style.css'), '.h{background:url(/uploads/bg/hero.png)}')
      writeFileSync(join(publicDir, '_payload.json'), JSON.stringify({ src: '/uploads/a/keep.webp' }))

      const up = join(publicDir, 'uploads')
      for (const d of ['a', 'docs', 'bg', 'gone']) mkdirSync(join(up, d), { recursive: true })
      writeFileSync(join(up, 'a', 'keep.webp'), 'x')
      writeFileSync(join(up, 'a', 'keep-w640.webp'), 'x')
      writeFileSync(join(up, 'docs', 'paper.pdf'), 'x')
      writeFileSync(join(up, 'bg', 'hero.png'), 'x')
      writeFileSync(join(up, 'a', 'orphan.webp'), 'x')
      writeFileSync(join(up, 'gone', 'deleted-page.webp'), 'x')

      const res = pruneUnreferencedMedia(publicDir, '/uploads')
      expect(res).toEqual({ kept: 4, pruned: 2 })
      expect(existsSync(join(up, 'a', 'keep.webp'))).toBe(true)
      expect(existsSync(join(up, 'a', 'keep-w640.webp'))).toBe(true)
      expect(existsSync(join(up, 'docs', 'paper.pdf'))).toBe(true)
      expect(existsSync(join(up, 'bg', 'hero.png'))).toBe(true)
      expect(existsSync(join(up, 'a', 'orphan.webp'))).toBe(false)
      expect(existsSync(join(up, 'gone', 'deleted-page.webp'))).toBe(false)
    } finally {
      rmSync(publicDir, { recursive: true, force: true })
    }
  })

  it('dryRun reports the prune count but deletes nothing', () => {
    const publicDir = mkdtempSync(join(tmpdir(), 'kestrel-prune-dry-'))
    try {
      writeFileSync(join(publicDir, 'index.html'), '<img src="/uploads/keep.webp">')
      const up = join(publicDir, 'uploads')
      mkdirSync(up, { recursive: true })
      writeFileSync(join(up, 'keep.webp'), 'x')
      writeFileSync(join(up, 'orphan.webp'), 'x')

      const res = pruneUnreferencedMedia(publicDir, '/uploads', { dryRun: true })
      expect(res).toEqual({ kept: 1, pruned: 1 })
      expect(existsSync(join(up, 'orphan.webp'))).toBe(true) // untouched in dry-run
      expect(existsSync(join(up, 'keep.webp'))).toBe(true)
    } finally {
      rmSync(publicDir, { recursive: true, force: true })
    }
  })

  it('no-ops when the uploads dir was not baked into the output', () => {
    const publicDir = mkdtempSync(join(tmpdir(), 'kestrel-prune-none-'))
    try {
      writeFileSync(join(publicDir, 'index.html'), '<p>no media</p>')
      expect(pruneUnreferencedMedia(publicDir, '/uploads')).toEqual({ kept: 0, pruned: 0 })
    } finally {
      rmSync(publicDir, { recursive: true, force: true })
    }
  })

  it('keeps non-owned blobs (gallery ciphertext / index) baked under the media root when ownedKeys is supplied', () => {
    const publicDir = mkdtempSync(join(tmpdir(), 'kestrel-prune-owned-'))
    try {
      writeFileSync(join(publicDir, 'index.html'), '<img src="/uploads/a/keep.webp">') // gallery URLs are built at runtime, never literal
      const up = join(publicDir, 'uploads')
      mkdirSync(join(up, 'a'), { recursive: true })
      mkdirSync(join(up, 'galleries-secure', 'g1'), { recursive: true })
      writeFileSync(join(up, 'a', 'keep.webp'), 'x')
      writeFileSync(join(up, 'a', 'orphan.webp'), 'x') // owned + unreferenced → pruned
      writeFileSync(join(up, 'galleries-secure', 'g1', 'blob.bin'), 'x') // NOT owned → kept despite no literal ref
      writeFileSync(join(up, 'galleries-secure', 'g1', 'index.json'), '{}')

      const owned = new Set(['a/keep.webp', 'a/orphan.webp'])
      const res = pruneUnreferencedMedia(publicDir, '/uploads', { ownedKeys: owned })
      expect(res.pruned).toBe(1)
      expect(existsSync(join(up, 'a', 'orphan.webp'))).toBe(false)
      expect(existsSync(join(up, 'galleries-secure', 'g1', 'blob.bin'))).toBe(true)
      expect(existsSync(join(up, 'galleries-secure', 'g1', 'index.json'))).toBe(true)
    } finally {
      rmSync(publicDir, { recursive: true, force: true })
    }
  })

  it('honours a media reference that appears only in a JS chunk (widened scan)', () => {
    const publicDir = mkdtempSync(join(tmpdir(), 'kestrel-prune-js-'))
    try {
      writeFileSync(join(publicDir, 'index.html'), '<div id=app></div>')
      mkdirSync(join(publicDir, '_nuxt'), { recursive: true })
      writeFileSync(join(publicDir, '_nuxt', 'app.mjs'), 'const bg="/uploads/a/hero.webp"')
      const up = join(publicDir, 'uploads', 'a')
      mkdirSync(up, { recursive: true })
      writeFileSync(join(up, 'hero.webp'), 'x')
      const res = pruneUnreferencedMedia(publicDir, '/uploads', { ownedKeys: new Set(['a/hero.webp']) })
      expect(res.pruned).toBe(0) // referenced from JS → kept
      expect(existsSync(join(up, 'hero.webp'))).toBe(true)
    } finally {
      rmSync(publicDir, { recursive: true, force: true })
    }
  })
})
