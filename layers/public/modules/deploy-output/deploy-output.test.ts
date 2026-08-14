import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deployStaticOutput, contentTypeFor, precompressedEncoding, resolveOutputTarget, resolveOutputCreds, isEnvTrue, planS3Deploy, cacheControlFor, recordRouteDiscovery, readRouteDiscovery } from './deploy-output'

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

describe('resolveOutputTarget', () => {
  it('defaults to the local driver', () => {
    expect(resolveOutputTarget({}, {}).driver).toBe('local')
  })
  it('env wins over config, config over default (documented KESTREL_* precedence, matches the runtime publisher)', () => {
    expect(resolveOutputTarget({ driver: 's3' }, { KESTREL_OUTPUT_DRIVER: 'local' }).driver).toBe('local')
    expect(resolveOutputTarget({ driver: 'local' }, { KESTREL_OUTPUT_DRIVER: 's3' }).driver).toBe('s3')
    expect(resolveOutputTarget({ driver: 's3' }, {}).driver).toBe('s3')
  })
  it('resolves s3 settings with sensible defaults', () => {
    const t = resolveOutputTarget({ driver: 's3', s3: { bucket: 'site' } }, { KESTREL_OUTPUT_S3_PREFIX: 'p' })
    expect(t.s3).toEqual({ bucket: 'site', region: 'us-east-1', endpoint: '', prefix: 'p' })
  })
  it('is case-insensitive on the driver, matching resolveKestrel/resolveDriver', () => {
    expect(resolveOutputTarget({}, { KESTREL_OUTPUT_DRIVER: 'S3' }).driver).toBe('s3')
    expect(resolveOutputTarget({ driver: 'S3' }, {}).driver).toBe('s3')
  })
})

describe('resolveOutputCreds', () => {
  it('prefers KESTREL_OUTPUT_S3_* and falls back to the shared KESTREL_S3_* media creds (matches the runtime publisher)', () => {
    expect(resolveOutputCreds({ KESTREL_OUTPUT_S3_ACCESS_KEY_ID: 'out', KESTREL_S3_ACCESS_KEY_ID: 'shared' }).accessKeyId).toBe('out')
    expect(resolveOutputCreds({ KESTREL_S3_ACCESS_KEY_ID: 'shared' }).accessKeyId).toBe('shared')
    expect(resolveOutputCreds({ KESTREL_OUTPUT_S3_SECRET_ACCESS_KEY: 'os', KESTREL_S3_SECRET_ACCESS_KEY: 'ss' }).secretAccessKey).toBe('os')
  })
  it('returns empty strings when unset so planS3Deploy still detects the missing-credential case', () => {
    expect(resolveOutputCreds({})).toEqual({ accessKeyId: '', secretAccessKey: '', sessionToken: undefined })
  })
  it('falls back to the shared key when the output-specific var is set but empty (e.g. a blank .env/k8s placeholder)', () => {
    expect(resolveOutputCreds({ KESTREL_OUTPUT_S3_ACCESS_KEY_ID: '', KESTREL_S3_ACCESS_KEY_ID: 'shared' }).accessKeyId).toBe('shared')
    expect(resolveOutputCreds({ KESTREL_OUTPUT_S3_SECRET_ACCESS_KEY: '  ', KESTREL_S3_SECRET_ACCESS_KEY: 'shared-secret' }).secretAccessKey).toBe('shared-secret')
  })
  it('carries an optional session token with the same precedence', () => {
    expect(resolveOutputCreds({ KESTREL_OUTPUT_S3_SESSION_TOKEN: 't', KESTREL_S3_SESSION_TOKEN: 'f' }).sessionToken).toBe('t')
    expect(resolveOutputCreds({ KESTREL_S3_SESSION_TOKEN: 'f' }).sessionToken).toBe('f')
  })
})

describe('isEnvTrue', () => {
  it('treats the common truthy spellings as true (case-insensitive, trimmed)', () => {
    for (const v of ['true', '1', 'TRUE', 'Yes', 'on', ' true ']) expect(isEnvTrue(v)).toBe(true)
  })
  it('treats everything else as false', () => {
    for (const v of ['false', '0', 'no', 'off', '', '  ', undefined]) expect(isEnvTrue(v)).toBe(false)
  })
})

