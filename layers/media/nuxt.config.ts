import { kestrelComponents } from '../core/modules/component-namespace/shared'

// Marks `media` as a Nuxt layer (so its components/server code are auto-registered). The media config
// + the `kestrel` module that resolves it now live in the core layer (single non-auth config source).
export default defineNuxtConfig({
  components: [kestrelComponents(import.meta.url)],
})
