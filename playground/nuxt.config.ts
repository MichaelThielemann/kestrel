// Example consumer of Kestrel as a meta-layer. See docs/consuming-kestrel.md.
// In-repo playground extends the parent package by path; an external consumer uses `extends: ['@michaelthielemann/kestrel']`.
export default defineNuxtConfig({
  compatibilityDate: '2026-06-02',
  future: { compatibilityVersion: 4 },
  // ESLint lives on the playground, not the root config: the root ships to consumers via `files` (see
  // package.json's `//publish`), and a published layer must not force its own lint tooling into a
  // consumer's build. The playground composes every layer + both extensions, so linting it from the
  // generated `.nuxt/eslint.config.mjs` covers the whole monorepo's auto-imports in one project-aware pass.
  modules: ['@nuxt/eslint'],
  // Core first (by path), then the opt-in extensions (workspace-linked by package name — an external
  // consumer would `pnpm add` them and use the same names here). Proofing extends the base, so it comes last.
  extends: ['..', '@michaelthielemann/galleries-secure', '@michaelthielemann/galleries-secure-proofing'],
  // `typescript.tsConfig` is NOT inherited from an extended layer, so the engine's `noUncheckedIndexedAccess:
  // false` stance (see the root nuxt.config) must be repeated here for the playground's own typecheck. An
  // external consumer composing `extends: ['@michaelthielemann/kestrel', …]` would do the same in their project.
  typescript: { tsConfig: { compilerOptions: { noUncheckedIndexedAccess: false }, exclude: ['../**/*.test.ts', '../../**/*.test.ts'] } },
  nitro: { typescript: { tsConfig: { compilerOptions: { noUncheckedIndexedAccess: false } } } },
  kestrel: {
    db: '.data/playground.sqlite',
    siteUrl: 'http://localhost:3000',
  },
})