describe('planS3Deploy', () => {
  // Reconcile (--delete) is now always-on, so a real S3 generate REQUIRES a dedicated prefix; `ok` has one.
  const ok = { isStaticGenerate: true, dryRun: false, bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', prefix: 'site' }

  it('skips silently when this is not a static generate (e.g. a plain `nuxt build`)', () => {
    // No throw even though bucket + creds are absent — a build must never deploy.
    expect(planS3Deploy({ isStaticGenerate: false, dryRun: false, bucket: '', accessKeyId: '', secretAccessKey: '' })).toBe('skip')
  })

  it('deploys when it is a static generate with bucket + credentials + a prefix present', () => {
    expect(planS3Deploy(ok)).toBe('deploy')
  })

  it('skips when output.auto hands publishing to the running server (its live objects must not be reconciled away)', () => {
    expect(planS3Deploy({ ...ok, autoPublish: true })).toBe('skip')
    // Nothing else is even checked — a misconfigured bucket is irrelevant when we are not deploying.
    expect(planS3Deploy({ ...ok, autoPublish: true, bucket: '', prefix: '' })).toBe('skip')
    // Media overlap would normally throw; skipping outranks it — nothing is uploaded or pruned either way.
    expect(planS3Deploy({ ...ok, autoPublish: true, mediaBucket: 'b', mediaPrefix: 'site' })).toBe('skip')
  })

  it('still deploys for the build-time model (auto off / absent)', () => {
    expect(planS3Deploy({ ...ok, autoPublish: false })).toBe('deploy')
    expect(planS3Deploy(ok)).toBe('deploy')
  })

  it('allows a dry-run static generate even without bucket/credentials/prefix', () => {
    expect(planS3Deploy({ isStaticGenerate: true, dryRun: true, bucket: '', accessKeyId: '', secretAccessKey: '' })).toBe('deploy')
  })

  it('throws on a real static generate when the bucket is missing (no silent exit 0)', () => {
    expect(() => planS3Deploy({ ...ok, bucket: '' })).toThrow(/bucket/i)
  })

  it('throws on a real static generate when credentials are missing', () => {
    expect(() => planS3Deploy({ ...ok, accessKeyId: '' })).toThrow(/KESTREL_S3_ACCESS_KEY_ID/)
    expect(() => planS3Deploy({ ...ok, secretAccessKey: '' })).toThrow(/KESTREL_S3_SECRET_ACCESS_KEY/)
  })

  it('throws on a real generate when the prefix is empty (always-on reconcile would wipe the bucket root)', () => {
    expect(() => planS3Deploy({ ...ok, prefix: '' })).toThrow(/prefix/i)
  })
  it('allows a dry-run even without a prefix (read-only preview)', () => {
    expect(planS3Deploy({ isStaticGenerate: true, dryRun: true, prefix: '', bucket: '', accessKeyId: '', secretAccessKey: '' })).toBe('deploy')
  })

  it('refuses to deploy when the output prefix covers live media in the SAME bucket (reconcile would wipe it)', () => {
    // media lives under "site/uploads" in the same bucket → reconciling "site/" deletes it.
    expect(() => planS3Deploy({ ...ok, prefix: 'site', mediaBucket: 'b', mediaPrefix: 'site/uploads' }))
      .toThrow(/media/i)
    // exact-equal prefixes in the same bucket are just as unsafe.
    expect(() => planS3Deploy({ ...ok, prefix: 'site', mediaBucket: 'b', mediaPrefix: 'site' }))
      .toThrow(/media/i)
    // the reverse nesting (media prefix is an ancestor of the output prefix) wipes part of media too.
    expect(() => planS3Deploy({ ...ok, prefix: 'site/x', mediaBucket: 'b', mediaPrefix: 'site' }))
      .toThrow(/media/i)
  })

  it('allows deploy when media is in a different bucket or a disjoint prefix', () => {
    // different bucket → reconcile can't reach the media objects.
    expect(planS3Deploy({ ...ok, prefix: 'site', mediaBucket: 'other', mediaPrefix: 'site' })).toBe('deploy')
    // same bucket but disjoint prefixes → no overlap.
    expect(planS3Deploy({ ...ok, prefix: 'site', mediaBucket: 'b', mediaPrefix: 'media' })).toBe('deploy')
    // a prefix-collision sibling ("site" vs "siteother") is not a path-segment overlap.
    expect(planS3Deploy({ ...ok, prefix: 'site', mediaBucket: 'b', mediaPrefix: 'siteother' })).toBe('deploy')
    // media on the local driver (empty mediaBucket) is irrelevant to an S3 reconcile.
    expect(planS3Deploy({ ...ok, prefix: 'site', mediaBucket: '', mediaPrefix: '' })).toBe('deploy')
  })
})

describe('deployStaticOutput', () => {
  it('uploads every file keyed by its posix-relative path with an inferred content type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>')
    mkdirSync(join(dir, '_nuxt'))
    writeFileSync(join(dir, '_nuxt', 'app.css'), 'body{}')
    const puts: Array<{ key: string; type: string; body: string }> = []
    const driver = { put: async (key: string, bytes: Buffer | Uint8Array, type: string) => { puts.push({ key, type, body: Buffer.from(bytes).toString() }) } }
    const res = await deployStaticOutput(dir, driver)
    rmSync(dir, { recursive: true, force: true })
    expect(res.keys.length).toBe(2)
    expect(puts.find((p) => p.key === 'index.html')).toMatchObject({ type: 'text/html; charset=utf-8', body: '<h1>hi</h1>' })
    expect(puts.find((p) => p.key === '_nuxt/app.css')).toMatchObject({ type: 'text/css; charset=utf-8' })
  })

  it('tags a standalone .gz archive octet-stream, not the MIME type of its stripped base name', async () => {
    // No sibling `catalog.json` in the tree — this is a real archive, not a compressed sidecar, and no
    // Content-Encoding is ever attached for it, so labelling it `application/json` would make a browser
    // try to parse raw gzip bytes as JSON text.
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'catalog.json.gz'), 'gzip-bytes')
    const puts: Array<{ key: string; type: string }> = []
    const driver = { put: async (key: string, _b: Buffer | Uint8Array, type: string) => { puts.push({ key, type }) } }
    await deployStaticOutput(dir, driver)
    rmSync(dir, { recursive: true, force: true })
    expect(puts).toEqual([{ key: 'catalog.json.gz', type: 'application/octet-stream' }])
  })

  it('skips pre-compressed .gz/.br sidecars but keeps a standalone archive with no base file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>')
    writeFileSync(join(dir, 'index.html.gz'), 'gz')
    writeFileSync(join(dir, 'index.html.br'), 'br')
    mkdirSync(join(dir, '_nuxt'))
    writeFileSync(join(dir, '_nuxt', 'app.js'), 'x')
    writeFileSync(join(dir, '_nuxt', 'app.js.br'), 'xbr')
    writeFileSync(join(dir, 'archive.gz'), 'standalone') // no base file → real content, must be kept
    const puts: string[] = []
    const driver = { put: async (k: string) => { puts.push(k) } }
    const res = await deployStaticOutput(dir, driver, { sleep: async () => {} })
    rmSync(dir, { recursive: true, force: true })
    expect(puts.sort()).toEqual(['_nuxt/app.js', 'archive.gz', 'index.html'])
    // skipped sidecars are absent from the keep-set too, so a later prune won't preserve them.
    expect(res.keys.sort()).toEqual(['_nuxt/app.js', 'archive.gz', 'index.html'])
  })

  it('tags each file class with the right Cache-Control on upload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    mkdirSync(join(dir, '_nuxt'))
    writeFileSync(join(dir, '_nuxt', 'app.js'), 'x')
    writeFileSync(join(dir, 'index.html'), 'x')
    writeFileSync(join(dir, 'sitemap.xml'), 'x')
    writeFileSync(join(dir, 'robots.txt'), 'x')
    writeFileSync(join(dir, 'favicon.ico'), 'x')
    const cc: Record<string, string | undefined> = {}
    const driver = { put: async (k: string, _b: Buffer | Uint8Array, _t: string, o?: { cacheControl?: string }) => { cc[k] = o?.cacheControl } }
    await deployStaticOutput(dir, driver, { sleep: async () => {} })
    rmSync(dir, { recursive: true, force: true })
    expect(cc['_nuxt/app.js']).toBe('public, max-age=31536000, immutable')
    expect(cc['index.html']).toBe('public, max-age=0, must-revalidate')
    expect(cc['sitemap.xml']).toBe('public, max-age=0, must-revalidate')
    expect(cc['robots.txt']).toBe('public, max-age=0, must-revalidate')
    expect(cc['favicon.ico']).toBeUndefined()
  })

  it('dryRun walks and reports without uploading', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    const puts: unknown[] = []
    const res = await deployStaticOutput(dir, { put: async (...a: unknown[]) => { puts.push(a) } }, { dryRun: true })
    rmSync(dir, { recursive: true, force: true })
    expect(puts).toHaveLength(0)
    expect(res).toEqual({ pruned: 0, keys: ['a.txt'] })
  })

  it('walks deeply nested directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'deep.js'), 'x')
    const keys: string[] = []
    await deployStaticOutput(dir, { put: async (k: string) => { keys.push(k) } }, { sleep: async () => {} })
    rmSync(dir, { recursive: true, force: true })
    expect(keys).toContain('a/b/deep.js')
  })

  it('retries a transiently failing upload and still succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    let calls = 0
    const driver = { put: async () => { calls++; if (calls < 3) throw new Error('S3 put failed (503)') } }
    const res = await deployStaticOutput(dir, driver, { retries: 3, sleep: async () => {} })
    rmSync(dir, { recursive: true, force: true })
    expect(calls).toBe(3)
    expect(res.keys.length).toBe(1)
  })

  it('throws when a file still fails after exhausting retries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    const driver = { put: async () => { throw new Error('S3 put failed (500)') } }
    await expect(deployStaticOutput(dir, driver, { retries: 2, sleep: async () => {} })).rejects.toThrow(/500/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails fast on a permanent 4xx (bad creds / missing bucket) — no pointless retry loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    let calls = 0
    const driver = { put: async () => { calls++; throw new Error('S3 put failed (403) for a.txt') } }
    await expect(deployStaticOutput(dir, driver, { retries: 5, sleep: async () => {} })).rejects.toThrow(/403/)
    rmSync(dir, { recursive: true, force: true })
    expect(calls).toBe(1) // 403 will never succeed → re-thrown immediately, not retried
  })

  it('still retries a transient 5xx even though it shares the retry path with 4xx', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    let calls = 0
    const driver = { put: async () => { calls++; if (calls < 2) throw new Error('S3 put failed (503)') } }
    const res = await deployStaticOutput(dir, driver, { retries: 5, sleep: async () => {} })
    rmSync(dir, { recursive: true, force: true })
    expect(calls).toBe(2)
    expect(res.keys.length).toBe(1)
  })

  it('uploads with bounded concurrency (parallel but capped)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}.txt`), 'x')
    let inFlight = 0
    let peak = 0
    const driver = { put: async () => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    } }
    const res = await deployStaticOutput(dir, driver, { concurrency: 4 })
    rmSync(dir, { recursive: true, force: true })
    expect(res.keys.length).toBe(20)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
  })
})

