import kestrel from './kestrel.config'
import { layerKestrelOption } from './layers/core/server/utils/kestrel-config'

// Silence known-harmless, un-actionable THIRD-PARTY build noise (output unaffected — applied to both the
// Vite client and the Nitro server Rollup passes). Everything else still surfaces — crucially, any
// circular dependency that touches OUR `layers/` code is NOT dropped, so a real cycle we introduce stays
// visible. Anything in our own code is fixed, not silenced.
//  - `#__PURE__`: @vueuse/core (pulled in via reka-ui) ships a `/* #__PURE__ */` annotation in a position
//    Rollup can't interpret; it just drops the comment.
//  - `module-preload-polyfill`: Nuxt's own preload-polyfill transform emits no sourcemap (cosmetic).
//  - Circular dependencies entirely inside dependencies (nitropack's runtime internals: app.mjs ↔
//    cache.mjs / utils.mjs, etc.) — upstream code we don't author and can't fix.
const SILENCED_BUILD_WARNINGS = ['#__PURE__', 'module-preload-polyfill']
// Typed inline — Rollup's `WarningHandlerWithDefault` isn't importable here (rollup is a transitive, not a
// direct, dep). `{ message?: string }` reads the bit we filter on; `defaultHandler` is structurally the
// rollup default handler (cast to call it with our wider warning shape).
const onwarn = (warning: { message?: string }, defaultHandler: (warning: never) => void) => {
  const msg = warning.message ?? ''
  if (SILENCED_BUILD_WARNINGS.some((s) => msg.includes(s))) return
  // Third-party-internal cycles only (no `layers/` segment ⇒ none of our code is in the loop).
  if (msg.includes('Circular dependency') && !msg.includes('layers/')) return
  ;(defaultHandler as (w: unknown) => void)(warning)
}

