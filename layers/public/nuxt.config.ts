import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  modules: [
    fileURLToPath(new URL('./modules/prerender-routes/index.ts', import.meta.url)),
    fileURLToPath(new URL('./modules/prune-media/index.ts', import.meta.url)),
    // AFTER prune-media so the bake is pruned before it ships. Self-gates to output.driver:'s3' + a real
    // `nuxt generate`; a no-op otherwise. Without it, output.driver:'s3' + output.auto:false shipped nothing.
    fileURLToPath(new URL('./modules/deploy-output/index.ts', import.meta.url)),
  ],
})
