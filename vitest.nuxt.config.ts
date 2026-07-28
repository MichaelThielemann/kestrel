import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    environment: 'nuxt',
    globals: true,
    include: ['layers/**/*.nuxt.test.ts', 'test/**/*.nuxt.test.ts', 'app/**/*.nuxt.test.ts', 'server/**/*.nuxt.test.ts', 'extensions/**/*.nuxt.test.ts'],
  },
})
