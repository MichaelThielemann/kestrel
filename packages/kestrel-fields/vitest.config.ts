import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Same dual-module-instance fix as @kestrel/core's own vitest.config.ts: a bare `from '@kestrel/fields'`
    // (this package's own test fixtures, and not-yet-moved layer code these tests exercise) resolves through
    // node_modules to `dist/` — a separate module instance from the `src/*.ts` files Vitest loads directly
    // for relative imports. Alias the bare specifier to the real source so every import shares one instance.
    alias: {
      '@kestrel/fields/client': fileURLToPath(new URL('./src/client.ts', import.meta.url)),
      '@kestrel/fields': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
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
