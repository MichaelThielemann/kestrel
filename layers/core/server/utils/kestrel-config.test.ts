import { describe, it, expect } from 'vitest'
import { resolveKestrel, parseLocaleList, DEFAULT_IMAGE_POLICY, resolveS3Settings, layerKestrelOption } from './kestrel-config'

const root = '/root'

describe('layerKestrelOption — a distributable layer must not merge its dev config into a consumer', () => {
  const cfg = { db: '.data/dev.sqlite', siteUrl: 'http://localhost:3000', locales: ['en', 'de'], primaryLocale: 'en' }

  it('contributes the config when running IN-REPO (not loaded from node_modules)', () => {
    expect(layerKestrelOption(cfg, 'file:///home/me/kestrel/kestrel/nuxt.config.ts')).toBe(cfg)
  })

  it('contributes NOTHING when consumed as a dependency (loaded from node_modules)', () => {
    // Nuxt/c12 concatenates array options like `locales` across layers, so shipping the demo `locales`
    // would come back even when the consumer set their own — contribute {} so the consumer is the sole source.
    expect(layerKestrelOption(cfg, 'file:///home/me/site/node_modules/kestrel/nuxt.config.ts')).toEqual({})
    // pnpm's nested store path also lives under node_modules.
    expect(layerKestrelOption(cfg, 'file:///app/node_modules/.pnpm/kestrel@0.1.0/node_modules/kestrel/nuxt.config.ts')).toEqual({})
  })
})

describe('resolveS3Settings — shared <PREFIX>_* env → config → default resolver', () => {
  it('defaults to empty strings and us-east-1', () => {
    expect(resolveS3Settings(undefined, {}, 'KESTREL_OUTPUT_S3')).toEqual({ bucket: '', region: 'us-east-1', endpoint: '', prefix: '' })
  })
  it('reads the four non-secret fields under the given env prefix, env winning over config', () => {
    expect(resolveS3Settings({ bucket: 'cfg' }, { KESTREL_OUTPUT_S3_BUCKET: 'env' }, 'KESTREL_OUTPUT_S3').bucket).toBe('env')
    expect(resolveS3Settings({ bucket: 'cfg' }, {}, 'KESTREL_OUTPUT_S3').bucket).toBe('cfg') // config used when env absent
    expect(resolveS3Settings({}, { KESTREL_OUTPUT_S3_REGION: 'eu-west-1', KESTREL_OUTPUT_S3_ENDPOINT: 'https://e', KESTREL_OUTPUT_S3_PREFIX: 'p' }, 'KESTREL_OUTPUT_S3'))
      .toEqual({ bucket: '', region: 'eu-west-1', endpoint: 'https://e', prefix: 'p' })
  })
  it('the same helper resolves the media (KESTREL_S3) prefix', () => {
    expect(resolveS3Settings({}, { KESTREL_S3_BUCKET: 'm' }, 'KESTREL_S3').bucket).toBe('m')
  })
})

describe('parseLocaleList', () => {
  it('trims, lowercases, dedupes; falls back when empty', () => {
    expect(parseLocaleList('EN, de , de , fr', ['en'])).toEqual(['en', 'de', 'fr'])
    expect(parseLocaleList(undefined, ['en', 'de'])).toEqual(['en', 'de'])
    expect(parseLocaleList('', ['en', 'de'])).toEqual(['en', 'de'])
    expect(parseLocaleList('  ,  ', ['en'])).toEqual(['en'])
  })
})

