import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'

const require2 = createRequire(import.meta.url)

// Narrow slice of vitest.config.ts's `node` project: only the access-decide
// module and its own tests, so Stryker's forced coverageAnalysis: 'perTest'
// stays fast.
export default defineConfig({
  resolve: { alias: { h3: require2.resolve('h3') } },
  test: {
    environment: 'node',
    globals: true,
    include: ['packages/kestrel-access/test/server/utils/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    setupFiles: ['./packages/kestrel-access/test/setup.ts'],
  },
})
