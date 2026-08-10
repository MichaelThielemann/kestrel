import { describe, it, expect } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { usePublicLocale, usePublicPageState } from './public-page'

// Route + config are mocked so the composable is exercised without a full page mount. The config keys are
// the `runtimeConfig.public` ones (locales/primaryLocale/prefixPrimary) the catch-all reads too — but only
// those: since @nuxt/test-utils 4 a mock also feeds Nuxt's OWN boot, and replacing the whole config starves
// the router plugin of `app.baseURL`, which then leaves `useRouter()` undefined for the rest of the file.
mockNuxtImport('useRoute', () => () => ({ path: '/de/ueber' }))
mockNuxtImport('useRuntimeConfig', original => () => {
  const config = original()
  return { ...config, public: { ...config.public, locales: ['en', 'de'], primaryLocale: 'en' } }
})

describe('usePublicLocale — content locale of the current public route (no admin dependency)', () => {
  it('derives the locale from the URL prefix scheme via the public-layer helpers', () => {
    expect(usePublicLocale().value).toBe('de')
  })
})

describe('usePublicPageState — the resolved record shared with layouts (language menu & co.)', () => {
  it('defaults to an empty {collection,page}', () => {
    expect(usePublicPageState().value).toEqual({ collection: null, page: null })
  })

  it('is a single shared state key — a write is visible through a second handle', () => {
    usePublicPageState().value = { collection: 'pages', page: { title: 'Über uns' } }
    const again = usePublicPageState()
    expect(again.value.collection).toBe('pages')
    expect(again.value.page).toEqual({ title: 'Über uns' })
  })
})