describe('resolveKestrel — precedence is KESTREL_* env → config → default (env is the override escape-hatch)', () => {
  it('db: env KESTREL_DB OVERRIDES config; relative resolves against root; :memory: passes through', () => {
    expect(resolveKestrel({ db: '/abs/c.sqlite' }, {}, root).dbPath).toBe('/abs/c.sqlite')
    expect(resolveKestrel({ db: 'rel/c.sqlite' }, {}, root).dbPath).toBe('/root/rel/c.sqlite')
    expect(resolveKestrel({}, { KESTREL_DB: 'env.sqlite' }, root).dbPath).toBe('/root/env.sqlite')
    // env WINS over config — so an isolated test DB / per-env path overrides committed config:
    expect(resolveKestrel({ db: 'config.sqlite' }, { KESTREL_DB: 'env.sqlite' }, root).dbPath).toBe('/root/env.sqlite')
    expect(resolveKestrel({}, {}, root).dbPath).toBe('/root/.data/db.sqlite')
    expect(resolveKestrel({ db: ':memory:' }, {}, root).dbPath).toBe(':memory:')
  })

  it('locales + primaryLocale (env overrides config)', () => {
    expect(resolveKestrel({ locales: ['EN', 'fr'] }, {}, root).supportedLocales).toEqual(['en', 'fr'])
    expect(resolveKestrel({}, { KESTREL_LOCALES: 'en, de' }, root).supportedLocales).toEqual(['en', 'de'])
    expect(resolveKestrel({ locales: ['fr'] }, { KESTREL_LOCALES: 'en,de' }, root).supportedLocales).toEqual(['en', 'de']) // env wins
    expect(resolveKestrel({}, {}, root).supportedLocales).toEqual(['en', 'de'])
    expect(resolveKestrel({ locales: ['en', 'de'], primaryLocale: 'de' }, {}, root).primaryLocale).toBe('de')
    expect(resolveKestrel({ locales: ['en', 'de'], primaryLocale: 'de' }, { KESTREL_PRIMARY_LOCALE: 'en' }, root).primaryLocale).toBe('en') // env wins
    // a primary not in the set falls back to the first locale
    expect(resolveKestrel({ locales: ['fr'] }, { KESTREL_PRIMARY_LOCALE: 'en' }, root).primaryLocale).toBe('fr')
  })

  it('prefixPrimary: KESTREL_PREFIX_PRIMARY_LOCALE → config → default false (env boolean wins)', () => {
    expect(resolveKestrel({}, {}, root).prefixPrimary).toBe(false)
    expect(resolveKestrel({ prefixPrimaryLocale: true }, {}, root).prefixPrimary).toBe(true)
    expect(resolveKestrel({}, { KESTREL_PREFIX_PRIMARY_LOCALE: '1' }, root).prefixPrimary).toBe(true)
    expect(resolveKestrel({ prefixPrimaryLocale: true }, { KESTREL_PREFIX_PRIMARY_LOCALE: 'false' }, root).prefixPrimary).toBe(false) // env wins
    // a garbage env value falls through to the config boolean
    expect(resolveKestrel({ prefixPrimaryLocale: true }, { KESTREL_PREFIX_PRIMARY_LOCALE: 'nope' }, root).prefixPrimary).toBe(true)
  })

  it('siteUrl (raw, not normalised): env → config → empty', () => {
    expect(resolveKestrel({ siteUrl: 'https://a.io' }, {}, root).siteUrl).toBe('https://a.io')
    expect(resolveKestrel({}, { KESTREL_SITE_URL: 'https://b.io' }, root).siteUrl).toBe('https://b.io')
    expect(resolveKestrel({ siteUrl: 'https://cfg.io' }, { KESTREL_SITE_URL: 'https://env.io' }, root).siteUrl).toBe('https://env.io') // env wins
    expect(resolveKestrel({}, {}, root).siteUrl).toBe('')
  })

  it('siteName / siteDescription (for llms.txt): env → config → empty', () => {
    expect(resolveKestrel({ siteName: 'Acme', siteDescription: 'Hi' }, {}, root).siteName).toBe('Acme')
    expect(resolveKestrel({}, { KESTREL_SITE_NAME: 'EnvCo' }, root).siteName).toBe('EnvCo')
    expect(resolveKestrel({ siteName: 'Cfg' }, { KESTREL_SITE_NAME: 'Env' }, root).siteName).toBe('Env') // env wins
    expect(resolveKestrel({}, {}, root).siteName).toBe('')
    expect(resolveKestrel({ siteDescription: 'd' }, {}, root).siteDescription).toBe('d')
    expect(resolveKestrel({}, {}, root).siteDescription).toBe('')
  })

  it('collections (built-in toggles): default on; config off; KESTREL_COLLECTIONS_* env wins', () => {
    expect(resolveKestrel({}, {}, root).collections).toEqual({ pages: true, media: true })
    expect(resolveKestrel({ collections: { pages: false } }, {}, root).collections).toEqual({ pages: false, media: true })
    expect(resolveKestrel({ collections: { media: false } }, {}, root).collections.media).toBe(false)
    expect(resolveKestrel({}, { KESTREL_COLLECTIONS_PAGES: 'false' }, root).collections.pages).toBe(false)
    // env is the override escape-hatch, both directions
    expect(resolveKestrel({ collections: { pages: false } }, { KESTREL_COLLECTIONS_PAGES: 'true' }, root).collections.pages).toBe(true)
    expect(resolveKestrel({ collections: { media: true } }, { KESTREL_COLLECTIONS_MEDIA: '0' }, root).collections.media).toBe(false)
  })

  it('preview.desktopWidth: default 1440; config override; KESTREL_PREVIEW_DESKTOP_WIDTH env wins; garbage/≤0 falls through', () => {
    expect(resolveKestrel({}, {}, root).preview).toEqual({ desktopWidth: 1440 })
    expect(resolveKestrel({ preview: { desktopWidth: 1280 } }, {}, root).preview.desktopWidth).toBe(1280)
    expect(resolveKestrel({}, { KESTREL_PREVIEW_DESKTOP_WIDTH: '1600' }, root).preview.desktopWidth).toBe(1600)
    // env is the override escape-hatch — wins over config
    expect(resolveKestrel({ preview: { desktopWidth: 1280 } }, { KESTREL_PREVIEW_DESKTOP_WIDTH: '1600' }, root).preview.desktopWidth).toBe(1600)
    // a garbage or non-positive env value falls through to config, then the default; a fraction floors
    expect(resolveKestrel({ preview: { desktopWidth: 1280 } }, { KESTREL_PREVIEW_DESKTOP_WIDTH: 'nope' }, root).preview.desktopWidth).toBe(1280)
    expect(resolveKestrel({}, { KESTREL_PREVIEW_DESKTOP_WIDTH: '0' }, root).preview.desktopWidth).toBe(1440)
    expect(resolveKestrel({ preview: { desktopWidth: -5 } }, {}, root).preview.desktopWidth).toBe(1440)
    expect(resolveKestrel({ preview: { desktopWidth: 1440.9 } }, {}, root).preview.desktopWidth).toBe(1440)
  })

  const defaultS3 = { bucket: '', region: 'us-east-1', endpoint: '', prefix: '', publicBaseUrl: '' }

  it('media: dir resolves against root; numbers/strings with sane defaults', () => {
    const c = resolveKestrel({ media: { uploadDir: 'up', driver: 's3', maxBytes: 5, allowedMimes: 'image/png', baseUrl: '/m' } }, {}, root).media
    expect(c).toEqual({ dir: '/root/up', baseUrl: '/m', driver: 's3', maxUploadBytes: 5, allowedMimes: 'image/png', s3: defaultS3, imagePolicy: DEFAULT_IMAGE_POLICY })
    const e = resolveKestrel({}, { KESTREL_MEDIA_LOCAL_DIR: '.data/uploads', KESTREL_MEDIA_MAX_BYTES: '99', KESTREL_MEDIA_DRIVER: 's3' }, root).media
    expect(e.dir).toBe('/root/.data/uploads'); expect(e.maxUploadBytes).toBe(99); expect(e.driver).toBe('s3'); expect(e.baseUrl).toBe('/uploads')
    const d = resolveKestrel({}, {}, root).media
    expect(d).toEqual({ dir: '/root/.data/uploads', baseUrl: '/uploads', driver: 'local', maxUploadBytes: 26214400, allowedMimes: '', s3: defaultS3, imagePolicy: DEFAULT_IMAGE_POLICY })
    // env wins over config (the e2e media-isolation case: KESTREL_MEDIA_LOCAL_DIR overrides config.uploadDir)
    expect(resolveKestrel({ media: { uploadDir: 'cfg-up', maxBytes: 5 } }, { KESTREL_MEDIA_LOCAL_DIR: 'env-up', KESTREL_MEDIA_MAX_BYTES: '99' }, root).media)
      .toMatchObject({ dir: '/root/env-up', maxUploadBytes: 99 })
    // a garbage env byte count falls back to the config value, then the default
    expect(resolveKestrel({}, { KESTREL_MEDIA_MAX_BYTES: 'nope' }, root).media.maxUploadBytes).toBe(26214400)
    expect(resolveKestrel({ media: { maxBytes: 7 } }, { KESTREL_MEDIA_MAX_BYTES: 'nope' }, root).media.maxUploadBytes).toBe(7)
  })

  it('output (static-publish target): dir/publicDir/driver/auto/reconcile with KESTREL_OUTPUT_* → config → default', () => {
    const outS3 = { bucket: '', region: 'us-east-1', endpoint: '', prefix: '' }
    // defaults
    expect(resolveKestrel({}, {}, root).output).toEqual({
      driver: 'local', dir: '/root/.data/published', publicDir: '/root/.output/public',
      auto: true, reconcileMinutes: 0, verbose: false, s3: outS3,
    })
    // config wins; relative dirs resolve against root
    expect(resolveKestrel({ output: { driver: 's3', dir: 'dist/site', publicDir: 'build/pub', auto: false, reconcileMinutes: 15, verbose: true, s3: { bucket: 'b', prefix: 'p' } } }, {}, root).output)
      .toEqual({ driver: 's3', dir: '/root/dist/site', publicDir: '/root/build/pub', auto: false, reconcileMinutes: 15, verbose: true, s3: { bucket: 'b', region: 'us-east-1', endpoint: '', prefix: 'p' } })
    // env fills when config absent
    const e = resolveKestrel({}, { KESTREL_OUTPUT_DRIVER: 's3', KESTREL_OUTPUT_DIR: 'out', KESTREL_OUTPUT_AUTO: 'false', KESTREL_OUTPUT_RECONCILE_MINUTES: '30', KESTREL_OUTPUT_S3_BUCKET: 'eb' }, root).output
    expect(e.driver).toBe('s3'); expect(e.dir).toBe('/root/out'); expect(e.auto).toBe(false); expect(e.reconcileMinutes).toBe(30); expect(e.s3.bucket).toBe('eb')
    // auto defaults true; garbage reconcile → 0 (off)
    expect(resolveKestrel({}, { KESTREL_OUTPUT_AUTO: 'true' }, root).output.auto).toBe(true)
    expect(resolveKestrel({}, { KESTREL_OUTPUT_RECONCILE_MINUTES: 'nope' }, root).output.reconcileMinutes).toBe(0)
    // an env var present but BLANK (`KESTREL_OUTPUT_RECONCILE_MINUTES=` with no value) must fall through to
    // config, like every other resolver — not coerce to 0 and silently disable a configured reconciler.
    expect(resolveKestrel({ output: { reconcileMinutes: 30 } }, { KESTREL_OUTPUT_RECONCILE_MINUTES: '' }, root).output.reconcileMinutes).toBe(30)
    // an explicit `=0` still disables it.
    expect(resolveKestrel({ output: { reconcileMinutes: 30 } }, { KESTREL_OUTPUT_RECONCILE_MINUTES: '0' }, root).output.reconcileMinutes).toBe(0)
    // verbose: default off; env wins over config
    expect(resolveKestrel({}, {}, root).output.verbose).toBe(false)
    expect(resolveKestrel({}, { KESTREL_OUTPUT_VERBOSE: 'true' }, root).output.verbose).toBe(true)
    expect(resolveKestrel({ output: { verbose: false } }, { KESTREL_OUTPUT_VERBOSE: 'true' }, root).output.verbose).toBe(true)
    expect(resolveKestrel({ output: { verbose: true } }, {}, root).output.verbose).toBe(true) // config used when env absent
  })

  it('media.driver: normalises case and rejects unknown drivers (fail-loud, not silent 404s)', () => {
    // case-insensitive accept, config + env (a typo like "S3"/"Local" must not silently fall through to local)
    expect(resolveKestrel({ media: { driver: 'S3' as 's3' } }, {}, root).media.driver).toBe('s3')
    expect(resolveKestrel({}, { KESTREL_MEDIA_DRIVER: 'Local' }, root).media.driver).toBe('local')
    expect(resolveKestrel({}, { KESTREL_MEDIA_DRIVER: 'S3' }, root).media.driver).toBe('s3')
    // default when unset
    expect(resolveKestrel({}, {}, root).media.driver).toBe('local')
    // an unknown driver throws up-front rather than writing to disk that is never served
    expect(() => resolveKestrel({}, { KESTREL_MEDIA_DRIVER: 'gcs' }, root)).toThrow(/media driver/i)
  })

  it('media.s3: non-secret block follows KESTREL_S3_* → config → default; secrets stay out', () => {
    const cfg = resolveKestrel(
      { media: { driver: 's3', s3: { bucket: 'cfg-bucket', region: 'eu-central-1', endpoint: 'https://cfg.example.com', prefix: 'assets', publicBaseUrl: 'https://cdn.cfg' } } },
      {}, root,
    ).media.s3
    expect(cfg).toEqual({ bucket: 'cfg-bucket', region: 'eu-central-1', endpoint: 'https://cfg.example.com', prefix: 'assets', publicBaseUrl: 'https://cdn.cfg' })

    // env fallback when the config value is absent
    const env = resolveKestrel({}, {
      KESTREL_S3_BUCKET: 'env-bucket', KESTREL_S3_REGION: 'us-west-2', KESTREL_S3_ENDPOINT: 'https://env.example.com',
      KESTREL_S3_PREFIX: 'media', KESTREL_S3_PUBLIC_BASE_URL: 'https://cdn.env',
    }, root).media.s3
    expect(env).toEqual({ bucket: 'env-bucket', region: 'us-west-2', endpoint: 'https://env.example.com', prefix: 'media', publicBaseUrl: 'https://cdn.env' })

    // env wins over config, per setting
    expect(resolveKestrel({ media: { s3: { bucket: 'cfg' } } }, { KESTREL_S3_BUCKET: 'env' }, root).media.s3.bucket).toBe('env')
    expect(resolveKestrel({ media: { s3: { bucket: 'cfg' } } }, {}, root).media.s3.bucket).toBe('cfg') // config used when env absent

    // defaults: empty strings, region us-east-1
    expect(resolveKestrel({}, {}, root).media.s3).toEqual(defaultS3)

    // secrets are NEVER part of the resolved config (env-only, read at module setup)
    const r = resolveKestrel({}, { KESTREL_S3_ACCESS_KEY_ID: 'AKIA', KESTREL_S3_SECRET_ACCESS_KEY: 'secret' }, root).media.s3
    expect(r).not.toHaveProperty('accessKeyId')
    expect(r).not.toHaveProperty('secretAccessKey')
    expect(r).toEqual(defaultS3)
  })

  it('imagePolicy: default when unset (config → KESTREL_MEDIA_IMAGE_* env → DEFAULT_IMAGE_POLICY)', () => {
    expect(DEFAULT_IMAGE_POLICY).toEqual({
      widths: [320, 640, 960, 1280, 1920],
      webpQuality: 78,
      jpegQuality: 80,
      variants: [320, 640, 960, 1280, 1920].map((w) => ({ name: `w${w}`, width: w, height: null, fit: 'cover', position: 'centre', formats: ['webp'] })),
      presets: [],
    })
    expect(resolveKestrel({}, {}, root).media.imagePolicy).toEqual(DEFAULT_IMAGE_POLICY)
  })

  it('imagePolicy: config overrides — widths sorted+deduped+floored, quality', () => {
    const p = resolveKestrel({ media: { image: { widths: [640, 320, 320, 640.7], webpQuality: 90 } } }, {}, root).media.imagePolicy
    expect(p).toMatchObject({ widths: [320, 640], webpQuality: 90 })
  })

  it('imagePolicy: env fallback when config absent (garbage/negatives dropped)', () => {
    const p = resolveKestrel(
      {},
      { KESTREL_MEDIA_IMAGE_WIDTHS: '200, 100, 100, junk, -5', KESTREL_MEDIA_IMAGE_WEBP_QUALITY: '60' },
      root,
    ).media.imagePolicy
    expect(p).toMatchObject({ widths: [100, 200], webpQuality: 60 })
  })

  it('imagePolicy: env beats config per-field (env webpQuality wins; a field unset in env falls through to config)', () => {
    const p = resolveKestrel(
      { media: { image: { widths: [222], webpQuality: 60 } } },
      { KESTREL_MEDIA_IMAGE_WEBP_QUALITY: '90' },
      root,
    ).media.imagePolicy
    expect(p).toMatchObject({ widths: [222], webpQuality: 90 }) // quality from env (wins), widths from config (env unset)
  })

  it('imagePolicy: invalid values fall back to the default level', () => {
    const p = resolveKestrel({ media: { image: { widths: [], webpQuality: 999 } } }, {}, root).media.imagePolicy
    expect(p).toEqual(DEFAULT_IMAGE_POLICY)
    expect(resolveKestrel({}, { KESTREL_MEDIA_IMAGE_WEBP_QUALITY: '0', KESTREL_MEDIA_IMAGE_WIDTHS: '  ,  ' }, root).media.imagePolicy)
      .toEqual(DEFAULT_IMAGE_POLICY)
  })

  it('imagePolicy: sub-1 fractional widths are dropped (never a 0 width that would break sharp)', () => {
    // a lone fractional width sanitises to empty → falls through to the default ladder
    expect(resolveKestrel({ media: { image: { widths: [0.5] } } }, {}, root).media.imagePolicy.widths)
      .toEqual(DEFAULT_IMAGE_POLICY.widths)
    // mixed with a valid width, only the valid one survives (no 0 leaks through)
    expect(resolveKestrel({ media: { image: { widths: [0.9, 640] } } }, {}, root).media.imagePolicy.widths)
      .toEqual([640])
    expect(resolveKestrel({}, { KESTREL_MEDIA_IMAGE_WIDTHS: '0.5, 640' }, root).media.imagePolicy.widths)
      .toEqual([640])
  })

  it('imagePolicy: webpQuality rounds and accepts the inclusive [1,100] bounds', () => {
    expect(resolveKestrel({ media: { image: { webpQuality: 78.6 } } }, {}, root).media.imagePolicy.webpQuality).toBe(79)
    expect(resolveKestrel({}, { KESTREL_MEDIA_IMAGE_WEBP_QUALITY: '79.4' }, root).media.imagePolicy.webpQuality).toBe(79)
    expect(resolveKestrel({ media: { image: { webpQuality: 100 } } }, {}, root).media.imagePolicy.webpQuality).toBe(100)
    expect(resolveKestrel({ media: { image: { webpQuality: 1 } } }, {}, root).media.imagePolicy.webpQuality).toBe(1)
  })

  it('imagePolicy.jpegQuality: default 80; config/env override; env wins; [1,100]-or-fallback', () => {
    expect(resolveKestrel({}, {}, root).media.imagePolicy.jpegQuality).toBe(80)
    expect(resolveKestrel({ media: { image: { jpegQuality: 65 } } }, {}, root).media.imagePolicy.jpegQuality).toBe(65)
    expect(resolveKestrel({}, { KESTREL_MEDIA_IMAGE_JPEG_QUALITY: '70' }, root).media.imagePolicy.jpegQuality).toBe(70)
    expect(resolveKestrel({ media: { image: { jpegQuality: 65 } } }, { KESTREL_MEDIA_IMAGE_JPEG_QUALITY: '70' }, root).media.imagePolicy.jpegQuality).toBe(70)
    expect(resolveKestrel({ media: { image: { jpegQuality: 999 } } }, {}, root).media.imagePolicy.jpegQuality).toBe(80)
  })

  it('imagePolicy.variants: legacy widths desugar to w<width> proportional webp presets', () => {
    const v = resolveKestrel({ media: { image: { widths: [320, 640] } } }, {}, root).media.imagePolicy.variants
    expect(v).toEqual([
      { name: 'w320', width: 320, height: null, fit: 'cover', position: 'centre', formats: ['webp'] },
      { name: 'w640', width: 640, height: null, fit: 'cover', position: 'centre', formats: ['webp'] },
    ])
  })

  it('imagePolicy.variants: named config presets (crop + multi-format) union the legacy widths; named wins a name collision', () => {
    const v = resolveKestrel({ media: { image: {
      widths: [320],
      variants: [
        { name: 'thumb', width: 320, height: 320, fit: 'cover', formats: ['webp', 'jpeg'] },
        { name: 'w320', width: 999, formats: ['jpeg'] }, // collides with the desugared w320 → named wins
      ],
    } } }, {}, root).media.imagePolicy.variants
    expect(v).toEqual([
      { name: 'thumb', width: 320, height: 320, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] },
      { name: 'w320', width: 999, height: null, fit: 'cover', position: 'centre', formats: ['jpeg'] },
    ])
  })

  it('imagePolicy.variants: sanitises names, drops invalid specs, defaults fit/position/formats, dedupes formats', () => {
    const named = resolveKestrel({ media: { image: {
      widths: [],
      variants: [
        { name: 'My Thumb!', width: 100, formats: ['webp', 'webp', 'png' as 'webp'] }, // name sanitised, png dropped, deduped
        { name: '', width: 50 }, // no name → dropped
        { name: 'zero', width: 0 }, // width < 1 → dropped
        { name: 'box', width: 200, height: 200, fit: 'nope' as 'cover' }, // bad fit → cover
      ],
    } } }, {}, root).media.imagePolicy.variants.filter((x) => !/^w\d+$/.test(x.name))
    expect(named).toEqual([
      { name: 'My-Thumb', width: 100, height: null, fit: 'cover', position: 'centre', formats: ['webp'] },
      { name: 'box', width: 200, height: 200, fit: 'cover', position: 'centre', formats: ['webp'] },
    ])
  })

  it('imagePolicy.presets: only the config-authored named variants (never the desugared width ladder)', () => {
    const p = resolveKestrel({ media: { image: {
      widths: [320, 640],
      variants: [{ name: 'thumb', width: 320, height: 320, formats: ['webp', 'jpeg'] }],
    } } }, {}, root).media.imagePolicy
    // presets carries ONLY the explicit named variant — the w320/w640 ladder is fallback-only, not a preset
    expect(p.presets).toEqual([{ name: 'thumb', width: 320, height: 320, fit: 'cover', position: 'centre', formats: ['webp', 'jpeg'] }])
    // …but it is still part of the full `variants` union
    expect(p.variants.some((v) => v.name === 'thumb')).toBe(true)
    expect(resolveKestrel({}, {}, root).media.imagePolicy.presets).toEqual([]) // none configured → empty
  })
})
