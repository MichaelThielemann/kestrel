import { kestrelComponents } from '../core/modules/component-namespace/shared'

export default defineNuxtConfig({
  components: [kestrelComponents(import.meta.url)],
  routeRules: {
    // The admin is a client-rendered SPA.
    '/admin/**': { ssr: false },
  },
  modules: [
    // The field-widget gallery (/admin/gallery) is a dev-only showcase — strip it from the
    // production admin SPA so it never ships to end users.
    (_options, nuxt) => {
      nuxt.hook('pages:extend', (pages) => {
        if (nuxt.options.dev) return
        const i = pages.findIndex((p) => p.file?.endsWith('/admin/gallery.vue'))
        if (i !== -1) pages.splice(i, 1)
      })
    },
  ],
})
