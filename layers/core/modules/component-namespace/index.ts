import { addComponentsDir, defineNuxtModule } from '@nuxt/kit'
import { resolve } from 'node:path'
import { KESTREL_COMPONENT_PREFIX, KESTREL_OVERRIDE_PRIORITY } from './shared'

/** Where a consumer places a component that replaces a shipped one, relative to their `srcDir`. */
export const KESTREL_OVERRIDE_DIR = 'Kestrel/components'

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
