import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { createLocalDriver } from '../../../core/server/utils/storage.local'
import { sniffMime, extForMime, resolveAllowedMimes } from './sniff'
import { sanitizeSvg } from './sanitize-svg'
import { deriveImage } from './derive'
import { DEFAULT_IMAGE_POLICY } from '../../../core/server/utils/kestrel-config'
import { buildMediaValues, derivativeKey, type DerivativeManifest } from './record'
import { buildKey } from './naming'

const dir = mkdtempSync(join(tmpdir(), 'kestrel-ingest-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('media ingest chain (local)', () => {
  it('image: sniff → derive → store original + variants → record', async () => {
    const png = await sharp({ create: { width: 700, height: 400, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer()
    const mime = await sniffMime(png)
    expect(mime).toBe('image/png')
    const driver = createLocalDriver({ dir, baseUrl: '/uploads' })
    const key = buildKey('a', `pic.${extForMime(mime!)}`)
    const derived = await deriveImage(png, DEFAULT_IMAGE_POLICY)
    await driver.put(key, png, mime!)
    // Write each variant at the SHARED derivativeKey — exactly as the upload handler does — so the
    // stored objects can never diverge from the manifest keys.
    for (const v of derived.variants) {
      await driver.put(derivativeKey(key, v.name, v.format), v.bytes, v.mime)
    }
    const values = buildMediaValues({ storageKey: key, folder: 'a', filename: 'pic.png', mime: mime!, ext: 'png', size: png.length, checksum: createHash('sha256').update(png).digest('hex'), derived })
    expect(values.width).toBe(700)
    expect(Object.keys(values.derivatives as object)).toEqual(['w320.webp', 'w640.webp']) // 960+ skipped (>700)
    expect(existsSync(join(dir, 'a/pic.png'))).toBe(true)
    // the derivative key keeps the source extension (collision-free) and the stored object is at that key
    const d640 = (values.derivatives as DerivativeManifest)['w640.webp'].key
    expect(d640).toBe('a/pic.png-w640.webp')
    expect(existsSync(join(dir, d640))).toBe(true)
  })

  it('config gate: png accepted by default, rejected when allowedMimes excludes image/png', async () => {
    const png = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer()
    const mime = await sniffMime(png)
    expect(mime).toBe('image/png')
    // default allow-list accepts it
    expect(resolveAllowedMimes(undefined).has('image/png')).toBe(true)
    expect(resolveAllowedMimes('').has('image/png')).toBe(true)
    // restricted list rejects it
    const restricted = resolveAllowedMimes('application/pdf')
    expect(restricted.has('image/png')).toBe(false)
    expect(mime && !restricted.has(mime)).toBe(true)
  })

  it('svg: sanitized before store', async () => {
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>'
    const bytes = Buffer.from(dirty)
    expect(await sniffMime(bytes)).toBe('image/svg+xml')
    const clean = sanitizeSvg(bytes.toString('utf8'))
    expect(clean).not.toContain('script')
  })
})
