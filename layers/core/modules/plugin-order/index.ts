import { defineNuxtModule } from '@nuxt/kit'
import { assertEffectiveOrderMatches, resolvePluginOrder, validatePluginOrder } from './plugin-order'

/**
 * Owns the execution order of the plugins Kestrel's own 6 layers ship (core/fields/media/auth/
 * collections/public — see `plugin-order.ts`'s `PLUGIN_ORDER`), replacing Nitro's layer-then-filename
 * sort with an explicit, declared list. A consumer's own plugins (and any extension layer's) are
 * untouched — they keep using Nitro's default scan-and-append, landing wherever their own layer position
 * in `extends` naturally puts them; this module only orders Kestrel's own.
 *
 * Mechanism: the `nitro:config` hook's config object (which becomes `nitro.options` once Nitro's own
 * instance is built) gets `.plugins` pushed with `PLUGIN_ORDER`'s resolved absolute paths, in order — this
 * hook runs BEFORE Nitro's own `scanPlugins` step. That step only appends a scanned file when it is not
 * ALREADY in `nitro.options.plugins`
 * (`nitropack/dist/core/index.mjs`: `if (!nitro.options.plugins.includes(plugin)) plugins.push(plugin)`),
 * so every one of our explicitly-pushed paths is skipped by the scan (already present, same absolute path)
 * and keeps our declared position — nothing needs renaming or moving on disk. `nitro:config` alone only
 * proves what WE push, though — a separate `nitro:init` hook (which fires after every `nitro:config` hook
 * and Nitro's own scan-and-append have both already run, against the fully-built Nitro instance) asserts
 * the REAL, final `nitro.options.plugins` still starts with our declared order, contiguous and duplicate-
 * free — see `assertEffectiveOrderMatches`'s own TSDoc for why this observer, not the push alone, is what
 * actually proves "declared order ≡ effective order".
 *
 * The ADR-0029 eager-barrel-load guard for a future `00.*` plugin: NOT a mechanism in this module. It
 * doesn't need to be — `@kestrel/media`/`@kestrel/collections`/`@kestrel/publishing`'s own barrels now
 * self-guard (a used-binding `@kestrel/fields` import, first), so importing ANY of them is safe from ANY
 * plugin position, including a hypothetical new `00.*` file. The computed rail proving this
 * (`test/architecture/kestrel-discovery.test.ts`'s "every package whose OWN module graph reaches
 * buildCollection()...") already re-checks every package on every test run, so a FUTURE package that
 * starts calling `buildCollection()` without the guard fails there — independent of whatever plugin order
 * this module declares. Plugin order literally cannot reintroduce this hazard class any more, which is the
 * honest, verifiable version of "prevents a future 00.* plugin from eagerly loading a heavy barrel
 * pre-seed": the guard lives at the package boundary, not the boot-order boundary.
 */
/** The minimal shape this module needs from `nuxt` — narrowed so a test can pass a plain mock object
 *  instead of a real Nuxt instance (mirrors testing `defineNuxtModule`'s callback logic directly, not
 *  through Nuxt's own module-loading machinery). */
export interface MinimalNuxt {
  options: { _layers: readonly { cwd: string }[] }
  hook: {
    (name: 'nitro:config', fn: (nitro: { plugins?: (string | undefined)[] }) => void): void
    (name: 'nitro:init', fn: (nitro: { options: { plugins: (string | undefined)[] } }) => void): void
  }
}

/** The module's actual logic, exported separately from `defineNuxtModule`'s wrapper so a test can call it
 *  against a plain mock `nuxt`/`nitro` pair and assert `nitro.plugins` ends up EXACTLY
 *  `resolvePluginOrder(roots)`, in order — the "declared order ≡ effective order" proof, at unit speed,
 *  independent of the real-boot proof (a real `nuxt build`, inspected directly). */
export function setupPluginOrder(nuxt: MinimalNuxt): void {
  const roots = nuxt.options._layers.map((layer) => layer.cwd)
  validatePluginOrder(roots) // throws — fails the build loudly on any drift, before Nitro ever scans

  nuxt.hook('nitro:config', (nitro) => {
    nitro.plugins ||= []
    nitro.plugins.push(...resolvePluginOrder(roots))
  })

  nuxt.hook('nitro:init', (nitro) => {
    assertEffectiveOrderMatches(nitro.options.plugins, resolvePluginOrder(roots))
  })
}

export default defineNuxtModule({
  meta: { name: 'kestrel-plugin-order' },
  setup(_options, nuxt) {
    setupPluginOrder(nuxt)
  },
})
