import { readFileSync } from 'node:fs'
import { defineNuxtModule } from '@nuxt/kit'
import { resolveKestrel, type KestrelConfig } from '../../server/utils/kestrel-config'
import { diagnoseAppShell } from './app-shell'

/**
 * The `kestrel` config namespace (`kestrel: { … }` in nuxt.config, sourced from `kestrel.config.ts`).
 * Lives in `core` so it runs before the `media`/`public` layer modules and populates runtimeConfig
 * first. It bridges the resolved config to what the CLIENT + Nitro need: `runtimeConfig.media.*`,
 * `runtimeConfig.public.{locales,primaryLocale}`, and the `/uploads` static serving. Server runtime
 * utils (db/locale/site-url) read the same resolved values directly via `server/utils/kestrel-config.ts`.
 */
export default defineNuxtModule<KestrelConfig>({
  meta: { name: 'kestrel', configKey: 'kestrel' },
  setup(options, nuxt) {
    const c = resolveKestrel(options, process.env, nuxt.options.rootDir)

    // `app:resolve` is the first hook where `mainComponent` is settled across all layers. In dev it fires
    // on every watched change, so an unfixed problem would repaint the whole message on each keystroke.
    const reported = new Set<string>()
    nuxt.hook('app:resolve', (app) => {
      for (const d of diagnoseAppShell({
        mainComponent: app.mainComponent,
        pagesEnabled: nuxt.options.pages !== false,
        read: (file) => readFileSync(file, 'utf8'),
      })) {
        if (reported.has(d.message)) continue
        reported.add(d.message)
        console[d.level === 'error' ? 'error' : 'warn'](`[kestrel] ${d.message}`)
      }
    })

    const rc = nuxt.options.runtimeConfig
    rc.media = {
      driver: c.media.driver,
      maxUploadBytes: c.media.maxUploadBytes,
      allowedMimes: c.media.allowedMimes,
      imagePolicy: c.media.imagePolicy,
      local: { dir: c.media.dir, baseUrl: c.media.baseUrl },
      // Non-secret S3 settings come from the resolved config; the credentials are env-only (never
      // committed) and merged in here so the server driver gets everything from runtimeConfig.
      s3: {
        ...c.media.s3,
        accessKeyId: process.env.KESTREL_S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.KESTREL_S3_SECRET_ACCESS_KEY ?? '',
        sessionToken: process.env.KESTREL_S3_SESSION_TOKEN ?? '',
      },
    }
    const pub = (rc.public ??= {} as never) as Record<string, unknown>
    pub.locales = c.supportedLocales
    pub.primaryLocale = c.primaryLocale
    pub.prefixPrimary = c.prefixPrimary
    // The public head (canonical/og:url/hreflang) needs the absolute origin CLIENT-side too (SPA navs
    // update the head after hydration). Not a secret — it is the site's own public address.
    pub.siteUrl = c.siteUrl ?? ''
    pub.siteName = c.siteName ?? ''
    // Reference desktop width (px) for the admin page-builder preset; the editor's scale-to-fit shrinks it.
    pub.previewDesktopWidth = c.preview.desktopWidth
    // Whether the admin shows the EU AI Act disclosure controls on a media asset; the data itself is
    // always resolved server-side, so flipping this off only hides the editor.
    pub.aiDisclosureEnabled = c.aiDisclosure.enabled
    // Article metadata is an APP-side concern on both ends — the admin SEO panel decides whether to offer
    // the fields, the public page decides whether to publish them as JSON-LD — so the flag has to be
    // client-visible. It gates a disclosure, not a secret.
    pub.seoArticleMeta = c.seo.articleMeta

    // Server-only resolved settings, so server utils read the CONSUMER's `kestrel: {}` (via this module)
    // rather than importing Kestrel's own `kestrel.config.ts` file. Essential when Kestrel is consumed as
    // a layer: the package's config file is empty, the real config lives in the consumer's nuxt.config.
    const srv = (rc.kestrel ??= {} as never) as Record<string, unknown>
    srv.dbPath = c.dbPath
    srv.siteUrl = c.siteUrl
    srv.siteName = c.siteName
    srv.siteDescription = c.siteDescription
    // Built-in collection toggles (pages/media) — read by the register plugin to gate built-ins.
    srv.collections = c.collections
    // Read by the upload route to decide whether to run the AI-signal scan at all.
    srv.aiDisclosure = c.aiDisclosure
    // Answer-engine toggles; `llmsFull` is server-only (it gates a Nitro route and what the publisher writes).
    srv.seo = c.seo
    // Static-publish target for the runtime publisher (server-only). S3 creds are env-only; prefer the
    // output-specific creds, fall back to the shared media creds so a single S3 account "just works".
    srv.output = {
      driver: c.output.driver,
      dir: c.output.dir,
      publicDir: c.output.publicDir,
      auto: c.output.auto,
      publishOnSave: c.output.publishOnSave,
      reconcileMinutes: c.output.reconcileMinutes,
      verbose: c.output.verbose,
      s3: {
        ...c.output.s3,
        accessKeyId: process.env.KESTREL_OUTPUT_S3_ACCESS_KEY_ID ?? process.env.KESTREL_S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.KESTREL_OUTPUT_S3_SECRET_ACCESS_KEY ?? process.env.KESTREL_S3_SECRET_ACCESS_KEY ?? '',
        sessionToken: process.env.KESTREL_OUTPUT_S3_SESSION_TOKEN ?? process.env.KESTREL_S3_SESSION_TOKEN ?? '',
      },
    }

    nuxt.options.nitro ??= {}
    // Only the local driver serves uploads off disk from the app origin (dev + baked into `nuxt
    // generate`). On S3 the bucket/CDN serves them, so we must not register a publicAssets entry for
    // a directory that isn't the store (it would 404 or shadow real keys).
    if (c.media.driver === 'local') {
      nuxt.options.nitro.publicAssets = [
        ...(nuxt.options.nitro.publicAssets ?? []),
        { baseURL: c.media.baseUrl, dir: c.media.dir, maxAge: 0 },
      ]
      // Uploads are served from the app origin; never let the browser content-sniff past the declared type.
      nuxt.options.nitro.routeRules = {
        ...(nuxt.options.nitro.routeRules ?? {}),
        [`${c.media.baseUrl}/**`]: { headers: { 'X-Content-Type-Options': 'nosniff' } },
      }
    }
  },
})
