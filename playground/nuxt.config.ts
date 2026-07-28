// Example consumer of Kestrel as a meta-layer. See docs/consuming-kestrel.md.
// In-repo playground extends the parent package by path; an external consumer uses `extends: ['@thielemann/kestrel']`.
export default defineNuxtConfig({
  compatibilityDate: '2026-06-02',
  future: { compatibilityVersion: 4 },
  // Core first (by path), then the opt-in extensions (workspace-linked by package name — an external
  // consumer would `pnpm add` them and use the same names here). Proofing extends the base, so it comes last.
  extends: ['..', '@thielemann/kestrel-galleries-secure', '@thielemann/kestrel-galleries-secure-proofing'],
  // `typescript.tsConfig` is NOT inherited from an extended layer, so the engine's `noUncheckedIndexedAccess:
  // false` stance (see the root nuxt.config) must be repeated here for the playground's own typecheck. An
  // external consumer composing `extends: ['@thielemann/kestrel', …]` would do the same in their project.
  typescript: { tsConfig: { compilerOptions: { noUncheckedIndexedAccess: false }, exclude: ['../**/*.test.ts', '../../**/*.test.ts'] } },
  nitro: { typescript: { tsConfig: { compilerOptions: { noUncheckedIndexedAccess: false } } } },
  kestrel: {
    db: '.data/playground.sqlite',
    siteUrl: 'http://localhost:3000',
  },
})
