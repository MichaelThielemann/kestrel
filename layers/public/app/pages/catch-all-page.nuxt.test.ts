import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import Page from './[...slug].vue'
import { usePublicPageState } from '../composables/public-page'

// The catch-all resolves via /api/route; return a record + its collection so we can assert the page mirrors
// BOTH into the shared state (the whole point of keeping `collection`).
registerEndpoint('/api/route', () => ({ collection: 'pages', page: { title: 'About', status: 'published', content: [] } }))

const h = vi.hoisted(() => ({ path: '/about' }))
mockNuxtImport('useRoute', () => () => ({ path: h.path, query: {} }))

beforeEach(() => {
  h.path = '/about'
  usePublicPageState().value = { collection: null, page: null }
})

describe('catch-all page — mirrors the resolved record + collection into usePublicPageState', () => {
  it('populates the shared state with { collection, page } after resolving', async () => {
    await mountSuspended(Page)
    await flushPromises()
    const state = usePublicPageState().value
    expect(state.collection).toBe('pages')
    expect(state.page).toMatchObject({ title: 'About' })
  })
})
