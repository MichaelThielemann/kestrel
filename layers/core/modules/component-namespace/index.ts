import { addComponentsDir, defineNuxtModule } from '@nuxt/kit'
import { resolve } from 'node:path'
import { KESTREL_COMPONENT_PREFIX, KESTREL_OVERRIDE_PRIORITY } from './shared'

/** Where a consumer places a component that replaces a shipped one, relative to their `srcDir`. */
export const KESTREL_OVERRIDE_DIR = 'Kestrel/components'

/**
 * RULING: the app-side layers (`admin`, `ui`, and the `app/` halves of `media`/`public`) stay LAYERS —
 * they are not bridged into packages, and there is no `addComponentsDir`/`addImportsDir`
 * module doing so. `admin` is the layer with the most at stake here: it registers by far the most
 * components under `kestrelComponents()` (`layers/admin/nuxt.config.ts`, alongside `media`/`public`/`ui`),
 * so it is the layer this override mechanism protects most. This module's own override mechanism (below)
 * is WHY: it depends on Kestrel's own components being real, Nuxt-scannable `.vue` files in a real layer,
 * resolved at a higher `addComponentsDir` priority than a consumer's override — a package's compiled
 * `dist` output cannot participate in that priority system the same way. Bridging would cost the admin its
 * per-component override story for no boot-order/discovery benefit these app-side files need (none of the
 * eager-module-load or field-type-registration hazards the *server*-side package cut existed to fix apply
 * here). Revisit only with strong evidence the cost is worth paying — see `docs/internals/layers-and-packages.md` §
 * "The component/composable bridge".
 *
 * Composables are a separate question this mechanism does NOT cover: none of `admin`/`ui`'s ~30
 * `use*`-named composables carry a `useKestrel*` prefix, and none need to — every one is internal editor
 * state/logic (`useEditForm`, `useBlockTree`, `useCollectionOps`, …). Kestrel's own layers reuse them
 * freely across the merged auto-import namespace (`media` uses `ui`'s `useT`/`useToast`/`useDragReorder`);
 * what stays true is that no extension, package, or third-party consumer imports one, and none is ever
 * documented as something a consumer reaches for — a consumer builds their own UI against collections/
 * pipelines/field types, not by importing Kestrel's editor internals. There is consequently no override
 * mechanism for composables (unlike components) and none is needed.
 */

export default defineNuxtModule({
  meta: { name: 'kestrel-component-namespace' },
  setup(_options, nuxt) {
    // The trailing `components` segment is load-bearing: Nuxt reports a missing registered directory
    // (NUXT_B3001) unless the path matches its default-components pattern, which requires that suffix.
    // Without it every consumer who never uses the seam would see a build warning.
    addComponentsDir({
      path: resolve(nuxt.options.srcDir, KESTREL_OVERRIDE_DIR),
      prefix: KESTREL_COMPONENT_PREFIX,
      priority: KESTREL_OVERRIDE_PRIORITY,
    })
  },
})