describe('deployStaticOutput — reconcile (always-on, no toggle)', () => {
  it('deletes remote objects absent from the new output, keeps the current ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'index.html'), 'x')
    mkdirSync(join(dir, 'about'))
    writeFileSync(join(dir, 'about', 'index.html'), 'x')
    writeFileSync(join(dir, 'a.txt'), 'y')
    const deleted: string[] = []
    const driver = {
      put: async () => {},
      list: async () => ['index.html', 'about/index.html', 'old/gone.html', 'stale.css'],
      delete: async (k: string) => { deleted.push(k) },
    }
    const res = await deployStaticOutput(dir, driver, { sleep: async () => {} })
    rmSync(dir, { recursive: true, force: true })
    expect(deleted.sort()).toEqual(['old/gone.html', 'stale.css'])
    expect(res.pruned).toBe(2)
    expect(res.keys.length).toBe(3)
  })

  it('reconciles by DEFAULT (no opt-in) whenever the driver supports list+delete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    let listed = false
    const deleted: string[] = []
    const driver = { put: async () => {}, list: async () => { listed = true; return ['a.txt', 'stale.css'] }, delete: async (k: string) => { deleted.push(k) } }
    const res = await deployStaticOutput(dir, driver, { sleep: async () => {} })
    rmSync(dir, { recursive: true, force: true })
    expect(listed).toBe(true)
    expect(deleted).toEqual(['stale.css'])
    expect(res.pruned).toBe(1)
  })

  it('dry-run reports what it would delete but deletes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'index.html'), 'x')
    const deleted: string[] = []
    const logs: string[] = []
    const driver = { put: async () => {}, list: async () => ['index.html', 'stale.css'], delete: async (k: string) => { deleted.push(k) } }
    const res = await deployStaticOutput(dir, driver, { dryRun: true, log: (m) => logs.push(m) })
    rmSync(dir, { recursive: true, force: true })
    expect(deleted).toHaveLength(0)
    expect(res.pruned).toBe(0)
    expect(logs.some((l) => /Would prune 1/.test(l))).toBe(true)
  })

  it('skips reconcile gracefully when the driver cannot list/delete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    const res = await deployStaticOutput(dir, { put: async () => {} })
    rmSync(dir, { recursive: true, force: true })
    expect(res.pruned).toBe(0)
  })
})

