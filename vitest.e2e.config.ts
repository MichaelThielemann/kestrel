import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'

const require2 = createRequire(import.meta.url)

export default defineConfig({
  resolve: {
    alias: {
      h3: require2.resolve('h3'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
    // each suite boots its own dev server on the same rootDir; running them
    // concurrently races on the shared .nuxt build dir, so serialize the files.
    fileParallelism: false,
  },
})
