import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { addComponentsDir, addTemplate, addTypeTemplate, createResolver, defineNuxtModule } from '@nuxt/kit'
import { collectBlockSfcs, collectDefinitions, renderRegistry } from './scan'
import { renderBlockRegistry } from './extract-block'
import { offerableLayouts, renderLayoutRegistry } from '../../app/utils/layouts'

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
      // Consumer field types register as a side effect on import, and the schema engine builds a table the
      // moment a collection/block module loads. So the collections + blocks registries import the field-type
      // registry FIRST — guaranteeing custom types are registered before any column / validator is built.
      nitro.virtual['#kestrel/field-types'] = () =>
        renderRegistry(collectDefinitions(roots, 'server/field-types'))
      nitro.virtual['#kestrel/collections'] = () =>
        `import '#kestrel/field-types'\n` + renderRegistry(collectDefinitions(roots, 'server/collections'))
      // Extract each `app/blocks/*.vue` into a plain BlockDef inlined as JSON (no per-file imports needed).
      nitro.virtual['#kestrel/blocks'] = () =>
        `import '#kestrel/field-types'\n` + renderBlockRegistry(collectBlockSfcs(roots))
      // Standalone (non-collection) tables: each layer's `server/schema-tables/*.ts` default-exports one
      // drizzle table (media → folders, public → publish_deps/publish_status; consumers can add their own).
      // The schema engine consumes this instead of core hardcoding upper-layer tables.
      nitro.virtual['#kestrel/schema-tables'] = () =>
        renderRegistry(collectDefinitions(roots, 'server/schema-tables'))
    })
  },
})
