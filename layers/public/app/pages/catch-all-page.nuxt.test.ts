import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import Page from './[...slug].vue'
import { usePublicPageState } from '../composables/public-page'

// The catch-all resolves via /api/route; return a record + its collection so we can assert the page mirrors
// BOTH into the shared state (the whole point of keeping `collection`).
const route = { collection: 'pages', page: { title: 'About', status: 'published', content: [], layout: 'marketing' } }
registerEndpoint('/api/route', () => route)

// `meta` must be present: the page renders its own <NuxtLayout>, which reads route.meta.layoutTransition.
const h = vi.hoisted(() => ({ path: '/about' }))
mockNuxtImport('useRoute', () => () => ({ path: h.path, query: {}, meta: {} }))

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

// The page owns its layout so an editor's per-record choice can take effect. That the `layout: false` page
// meta stops the route-meta layout from ALSO wrapping it is only observable in real output — the e2e
// generate asserts it. Here: that the page renders the layout itself, bound to the record's value.
describe('catch-all page — per-record layout', () => {
  it('renders its own NuxtLayout, named from the record, with a fallback', async () => {
    const wrapper = await mountSuspended(Page)
    await flushPromises()
    const layout = wrapper.findComponent({ name: 'NuxtLayout' })
    expect(layout.exists()).toBe(true)
    expect(layout.props('name')).toBe('marketing')
    expect(layout.props('fallback')).toBe('default')
  })
})
