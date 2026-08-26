import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { addComponentsDir, addTemplate, addTypeTemplate, createResolver, defineNuxtModule } from '@nuxt/kit'
import { collectBlockSfcs, collectDefinitions, collectManifestFiles, renderPackageConcatRegistry, renderPackageMergedRegistry, renderRegistry, resolvePackageEntry } from './scan'
import { renderBlockRegistry } from './extract-block'
import { offerableLayouts, renderLayoutRegistry } from '../../app/utils/layouts'
import { PACKAGE_COLLECTIONS, PACKAGE_MANIFESTS, PACKAGE_SCHEMA_TABLES } from './package-registry'

export default defineNuxtModule({
  meta: { name: 'kestrel-auto-discovery' },
  setup(_options, nuxt) {
    const roots = nuxt.options._layers.map((layer) => layer.cwd)
    // The `#kestrel/*` registries are Nitro VIRTUAL modules (runtime only) — tsc can't see their shape, so
    // server code importing them would be `Cannot find module`. Register the ambient declarations into BOTH
    // the Nitro and Nuxt tsconfigs so the typecheck resolves them.
    const { resolve } = createResolver(import.meta.url)
    addTypeTemplate({ filename: 'types/kestrel-virtual.d.ts', src: resolve('./virtual.d.ts') }, { nitro: true, nuxt: true })

    // Blocks are authored as single `.vue` files under each layer's `app/blocks/` — the SFC is BOTH the
    // schema source (extracted at build into `#kestrel/blocks`) AND the display component. Register the dir
    // so `app/blocks/Hero.vue` resolves as the global `BlocksHero` that the public BlockRenderer renders.
    // No Kestrel package ships a block today, so this stays a pure consumer-dir scan (nothing to bridge).
    for (const root of roots) {
      const dir = join(root, 'app/blocks')
      if (existsSync(dir)) addComponentsDir({ path: dir, prefix: 'Blocks', global: true, pathPrefix: false })
    }

    // Layouts need no scan of our own: Nuxt already resolves `app/layouts/*.vue` across the layers with the
    // same name-first, consumer-wins dedup, and fills `app.layouts` just before `app:resolve` — which runs
    // inside `generateApp`, ahead of the templates being written, so the closure below is filled in time.
    let layoutNames: string[] = []
    nuxt.hook('app:resolve', (app) => { layoutNames = offerableLayouts(app.layouts ?? {}) })
    // `write` so the resolved list is inspectable in `.nuxt/` — a virtual-only template makes "which layouts
    // did the build actually find" unanswerable without a debugger.
    addTemplate({ filename: 'kestrel-layouts.mjs', write: true, getContents: () => renderLayoutRegistry(layoutNames) })

    nuxt.hook('nitro:config', (nitro) => {
      nitro.virtual ||= {}
      // `@michaelthielemann/kestrel-fields`'s built-in descriptors (text/richtext/number/…) seed `core`'s field-type registry
      // as a side effect of importing the package itself — core cannot import fields, so this is the one
      // place that import happens. Resolved to a real file path (`resolvePackageEntry`), not left as the
      // bare specifier: a Nitro virtual module has no real file of its own for a bundler to resolve a bare
      // import FROM, so it falls back to the project root — where, under a real consumer's pnpm install,
      // this package isn't visible (only the engine directly depends on it). Prepended so it always runs, even with zero consumer
      // field types (an empty `collectDefinitions` result would otherwise generate `export default []`,
      // importing nothing). Consumer field types register as a side effect on import too, and the schema
      // engine builds a table the moment a collection/block module loads — so the collections/blocks/
      // schema-tables/module-manifests virtuals ALL import the field-type seed FIRST (every one of them can
      // now reach a package's `buildCollection()` call transitively via `kestrelDiscovery`, per ADR-0029 —
      // an ESM barrel is an eager, whole-module-graph load — so all four need the same guard, not only the
      // two that directly build collections themselves).
      const importFieldTypesSeed = `import { fieldTypes as __kestrelSeed } from ${JSON.stringify(resolvePackageEntry('@michaelthielemann/kestrel-fields'))}\n`
        + `if (!__kestrelSeed || typeof __kestrelSeed !== 'object') throw new Error('[kestrel] built-in field types failed to seed')\n`
      // A real runtime check on the imported binding, not a bare `import "path"` or a discarded `void x`
      // — Nitro's dev build tree-shakes an import whose binding has no provable effect, silently dropping
      // the seed and breaking every collection. A `throw` Rollup can't prove unreachable survives.
      // MUST be a static `import` (not `import()`): a dynamic import runs as an ordinary statement AFTER
      // every static import of the same module has already evaluated (ESM linking order), which would run
      // it too late — after a collection's own static import has already tried to build its table. A static
      // import evaluates before any sibling static import declared after it, which is what orders this
      // correctly. Every virtual below imports `@michaelthielemann/kestrel-fields` directly for this reason (on top of, not
      // instead of, `#kestrel/field-types` for collections/blocks — chaining virtual-imports-virtual was
      // unreliable in Nitro dev, so the real package import stays even where the virtual ALSO gets imported).
      const importFieldTypesVirtual = `${importFieldTypesSeed}import { default as __kestrelFieldTypes } from '#kestrel/field-types'\n`
        + `if (!__kestrelFieldTypes) throw new Error('[kestrel] #kestrel/field-types failed to load')\n`

      nitro.virtual['#kestrel/field-types'] = () =>
        `${importFieldTypesSeed}${renderRegistry(collectDefinitions(roots, 'server/field-types'))}`

      nitro.virtual['#kestrel/collections'] = () =>
        renderPackageMergedRegistry({
          packages: PACKAGE_COLLECTIONS.map(resolvePackageEntry),
          property: 'collections',
          consumerFiles: collectDefinitions(roots, 'server/collections'),
          nameOfExpr: '(x) => x.name',
          preamble: importFieldTypesVirtual,
        })

      // Extract each `app/blocks/*.vue` into a plain BlockDef inlined as JSON (no per-file imports needed).
      // No package ships a block today (see above), so this stays the plain consumer-dir scan, prefixed
      // with the same seed a block's field-typed props may need.
      nitro.virtual['#kestrel/blocks'] = () =>
        `${importFieldTypesVirtual}${renderBlockRegistry(collectBlockSfcs(roots))}`

      // Standalone (non-collection) tables: each package's `kestrelDiscovery.schemaTables`, merged with
      // each layer's `server/schema-tables/*.ts` default export (media → folders, public → publish_deps/
      // publish_status/…; consumers can add their own). The schema engine consumes this instead of core
      // hardcoding upper-layer tables.
      nitro.virtual['#kestrel/schema-tables'] = () =>
        renderPackageMergedRegistry({
          packages: PACKAGE_SCHEMA_TABLES.map(resolvePackageEntry),
          property: 'schemaTables',
          consumerFiles: collectDefinitions(roots, 'server/schema-tables'),
          nameOfExpr: '(x) => __kestrelTableName(x)',
          extraImports: `import { getTableName as __kestrelTableName } from 'drizzle-orm'`,
          preamble: importFieldTypesVirtual,
        })

      // Per-module ownership manifests (ADR-0012): each package's `kestrelDiscovery.manifest` plus each
      // layer's `server/db/manifest.ts` default export, for the `db:migrate-module` task to enumerate
      // without core importing an upper layer (or a package) directly. No dedup — every contribution is a
      // distinct module (see `collectManifestFiles`'s own TSDoc).
      nitro.virtual['#kestrel/module-manifests'] = () =>
        renderPackageConcatRegistry({
          packages: PACKAGE_MANIFESTS.map(resolvePackageEntry),
          property: 'manifest',
          consumerFiles: collectManifestFiles(roots),
          preamble: importFieldTypesVirtual,
        })
    })
  },
})
