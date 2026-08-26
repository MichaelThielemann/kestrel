import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Same dual-module-instance fix as every other package's own vitest.config.ts: a bare `from
    // '@michaelthielemann/kestrel-delivery-static'` resolves through node_modules to `dist/` — a separate module instance from
    // the `src/*.ts` files Vitest loads directly for relative imports. Alias the bare specifier to the
    // real source so every import shares one instance.
    alias: {
      '@michaelthielemann/kestrel-delivery-static': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
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
