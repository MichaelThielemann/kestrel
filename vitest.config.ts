import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import vue from '@vitejs/plugin-vue'

const require2 = createRequire(import.meta.url)

export default defineConfig({
  resolve: { alias: { h3: require2.resolve('h3') } },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['json'],
      reportsDirectory: 'reports/coverage',
      // Branch counts are the whole point: line coverage cannot separate a function that ran
      // from a function whose every path ran.
      include: ['packages/*/src/**/*.ts', 'layers/*/**/*.ts', 'extensions/*/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/node_modules/**', '**/dist/**'],
      all: false,
      // Unrelated tests (perf budgets, timing-sensitive checks) can fail under the overhead
      // coverage instrumentation adds; the artifact must still be written when that happens.
      reportOnFailure: true,
    },
    projects: [
      {
        resolve: { alias: { h3: require2.resolve('h3') } },
        test: {
          name: 'node',
          environment: 'node',
          globals: true,
          setupFiles: ['./test/setup.node.ts'],
          include: ['layers/**/*.test.ts', 'test/**/*.test.ts', 'app/**/*.test.ts', 'server/**/*.test.ts', 'extensions/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'test/e2e/**', '**/*.dom.test.ts', '**/*.nuxt.test.ts'],
        },
      },
      {
        plugins: [vue()],
        test: {
          name: 'dom',
          environment: 'happy-dom',
          globals: true,
          setupFiles: ['./test/setup.dom.ts'],
          include: ['layers/**/*.dom.test.ts', 'app/**/*.dom.test.ts', 'server/**/*.dom.test.ts', 'extensions/**/*.dom.test.ts'],
          exclude: ['**/node_modules/**'],
        },
      },
    ],
  },
})