describe('deployStaticOutput — keep on doubt (an incomplete build must not shrink the site)', () => {
  /** A driver over a fixed remote listing that records every delete. */
  function remote(keys: string[]): { put: () => Promise<void>; list: () => Promise<string[]>; delete: (k: string) => Promise<void>; deleted: string[] } {
    const deleted: string[] = []
    return { put: async () => {}, list: async () => keys, delete: async (k: string) => { deleted.push(k) }, deleted }
  }

  it('uploads but does NOT prune when the caller reports a partial build (routes failed to prerender)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'index.html'), 'x')
    mkdirSync(join(dir, 'about'))
    writeFileSync(join(dir, 'about', 'index.html'), 'x')
    const puts: string[] = []
    const driver = remote(['index.html', 'about/index.html', 'contact/index.html', 'blog/a/index.html'])
    const logs: string[] = []
    const res = await deployStaticOutput(dir, { ...driver, put: async (k: string) => { puts.push(k) } }, {
      incomplete: '2 route(s) failed to prerender',
      log: (m) => logs.push(m),
      sleep: async () => {},
    })
    rmSync(dir, { recursive: true, force: true })
    // The pages that DID render still ship — only the deletes are withheld.
    expect(puts.sort()).toEqual(['about/index.html', 'index.html'])
    expect(driver.deleted).toEqual([])
    expect(res.pruned).toBe(0)
    expect(logs.join('\n')).toMatch(/failed to prerender/)
  })

  it('prunes a deleted page on a ONE-page site — a small site is not a degraded build', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    // A two-page site whose editor just deleted /about: the tree is the root plus nitro's SPA fallbacks,
    // exactly the shape a degraded build has. Only a reported failure may withhold the prune, so this one
    // must go through — otherwise the deleted page is served forever, with no way to force it.
    writeFileSync(join(dir, 'index.html'), 'x')
    writeFileSync(join(dir, '200.html'), 'x')
    writeFileSync(join(dir, '404.html'), 'x')
    const driver = remote(['index.html', '200.html', '404.html', 'about/index.html'])
    const res = await deployStaticOutput(dir, driver, { sleep: async () => {} })
    rmSync(dir, { recursive: true, force: true })
    expect(driver.deleted).toEqual(['about/index.html'])
    expect(res.pruned).toBe(1)
  })

  it('prunes stale ASSETS for a single-page site too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'index.html'), 'x')
    const driver = remote(['index.html', 'stale.css', '_nuxt/old.js'])
    const res = await deployStaticOutput(dir, driver, { sleep: async () => {} })
    rmSync(dir, { recursive: true, force: true })
    expect(driver.deleted.sort()).toEqual(['_nuxt/old.js', 'stale.css'])
    expect(res.pruned).toBe(2)
  })

  it('prunes normally once the build carries more than the root page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'index.html'), 'x')
    mkdirSync(join(dir, 'about'))
    writeFileSync(join(dir, 'about', 'index.html'), 'x')
    const driver = remote(['index.html', 'about/index.html', 'gone/index.html'])
    const res = await deployStaticOutput(dir, driver, { sleep: async () => {} })
    rmSync(dir, { recursive: true, force: true })
    expect(driver.deleted).toEqual(['gone/index.html'])
    expect(res.pruned).toBe(1)
  })

  it('withholds the deletes in a dry-run report too, so the log never promises a prune it would not do', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'index.html'), 'x')
    const driver = remote(['index.html', 'about/index.html'])
    const logs: string[] = []
    await deployStaticOutput(dir, driver, { dryRun: true, incomplete: 'no database at /tmp/db.sqlite', log: (m) => logs.push(m) })
    rmSync(dir, { recursive: true, force: true })
    expect(logs.join('\n')).not.toMatch(/Would prune/)
    expect(logs.join('\n')).toMatch(/skipping reconcile/i)
  })

  it('does not treat a silent build (no report at all) as incomplete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-'))
    writeFileSync(join(dir, 'index.html'), 'x')
    const driver = remote(['index.html', 'about/index.html'])
    const res = await deployStaticOutput(dir, driver, { incomplete: undefined, sleep: async () => {} })
    rmSync(dir, { recursive: true, force: true })
    expect(driver.deleted).toEqual(['about/index.html'])
    expect(res.pruned).toBe(1)
  })
})

describe('route-discovery signal seam', () => {
  it('carries the completeness report on the shared Nuxt instance (the modules share no module scope)', () => {
    const nuxt = {}
    expect(readRouteDiscovery(nuxt)).toBeUndefined()
    recordRouteDiscovery(nuxt, { routes: ['/'], incomplete: 'no database at /tmp/db.sqlite' })
    expect(readRouteDiscovery(nuxt)).toEqual({ routes: ['/'], incomplete: 'no database at /tmp/db.sqlite' })
    recordRouteDiscovery(nuxt, { routes: ['/', '/about'] })
    expect(readRouteDiscovery(nuxt)?.incomplete).toBeUndefined()
  })
})
