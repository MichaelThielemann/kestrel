import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import vue from '@vitejs/plugin-vue'

const require2 = createRequire(import.meta.url)

export default defineConfig({
  resolve: { alias: { h3: require2.resolve('h3') } },
  test: {
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
