import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Without this, a bare `from '@kestrel/core'` (used both by this package's own test fixtures and by
    // not-yet-moved layer code these tests exercise, e.g. `access/utils/pipeline-run.ts`,
    // `core/server/api/[...path].ts`) resolves through node_modules to `dist/` — a SEPARATE module
    // instance from the `src/*.ts` files Vitest loads directly for relative imports. Two instances mean
    // two copies of every stateful registry (field types, pipelines, collections, the config provider):
    // a test seeding one instance is invisible to code reading the other. Alias the bare specifier to the
    // real source so every import — however it's spelled — shares the same one.
    alias: {
      '@kestrel/core/client': fileURLToPath(new URL('./src/client.ts', import.meta.url)),
      '@kestrel/core': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    typecheck: {
      include: ['test/**/*.ts'],
      tsconfig: './tsconfig.typecheck.json',
    },
  },
})
