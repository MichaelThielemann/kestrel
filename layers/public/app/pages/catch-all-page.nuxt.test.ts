import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { defineEventHandler, createError } from 'h3'
import Page from './[...slug].vue'
import { usePublicPageState } from '../composables/public-page'

// The catch-all resolves via /api/route; return a record + its collection so we can assert the page mirrors
// BOTH into the shared state (the whole point of keeping `collection`).
const route = { collection: 'pages', page: { title: 'About', status: 'published', content: [], layout: 'marketing' } }
const h = vi.hoisted(() => ({
  path: '/about', resolveStatus: 200, resolveNull: false, query: {} as Record<string, string>, token: false,
  seo: {} as Record<string, unknown>, ancestors: [] as Array<{ path: string; title?: string }>,
}))
registerEndpoint('/api/route', defineEventHandler(() => {
  if (h.resolveStatus !== 200) throw createError({ statusCode: h.resolveStatus })
  return h.resolveNull
    ? { collection: null, page: null }
    : { ...route, page: { ...route.page, seo: h.seo }, ancestors: h.ancestors }
}))

// `meta` must be present: the page renders its own <NuxtLayout>, which reads route.meta.layoutTransition.
mockNuxtImport('useRoute', () => () => ({ path: h.path, query: h.query, meta: {} }))

// The ticket half of the preview: `?kestrel-preview-token=` fetches the editor's unsaved state and renders
// THAT instead of the stored record — no save, no publish (ADR-0008).
const ticket = { payload: { collection: 'pages', id: 1, values: { title: 'Unsaved title', content: [], layout: 'plain' } } }
registerEndpoint('/api/preview', defineEventHandler(() => (h.token ? ticket : null)))
registerEndpoint('/api/session', defineEventHandler(() => ({ authenticated: true })))

beforeEach(() => {
  h.path = '/about'
  h.resolveStatus = 200
  h.resolveNull = false
  h.query = {}
  h.token = false
  h.seo = {}
  h.ancestors = []
  usePublicPageState().value = { collection: null, page: null }
})

// Every case in this file mounts the same page into one shared `document.head`, and unhead only drops a
// tag when the entry's component scope is disposed — a leaked mount would leave its JSON-LD behind for
// the next case to read as its own.
enableAutoUnmount(afterEach)

const settle = async (): Promise<void> => { await flushPromises(); await new Promise((r) => setTimeout(r, 0)) }

/** Mount the page and read back the JSON-LD unhead flushed into the document, or null when it emitted none. */
async function mountJsonLd(): Promise<Record<string, unknown> | null> {
  await settle() // let the previous case's auto-unmount reach the DOM before this one writes to it
  await mountSuspended(Page)
  await settle()
  const el = document.head.querySelector('script[type="application/ld+json"]')
  return el?.textContent ? JSON.parse(el.textContent) as Record<string, unknown> : null
}
const nodeOf = (ld: Record<string, unknown> | null, type: string) =>
  ((ld?.['@graph'] ?? []) as Array<Record<string, unknown>>).find((n) => n['@type'] === type)

describe('catch-all page — mirrors the resolved record + collection into usePublicPageState', () => {
  it('populates the shared state with { collection, page } after resolving', async () => {
    await mountSuspended(Page)
    await flushPromises()
    const state = usePublicPageState().value
    expect(state.collection).toBe('pages')
    expect(state.page).toMatchObject({ title: 'About' })
  })
})