export default defineNuxtConfig({
  compatibilityDate: '2026-06-02',
  future: { compatibilityVersion: 4 },
  // `noUncheckedIndexedAccess` is a Nuxt tsconfig DEFAULT the project never opted into; the engine's code
  // (runtime collection-derived tables → `Record<string, Column>` lookups, pervasive index access) was not
  // written for it, so leaving it on would mean ~100 `!`-assertions that mostly HIDE undefined rather than
  // catch it. Off → the `typecheck` gate is meaningful (real type errors surface) without that noise; it
  // also keeps a consumer's own `nuxt typecheck` from drowning in errors against the shipped engine code.
  // It must be set in BOTH places: `typescript.tsConfig` covers the app/shared/node tsconfigs, and
  // `nitro.typescript.tsConfig` covers the separately-generated server (Nitro) tsconfig.
  // Exclude tests from the typecheck (vitest covers them at runtime). The generated config's `include` uses
  // parent-traversing paths (`../layers/…`), so the exclude globs must too — a bare `**/*.test.ts` won't match.
  typescript: { tsConfig: { compilerOptions: { noUncheckedIndexedAccess: false }, exclude: ['../**/*.test.ts', '../../**/*.test.ts'] } },
  // Explicit sub-layer composition so Kestrel works as an installable meta-layer (`extends: ['@thielemann/kestrel']`):
  // Nuxt does NOT transitively auto-scan an extended package's `layers/` dir, but it DOES follow its
  // `extends` chain — so for a consumer this list is the ONLY thing that drives sub-layer order (core first).
  // In-repo it is effectively inert: Nuxt also auto-scans the local `layers/` dir (resolved before the
  // explicit `extends` and deduped by rootDir), and that auto-scan order is reverse-alphabetical — i.e.
  // in-repo precedence is ui > public > media > fields > core > collections > auth > admin > access, NOT this order.
  // The two contexts therefore differ; keep cross-layer basenames unique so the winner can't diverge.
  extends: [
    './layers/core',
    './layers/fields',
    './layers/ui',
    './layers/media',
    './layers/auth',
    './layers/access',
    './layers/collections',
    './layers/admin',
    './layers/public',
  ],
  // Prune `node_modules` (and the sibling `playground` app) from Nuxt's dev file-watcher. Nuxt's default
  // `ignore` list does NOT include node_modules; when `@parcel/watcher` is unavailable Nuxt falls back to
  // the granular chokidar watcher, whose recursively-spawned sub-watchers only apply `isIgnored` (not the
  // `/node_modules/` guard the top watcher uses). Under chokidar 5 that walks the pnpm symlink farm in
  // `node_modules/.pnpm` — including the `playground/node_modules/kestrel -> ..` cycle — unbounded, which
  // pegs the event loop and OOMs `nuxt dev` a few minutes after boot. Ignoring node_modules here prunes it
  // in every watcher mode (and benefits downstream consumers of this meta-layer, who'd hit the same bug).
  // `/playground` is ANCHORED (leading slash) to this repo's own dev playground at the root — an unanchored
  // `playground` is a gitignore-style any-depth match that would also exclude a downstream consumer's
  // directory named `playground` from scanning. (`**/node_modules` independently prunes the OOM-causing farm.)
  ignore: ['**/node_modules', '/playground'],
  // `experimental.tasks` enables the `db:migrate` Nitro task — the explicit prod schema step (ADR-0002).
  nitro: { externals: { external: ['better-sqlite3', 'sharp'] }, experimental: { tasks: true }, rollupConfig: { onwarn }, typescript: { tsConfig: { compilerOptions: { noUncheckedIndexedAccess: false } } } },
  // Inline each prerendered page's critical CSS instead of a render-blocking <link> (the global CSS is
  // small, so per-page inlining is cheap and removes a round-trip before first paint). SPA admin is
  // ssr:false so it is unaffected. Explicit so the behaviour can't drift with a future Nuxt default.
  features: { inlineStyles: true },
  // NOTE: public pages ship the normal hydration runtime (`_nuxt`) — consumer projects build their own
  // interactive Vue components, so a zero-JS (`noScripts`) default would break them. The runtime publisher
  // depends on this too: `localFetch` only emits the `_nuxt` scripts + inline payload when noScripts is off.
  // Single non-auth config source; the `kestrel` module (core layer) resolves it (config → KESTREL_* env
  // → default) into runtimeConfig.media / runtimeConfig.public.locales + the /uploads static serving.
  // `layerKestrelOption` contributes this file's values ONLY in-repo — when Kestrel is consumed as a
  // dependency it yields `{}`, so Nuxt's array-concatenating layer merge can't leak the demo `locales`
  // into a consumer (the consumer's own `kestrel: {}` is then the sole source).
  kestrel: layerKestrelOption(kestrel, import.meta.url),
  // Pre-bundle these so the dev server doesn't discover them at runtime and force a full reload.
  vite: {
    build: { rollupOptions: { onwarn } },
    optimizeDeps: {
      // Nested "kestrel > dep" form: Vite resolves each dep from the `kestrel` PACKAGE's directory
      // rather than the (consumer) project root. Under pnpm these are kestrel's transitive deps and
      // are NOT hoisted into a consumer's top-level node_modules, so a bare specifier is
      // "Unresolvable" from the consumer root. In-repo `kestrel` is not a resolvable package name, so
      // Vite's nestedResolveBasedir falls back to the repo root where these deps ARE hoisted — same
      // result. The runtime `import('@tiptap/...')` still reuses the pre-bundle (tryOptimizedResolve
      // matches the "> dep" id + src dir).
      include: [
        'kestrel > @internationalized/date',
        'kestrel > @tiptap/extension-highlight',
        'kestrel > @tiptap/extension-subscript',
        'kestrel > @tiptap/extension-superscript',
        'kestrel > @tiptap/extension-text-align',
        'kestrel > @tiptap/starter-kit',
        'kestrel > @tiptap/vue-3',
        'kestrel > reka-ui',
      ],
    },
  },
})
