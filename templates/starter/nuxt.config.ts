export default defineNuxtConfig({
  compatibilityDate: '2026-06-02',
  future: { compatibilityVersion: 4 },
  // This one line composes the whole CMS. Opt-in extension layers go after it.
  extends: ['@michaelthielemann/kestrel'],
  // Not inherited from an extended layer, so it has to be repeated here.
  typescript: { tsConfig: { compilerOptions: { noUncheckedIndexedAccess: false } } },
  nitro: { typescript: { tsConfig: { compilerOptions: { noUncheckedIndexedAccess: false } } } },
  // Auth/session is env-only, see `.env`. Every key here is optional.
  kestrel: {
    db: '.data/db.sqlite',
    // Baked into canonical URLs, hreflang, sitemap.xml and llms.txt at build time. Set it to the public
    // origin before the first real deploy — or leave it to KESTREL_SITE_URL per environment.
    siteUrl: 'http://localhost:3000',
    siteName: '{{name}}',
    media: { uploadDir: '.data/uploads' },
    // locales: ['en', 'de'],
    // collections: { pages: false },
    // Answer-engine extras, both off until you opt in: articleMeta publishes author/date/keywords,
    // llmsFull serves /llms-full.txt (every published page's full body in one file).
    // seo: { articleMeta: true, llmsFull: true },
  },
})