describe('catch-all page — JSON-LD', () => {
  it('emits a WebPage node for the resolved record', async () => {
    const ld = await mountJsonLd()
    expect(ld).toMatchObject({ '@context': 'https://schema.org' })
    expect(nodeOf(ld, 'WebPage')).toMatchObject({ url: 'http://localhost:3000/about', name: 'About' })
  })

  it('emits a BreadcrumbList from the ancestors the resolver returned', async () => {
    h.ancestors = [{ path: '/', title: 'Home' }]
    expect(nodeOf(await mountJsonLd(), 'BreadcrumbList')?.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'http://localhost:3000/' },
      { '@type': 'ListItem', position: 2, name: 'About', item: 'http://localhost:3000/about' },
    ])
  })

  it('emits none for a noindex page — the tag exists to be indexed', async () => {
    h.seo = { noindex: true }
    expect(await mountJsonLd()).toBeNull()
  })

  it('withholds stored article metadata while seo.articleMeta is off (the default)', async () => {
    h.seo = { author: 'Ada Lovelace', publishedDate: '2026-01-15', keywords: 'a, b' }
    const ld = await mountJsonLd()
    expect(nodeOf(ld, 'Article')).toBeUndefined()
    expect(JSON.stringify(ld)).not.toContain('Ada Lovelace')
  })

  it('publishes article metadata as an Article node once seo.articleMeta is on', async () => {
    const rc = useRuntimeConfig().public as Record<string, unknown>
    rc.seoArticleMeta = true
    try {
      h.seo = { author: 'Ada Lovelace', publishedDate: '2026-01-15', keywords: 'a, b' }
      expect(nodeOf(await mountJsonLd(), 'Article')).toMatchObject({
        author: { '@type': 'Person', name: 'Ada Lovelace' },
        datePublished: '2026-01-15',
        keywords: 'a, b',
      })
    } finally { rc.seoArticleMeta = false }
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

// The site root renders an empty document before a home page exists, which is a 200 with a body — so the
// publisher treats it as a successful render and bakes it. That is only correct when the resolver actually
// looked: an unreadable collection must surface as an error, or the blank document overwrites the live root.
describe('catch-all page — an incomplete resolve is not an empty site', () => {
  it('propagates the resolver failure at the site root instead of rendering the empty document', async () => {
    h.path = '/'
    h.resolveStatus = 503
    await expect(mountSuspended(Page)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('still renders the empty document at the root when the resolver simply found nothing', async () => {
    h.path = '/'
    const wrapper = await mountSuspended(Page)
    await flushPromises()
    expect(wrapper.findComponent({ name: 'NuxtLayout' }).exists()).toBe(true)
  })
})

describe('catch-all page — previewing unsaved editor changes from a ticket', () => {
  beforeEach(() => {
    h.query = { 'kestrel-preview-token': 'pv_test' }
    h.token = true
  })

  it('renders the ticket payload over the saved record', async () => {
    const wrapper = await mountSuspended(Page)
    await flushPromises()
    expect(usePublicPageState().value.page).toMatchObject({ title: 'Unsaved title' })
    expect(wrapper.findComponent({ name: 'NuxtLayout' }).props('name')).toBe('plain')
  })

  it('marks the preview so nobody mistakes it for the live page', async () => {
    const wrapper = await mountSuspended(Page)
    await flushPromises()
    expect(wrapper.text()).toContain('Preview')
  })

  it('falls back to the saved record when the ticket is gone (expired, foreign, already swept)', async () => {
    h.query = { 'kestrel-preview-token': 'pv_expired' } // its own key: a ticket is fetched per token
    h.token = false
    const wrapper = await mountSuspended(Page)
    await flushPromises()
    expect(usePublicPageState().value.page).toMatchObject({ title: 'About' })
    expect(wrapper.findComponent({ name: 'NuxtLayout' }).props('name')).toBe('marketing')
  })

  it('renders a page whose path does not exist yet instead of 404ing (an unsaved slug)', async () => {
    h.path = '/not-saved-yet'
    h.resolveNull = true
    const wrapper = await mountSuspended(Page)
    await flushPromises()
    expect(usePublicPageState().value.page).toMatchObject({ title: 'Unsaved title' })
    expect(wrapper.findComponent({ name: 'NuxtLayout' }).exists()).toBe(true)
  })
})
