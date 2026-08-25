import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'

const require2 = createRequire(import.meta.url)

// Narrow slice of vitest.config.ts's `node` project: only the slug engine
// files and their own tests, so Stryker's forced coverageAnalysis: 'perTest'
// stays fast.
export default defineConfig({
  resolve: {
    alias: {
      h3: require2.resolve('h3'),
      // Bare `@kestrel/core` imports inside the mutated sources must resolve to the same src/*.ts
      // module instance the tests load directly, or Stryker's coverage-per-mutant analysis sees two
      // disjoint registries and misattributes coverage.
      '@kestrel/core': fileURLToPath(new URL('./packages/kestrel-core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: [
      'packages/kestrel-core/test/app/utils/slugify.test.ts',
      'packages/kestrel-core/test/server/utils/page-slug.test.ts',
      'packages/kestrel-core/test/server/utils/page-route.test.ts',
    ],
    exclude: ['**/node_modules/**'],
    // page-slug/page-route tests build real collections through buildCollection(), which needs the
    // field-type registry seeded the same way the package's own vitest.config.ts does.
    setupFiles: ['./packages/kestrel-core/test/setup.ts'],
  },
})
