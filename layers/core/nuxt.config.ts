import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  modules: [
    fileURLToPath(new URL('./modules/component-namespace/index.ts', import.meta.url)),
    fileURLToPath(new URL('./modules/auto-discovery/index.ts', import.meta.url)),
    fileURLToPath(new URL('./modules/kestrel/index.ts', import.meta.url)),
    fileURLToPath(new URL('./modules/plugin-order/index.ts', import.meta.url)),
  ],
})
